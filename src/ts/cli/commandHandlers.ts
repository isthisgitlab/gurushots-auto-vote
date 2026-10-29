/**
 * The CLI command handlers behind the command rows (commandRows.ts): the
 * core run* handlers below, with this module re-exporting the group siblings
 * (actionHandlers.ts, settingsHandlers.ts, titleRuleHandlers.ts) so the rows
 * and the tests keep one import site. Handlers that print their command's
 * usage read the text back through `usageOf`, so the row stays the one home
 * for it. That import is part of a module cycle — the rows need these
 * handlers at init — and is safe because every handler module reads `usageOf`
 * only inside handler bodies, never at module scope.
 */
import { challengesCmd } from './commands/challenges';
import { deadlinesCmd } from './commands/deadlines';
import { pinCmd, PIN_USAGE } from './commands/pin';
import { forgetPaymentCmd, joinChallengeCmd } from './commands/join';
import { isPinnableImageId } from '../settings';
import { showLogs } from './commands/logs';
import { followLogs } from './commands/logsFollow';
import * as scenarioCommands from './commands/scenarios';
import { parseChallengeFlag, runVotingCycle, voteChallengeManual } from './commands/voting';
import { challengeCommand, exitCodeOf, repeatedChallenge, usageError } from './commandKit';
import * as logger from '../logger';
import { getMiddleware } from '../apiFactory';

import type { CommandHandler } from './commandKit';
import type { NullEventHandlers } from '../types/cli';
import type * as settings_handlersModule from '../ipc/settings.handlers';
import { usageOf } from './commandRows';

// The settings IPC handlers behind `run`'s stale-settings prune — built lazily
// on first use (the actions.ts pattern) so loading this module for `help` does
// not construct the handler set or pull in its transitive dependencies.
type SettingsHandlers = NullEventHandlers<ReturnType<typeof settings_handlersModule.buildHandlers>>;
let _settingsHandlers: SettingsHandlers | undefined;
const settingsHandlers = (): SettingsHandlers =>
    (_settingsHandlers ??= (
        require('../ipc/settings.handlers') as typeof import('../ipc/settings.handlers')
    ).buildHandlers());

/**
 * Prunes the per-challenge settings of challenges that are gone, off `run`'s
 * own list read after its cycle — the renderer does the same off its own list
 * read (useActiveChallenges), never off the voting pass. The handler holds the
 * mock-mode gate and the id validation, so it is called, never bypassed. The
 * gates mirror the renderer's: the active ids only, an empty list or a
 * prune-unsafe read prunes nothing (absence from such a list is not "gone"),
 * and a failed read prunes nothing (best effort — one debug line at most).
 * `start` never prunes, the same rule the renderer follows while autovote runs.
 */
const pruneStaleChallengeSettings = async (): Promise<void> => {
    try {
        const resp = await getMiddleware().getActiveChallenges();
        if (!resp || resp.fetchFailed) {
            logger
                .withCategory('settings')
                .debug('Skipped stale-settings cleanup: the active challenges could not be read');
            return;
        }
        if (resp.challenges.length === 0 || resp.pruneUnsafe === true) return;
        await settingsHandlers()['cleanup-stale-challenge-setting'](
            null,
            resp.challenges.map((challenge) => challenge.id.toString()),
        );
    } catch (error) {
        logger
            .withCategory('settings')
            .debug('Skipped stale-settings cleanup: the active challenges could not be read', error);
    }
};

// --challenge scopes to a single-challenge manual vote; bare `vote` votes
// every challenge to 100%. A repeated --challenge would vote the first id
// while the user named two, and a present-but-empty one is rejected rather
// than silently voting everything.
const runVote: CommandHandler = async (argv) => {
    if (repeatedChallenge(argv)) return usageError('Wrong arguments', usageOf('vote'));
    const challengeId = parseChallengeFlag(argv);
    const hasChallengeFlag = argv.some((a) => a === '--challenge' || a.startsWith('--challenge='));
    if (hasChallengeFlag && challengeId == null) {
        return usageError('Please specify a challenge id with --challenge', usageOf('vote'));
    }
    if (challengeId != null) {
        // The single-challenge vote is a script surface: its exit code says
        // whether the vote ran. A failed fetch, an unknown id, an unreadable
        // challenge and the handler's null answer all read as success:false,
        // never as a clean exit.
        const result = await voteChallengeManual(challengeId);
        return result?.success === true ? 0 : 1;
    }
    await runVotingCycle(1, { isManual: true });
    return 0;
};

