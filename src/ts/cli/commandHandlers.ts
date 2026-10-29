/**
 * The CLI command handlers behind the command rows (commandRows.ts). Handlers that print their
 * command's usage read the text back through `usageOf`, so the row stays the one home for it. That
 * import is part of a module cycle — the rows need these handlers at init — and is safe because this
 * module reads `usageOf` only inside handler bodies, never at module scope.
 */
import { boostChallenge, fillChallenge, submitPickedCmd, swapBackCmd, turboChallenge } from './commands/actions';
import { challengesCmd } from './commands/challenges';
import { deadlinesCmd } from './commands/deadlines';
import { pinCmd, PIN_USAGE } from './commands/pin';
import { forgetPaymentCmd, joinChallengeCmd } from './commands/join';
import {
    listPhotosCmd,
    parseSearchFlag,
    parseSortFlag,
    suggestPhotosCmd,
    STATS_DEFAULT_LIMIT,
} from './commands/photos';
import { isPinnableImageId } from '../settings';
import { getSetting, listProfiles, resetSetting, setGlobalDefault, setSetting } from './commands/settings';
import { showLogs } from './commands/logs';
import * as scenarioCommands from './commands/scenarios';
import { parseChallengeFlag, runVotingCycle, voteChallengeManual } from './commands/voting';
import { requireChallenge } from './guards';
import { challengeCommand, exitCodeOf, extractChallenge, usageError } from './commandKit';

import type { CommandHandler } from './commandKit';
import { usageOf } from './commandRows';

// --challenge scopes to a single-challenge manual vote; bare `vote` votes
// every challenge to 100%. A present-but-empty --challenge is rejected rather
// than silently voting everything.
const runVote: CommandHandler = async (argv) => {
    const challengeId = parseChallengeFlag(argv);
    const hasChallengeFlag = argv.some((a) => a === '--challenge' || a.startsWith('--challenge='));
    if (hasChallengeFlag && challengeId == null) {
        return usageError('Please specify a challenge id with --challenge', usageOf('vote'));
    }
    if (challengeId != null) {
        await voteChallengeManual(challengeId);
    } else {
        await runVotingCycle(1, { isManual: true });
    }
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

const LOG_CATEGORY_FLAGS: Record<string, string> = {
    '--error': 'error',
    '--api': 'api',
    '--settings': 'settings',
    '--lexicon': 'lexicon',
};

const runLogs: CommandHandler = async (argv) => {
    const category = LOG_CATEGORY_FLAGS[argv.find((arg) => Object.hasOwn(LOG_CATEGORY_FLAGS, arg)) ?? ''] || 'app';
    const linesArg = argv.find((a) => a.startsWith('--lines='));
    const lines = linesArg ? parseInt(linesArg.slice('--lines='.length), 10) || 100 : 100;
    showLogs({ category, lines });
    return 0;
};

const runRun: CommandHandler = async (argv) => {
    await runVotingCycle(1, { isManual: false, challengeId: parseChallengeFlag(argv) });
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

const runListPhotos: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    const usage = usageOf('list-photos');
    const suggestFlags = rest.filter((arg) => arg === '--suggest');
    const statsFlags = rest.filter((arg) => arg === '--stats');
    const limitArgs = rest.filter((arg) => arg.startsWith('--limit='));
    const listRest = rest.filter((arg) => arg !== '--suggest' && arg !== '--stats' && !arg.startsWith('--limit='));
    const search = parseSearchFlag(listRest);
    const sort = parseSortFlag(listRest);
    // Anything that is neither a --search/--sort flag nor its value is a typo.
    const unexpected = listRest.filter(
        (arg, i) =>
            arg !== '--search' &&
            !arg.startsWith('--search=') &&
            arg !== '--sort' &&
            !arg.startsWith('--sort=') &&
            listRest[i - 1] !== '--search' &&
            listRest[i - 1] !== '--sort',
    );
    const limitText = limitArgs[0]?.slice('--limit='.length);
    const limit = limitText !== undefined && /^\d+$/.test(limitText) ? Number(limitText) : null;
    // A --sort with no value of its own (nothing after it, or another flag) names
    // what it is missing, not just "wrong arguments".
    if (listRest.some((arg) => arg === '--sort') && sort === null) {
        return usageError('--sort needs one of votes|newest|oldest', usage);
    }
    if (
        suggestFlags.length > 1 ||
        statsFlags.length > 1 ||
        limitArgs.length > 1 ||
        unexpected.length > 0 ||
        (listRest.some((arg) => arg === '--search') && search === null)
    ) {
        return usageError('Wrong arguments', usage);
    }
    if (limitText !== undefined && (limit === null || limit < 1)) {
        return usageError('--limit needs a positive whole number of photos to read stats for', usage);
    }
    if (statsFlags.length > 0 && suggestFlags.length > 0) {
        return usageError('--stats cannot be combined with --suggest', usage);
    }
    if (limitArgs.length > 0 && statsFlags.length === 0) {
        return usageError('--limit only goes with --stats', usage);
    }
    if (suggestFlags.length > 0) {
        // The suggestions rank for one challenge and are not a search.
        if (challengeId === null || listRest.length > 0) {
            return usageError('Wrong arguments', usage);
        }
        return suggestPhotosCmd(challengeId);
    }
    return listPhotosCmd(challengeId, search, sort, statsFlags.length > 0 ? (limit ?? STATS_DEFAULT_LIMIT) : null);
};

const runBoost = async (challengeId: string, rest: string[]) => {
    const imageArg = rest.find((a) => a.startsWith('--image='));
    const imageId = imageArg ? imageArg.slice('--image='.length) || null : null;
    await boostChallenge(challengeId, { imageId });
    return 0;
};

// Like `join`: it names which photo a won Turbo lands on, so a flag it does not recognise (`--images=`,
// a space-form `--image`, a repeat) is a usage error, never a silent auto-play. Exits 1 when the Turbo
// was not earned or applied.
const runTurbo: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    const usage = usageOf('turbo');
    requireChallenge({ challengeId }, usage);
    const imageArgs = rest.filter((a) => a.startsWith('--image='));
    if (rest.some((a) => !a.startsWith('--image=')) || imageArgs.length > 1) {
        return usageError('Wrong arguments', usage);
    }
    const imageId = imageArgs[0]?.slice('--image='.length) ?? null;
    if (imageId === '') return usageError('--image needs a photo id (challenges --challenge=<id> lists them)', usage);
    return exitCodeOf(await turboChallenge(challengeId as string, { imageId }));
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

// `submit` sends photos, so like `turbo` its arguments are strict: a typo
// (`--images=`), a space form or a repeat is a usage error, never a silent
// auto-submit. After --challenge, the rest may hold --all at most once (every
// empty slot, ranked by the auto-submit rules) or --image=<ids> at most once
// (exactly those photos, comma-separated) — never both. Exit codes: 0 sent,
// 1 failed (including an unknown id), 2 the submit got no answer (the photo(s)
// may have been submitted).
const runSubmit: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    const usage = usageOf('submit');
    requireChallenge({ challengeId }, usage);
    const allArgs = rest.filter((a) => a === '--all');
    const imageArgs = rest.filter((a) => a.startsWith('--image='));
    if (
        rest.some((a) => a !== '--all' && !a.startsWith('--image=')) ||
        allArgs.length > 1 ||
        imageArgs.length > 1 ||
        (allArgs.length > 0 && imageArgs.length > 0)
    ) {
        return usageError('Wrong arguments', usage);
    }
    if (imageArgs.length > 0) {
        const imageId = imageArgs[0].slice('--image='.length);
        if (imageId === '') {
            return usageError('--image needs a photo id (list-photos --challenge=<id> lists them)', usage);
        }
        return submitPickedCmd(challengeId as string, imageId.split(','));
    }
    return fillChallenge(challengeId as string, { all: allArgs.length > 0 });
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

// `swap-back` spends a swap, so like `join` its arguments are strict: `--to=` belongs to `swap`,
// and a typo, a space form or a repeat is a usage error, never a spend. Without --image the
// command is a read-only listing of the recorded swap-back offers.
const runSwapBack: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    const usage = usageOf('swap-back');
    requireChallenge({ challengeId }, usage);
    const imageArgs = rest.filter((a) => a.startsWith('--image='));
    const yesArgs = rest.filter((a) => a === '--yes');
    if (rest.some((a) => !a.startsWith('--image=') && a !== '--yes') || imageArgs.length > 1 || yesArgs.length > 1) {
        return usageError('Wrong arguments', usage);
    }
    const imageId = imageArgs[0]?.slice('--image='.length);
    if (imageId === '')
        return usageError('--image needs a photo id (list-photos --challenge=<id> shows the ids)', usage);
    return exitCodeOf(
        await swapBackCmd(challengeId as string, {
            ...(imageId === undefined ? {} : { imageId }),
            yes: yesArgs.length > 0,
        }),
    );
};

const runGetSetting: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    if (!rest[0]) return usageError('Please specify a setting key', usageOf('get-setting'));
    getSetting(rest[0], challengeId);
    return 0;
};

const runSetSetting: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    if (!rest[0] || rest[1] === undefined) {
        return usageError('Please specify both key and value', usageOf('set-setting'));
    }
    // A name that is no setting, or a value it refuses, is a failure: the exit code says so to a script.
    return setSetting(rest[0], rest[1], challengeId) ? 0 : 1;
};

const runResetSetting: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    if (!rest[0]) return usageError('Please specify a setting key', usageOf('reset-setting'));
    return resetSetting(rest[0], challengeId) ? 0 : 1;
};

const runSetGlobalDefault: CommandHandler = async ([key, value]) => {
    if (!key || !value) {
        return usageError(
            'Please specify both setting key and value',
            usageOf('set-global-default'),
            'Example: set-global-default exposure 80',
        );
    }
    return setGlobalDefault(key, value) ? 0 : 1;
};

const runListProfiles: CommandHandler = async (argv) => {
    const { rest } = extractChallenge(argv);
    if (rest.length > 0) return usageError(`Unexpected arguments: ${rest.join(' ')}`, usageOf('list-profiles'));
    listProfiles();
    return 0;
};

export {
    runBoost,
    runChallenges,
    runDeadlines,
    runForgetPayment,
    runGetSetting,
    runJoin,
    runListPhotos,
    runListProfiles,
    runLogs,
    runPin,
    runResetSetting,
    runRun,
    runScenarioReset,
    runSetGlobalDefault,
    runSetSetting,
    runSubmit,
    runSwapBack,
    runTurbo,
    runVote,
};