// One challenge's progress, or (--all, alone) every challenge's: the only way past an unreadable progress file.
const runScenarioReset: CommandHandler = async (argv) => {
    if (!argv.includes('--all')) {
        return challengeCommand(usageOf('scenario-reset'), (id) => scenarioCommands.scenarioResetCmd(id))(argv);
    }
    return argv.length === 1
        ? scenarioCommands.scenarioResetAllCmd()
        : usageError('--all takes no other arguments', usageOf('scenario-reset'));
};

// category flag → log category. No --app flag: no flag at all means the app log.
const LOG_CATEGORY_FLAGS: Record<string, 'app' | 'error' | 'api' | 'settings' | 'lexicon'> = {
    '--error': 'error',
    '--api': 'api',
    '--settings': 'settings',
    '--lexicon': 'lexicon',
};

// Strict like the actions, though read-only: a mistyped flag (`--lines 20`,
// `--linesx=5`) must not quietly read as the plain listing, and a repeated
// flag must not quietly take the last value.
const runLogs: CommandHandler = async (argv) => {
    const usage = usageOf('logs');
    const categoryFlags = argv.filter((a) => Object.hasOwn(LOG_CATEGORY_FLAGS, a));
    const followFlags = argv.filter((a) => a === '--follow');
    const linesFlags = argv.filter((a) => a.startsWith('--lines='));
    const unknown = argv.filter(
        (a) => !Object.hasOwn(LOG_CATEGORY_FLAGS, a) && a !== '--follow' && !a.startsWith('--lines='),
    );
    if (unknown.length > 0 || categoryFlags.length > 1 || followFlags.length > 1 || linesFlags.length > 1) {
        return usageError('Wrong arguments', usage);
    }
    const linesText = linesFlags[0]?.slice('--lines='.length);
    const lines = linesText !== undefined && /^\d+$/.test(linesText) ? Number(linesText) : null;
    if (linesText !== undefined && (lines === null || lines < 1)) {
        return usageError('--lines needs a positive whole number of lines', usage);
    }
    const linesOpt = { lines: lines ?? 100 };
    const categoryFlag = categoryFlags[0];
    const category: 'app' | 'error' | 'api' | 'settings' | 'lexicon' =
        categoryFlag === undefined ? 'app' : LOG_CATEGORY_FLAGS[categoryFlag];
    if (followFlags.length > 0) {
        if (category === 'lexicon') {
            return usageError('--follow tails a log file; the lexicon report is not a file', usage);
        }
        return followLogs({ category, ...linesOpt });
    }
    showLogs({ category, ...linesOpt });
    return 0;
};

const runRun: CommandHandler = async (argv) => {
    // A repeated --challenge would scope the cycle to the first id while the
    // user named two — refuse before anything runs, like `vote`.
    if (repeatedChallenge(argv)) return usageError('Wrong arguments', usageOf('run'));
    await runVotingCycle(1, { isManual: false, challengeId: parseChallengeFlag(argv) });
    await pruneStaleChallengeSettings();
    return 0;
};

// `join` spends coins, so its arguments are strict: a cap that is misspelled, written with a space
// or repeated would otherwise be dropped, and the join would go ahead uncapped (or on the wrong id).
const runJoin: CommandHandler = async (argv) => {
    const flags = argv.filter((a) => a.startsWith('--'));
    const positional = argv.filter((a) => !a.startsWith('--'));
    const caps = flags.filter((a) => a.startsWith('--max-coins='));
    const maxText = caps[0]?.slice('--max-coins='.length);
    const maxCoins = maxText !== undefined && /^\d+$/.test(maxText) ? Number(maxText) : undefined;
    const wrong =
        flags.some((a) => a !== '--yes' && !a.startsWith('--max-coins=')) ||
        flags.filter((a) => a === '--yes').length > 1 ||
        caps.length > 1 ||
        (maxText !== undefined && !Number.isSafeInteger(maxCoins)) ||
        positional.length > 1;
    if (wrong) return usageError('Wrong arguments', usageOf('join'));
    return joinChallengeCmd(positional[0], {
        yes: flags.includes('--yes'),
        ...(maxCoins === undefined ? {} : { maxCoins }),
    });
};

// Strict like `join`: it changes what a later join pays for, so a typo must not reach another challenge.
const runForgetPayment: CommandHandler = async (argv) => {
    // Only a plain challenge id: the claims are keyed `<member id>:<challenge id>`, and a colon in the id must not
    // reach another record.
    if (argv.length !== 1 || !/^\d+$/.test(argv[0])) return usageError('Wrong arguments', usageOf('forget-payment'));
    return forgetPaymentCmd(argv[0]);
};

// A read-only command, but strict like the actions: `--challenge 123` (space form), a repeat or any
// other flag must not quietly read as the plain listing.
const runChallenges: CommandHandler = async (argv) => {
    const detailArgs = argv.filter((a) => a.startsWith('--challenge='));
    if (argv.length !== detailArgs.length || detailArgs.length > 1 || detailArgs[0] === '--challenge=') {
        return usageError('Wrong arguments', usageOf('challenges'));
    }
    return exitCodeOf(await challengesCmd(detailArgs[0]?.slice('--challenge='.length) ?? null));
};

// --boost= / --turbo= take an image id, or `none` to clear, each at most once. It changes what a later Boost or Turbo
// lands on, so like `join` anything it does not recognise (`--boost abc`, a typo) is a usage error, never a listing.
const runPin = async (challengeId: string, rest: string[]) => {
    const flagsOf = (kind: string) => rest.filter((a) => a.startsWith(`--${kind}=`));
    if (
        rest.some((a) => !a.startsWith('--boost=') && !a.startsWith('--turbo=')) ||
        flagsOf('boost').length > 1 ||
        flagsOf('turbo').length > 1
    ) {
        return usageError('Wrong arguments', PIN_USAGE);
    }
    const pins: Parameters<typeof pinCmd>[1] = {};
    for (const kind of ['boost', 'turbo'] as const) {
        const [arg] = flagsOf(kind);
        if (arg === undefined) continue;
        const value = arg.slice(`--${kind}=`.length);
        if (value === '') return usageError(`--${kind} needs an image id, or none to clear the pin`, PIN_USAGE);
        // The raw text never reaches a log line unless it is a plain image id.
        if (value.toLowerCase() !== 'none' && !isPinnableImageId(value)) {
            return usageError(
                `--${kind} takes an image id: letters, digits, _ and -, at most 64 characters (or none to clear the pin)`,
                PIN_USAGE,
            );
        }
        pins[kind] = value.toLowerCase() === 'none' ? null : value;
    }
    if (pins.boost && pins.boost === pins.turbo) {
        return usageError('--boost and --turbo name the same image: a photo is pinned for one feature only', PIN_USAGE);
    }
    return exitCodeOf(await pinCmd(challengeId, pins));
};

// A read-only preview, but strict like the actions: `--challenge 123` (space form), a repeat or
// any other argument must not quietly read as a listing.
const runDeadlines: CommandHandler = async (argv) => {
    const detailArgs = argv.filter((a) => a.startsWith('--challenge='));
    if (argv.length !== detailArgs.length || detailArgs.length > 1 || detailArgs[0] === '--challenge=') {
        return usageError('Wrong arguments', usageOf('deadlines'));
    }
    const challengeId = detailArgs[0]?.slice('--challenge='.length);
    if (challengeId === undefined) {
        return usageError('Please specify a challenge id with --challenge', usageOf('deadlines'));
    }
    return exitCodeOf(await deadlinesCmd(challengeId));
};

export { runBoost, runListPhotos, runSubmit, runSwapBack, runTurbo } from './actionHandlers';
export {
    runGetSetting,
    runListProfiles,
    runResetAllGlobalDefaults,
    runResetGlobalDefault,
    runResetSetting,
    runSetGlobalDefault,
    runSetSetting,
} from './settingsHandlers';
export { runExportTitleRules, runImportTitleRules, runListTitleRules, runTitleProfile } from './titleRuleHandlers';

export {
    pruneStaleChallengeSettings,
    runChallenges,
    runDeadlines,
    runForgetPayment,
    runJoin,
    runLogs,
    runPin,
    runRun,
    runScenarioReset,
    runVote,
};
