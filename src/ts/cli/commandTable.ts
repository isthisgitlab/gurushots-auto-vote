import { handleLogin, handleLogout } from './commands/auth';
import {
    runVotingCycle,
    voteChallengeManual,
    parseChallengeFlag,
    startContinuousVoting,
    showStatus,
} from './commands/voting';
import {
    boostChallenge,
    turboChallenge,
    fillChallenge,
    unlockBoostCmd,
    swapCmd,
    parseSwapFlags,
    SWAP_USAGE,
    swapBackCmd,
    SWAP_BACK_USAGE,
    fillExposureCmd,
} from './commands/actions';
import { pinCmd, PIN_USAGE } from './commands/pin';
import { showBankroll } from './commands/bankroll';
import { showDiscover, joinChallengeCmd, forgetPaymentCmd } from './commands/join';
import { listPhotosCmd, suggestPhotosCmd, parseSearchFlag } from './commands/photos';
import { checkUpdates } from './commands/update';
import { isPinnableImageId } from '../settings';
import {
    getSetting,
    setSetting,
    setGlobalDefault,
    beforeChosenPhotosWrite,
    clearChosenPhotos,
    listSettings,
    resetSetting,
    resetAllSettings,
    helpSettings,
    resetWindows,
    listProfiles,
    saveProfileFromChallenge,
    applyProfile,
    deleteProfile,
} from './commands/settings';
import { showLogs } from './commands/logs';
import { resetDataCmd, licensesCmd } from './commands/localData';
import { settingsRecoveryCmd } from './commands/settingsRecovery';
import * as scenarioCommands from './commands/scenarios';
import { showHelp } from './help';
import {
    extractChallenge,
    usageError,
    exitsZero,
    exitCodeOf,
    challengeCommand,
    profileCommand,
    flagAction,
    scenarioCommand,
} from './commandKit';

import type { CommandHandler } from './commandKit';

// --challenge scopes to a single-challenge manual vote; bare `vote` votes
// every challenge to 100%. A present-but-empty --challenge is rejected rather
// than silently voting everything.
const runVote: CommandHandler = async (argv) => {
    const challengeId = parseChallengeFlag(argv);
    const hasChallengeFlag = argv.some((a) => a === '--challenge' || a.startsWith('--challenge='));
    if (hasChallengeFlag && challengeId == null) {
        return usageError(
            'Please specify a challenge id with --challenge',
            'Usage: vote [--challenge=<id>]  (omit --challenge to vote every challenge)',
        );
    }
    if (challengeId != null) {
        await voteChallengeManual(challengeId);
    } else {
        await runVotingCycle(1, { isManual: true });
    }
    return 0;
};

const SCENARIO_RESET_USAGE = 'Usage: scenario-reset --challenge=<id>  |  scenario-reset --all';

// One challenge's progress, or (--all, alone) every challenge's: the only way past an unreadable progress file.
const runScenarioReset: CommandHandler = async (argv) => {
    if (!argv.includes('--all')) {
        return challengeCommand(SCENARIO_RESET_USAGE, (id) => scenarioCommands.scenarioResetCmd(id))(argv);
    }
    return argv.length === 1
        ? scenarioCommands.scenarioResetAllCmd()
        : usageError('--all takes no other arguments', SCENARIO_RESET_USAGE);
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

const JOIN_USAGE = 'Usage: join <id> [--yes [--max-coins=<coins>]]';

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
    if (wrong) return usageError('Wrong arguments', JOIN_USAGE);
    return joinChallengeCmd(positional[0], {
        yes: flags.includes('--yes'),
        ...(maxCoins === undefined ? {} : { maxCoins }),
    });
};

const FORGET_PAYMENT_USAGE = 'Usage: forget-payment <id>';

// Strict like `join`: it changes what a later join pays for, so a typo must not reach another challenge.
const runForgetPayment: CommandHandler = async (argv) => {
    // Only a plain challenge id: the claims are keyed `<member id>:<challenge id>`, and a colon in the id must not
    // reach another record.
    if (argv.length !== 1 || !/^\d+$/.test(argv[0])) return usageError('Wrong arguments', FORGET_PAYMENT_USAGE);
    return forgetPaymentCmd(argv[0]);
};

const LIST_PHOTOS_USAGE =
    'Usage: list-photos [--challenge=<id>] [--search=<tag>]  or  list-photos --challenge=<id> --suggest';

const runListPhotos: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    const suggestFlags = rest.filter((arg) => arg === '--suggest');
    const listRest = rest.filter((arg) => arg !== '--suggest');
    const search = parseSearchFlag(listRest);
    // Anything that is neither a --search flag nor its value is a typo.
    const unexpected = listRest.filter(
        (arg, i) => arg !== '--search' && !arg.startsWith('--search=') && listRest[i - 1] !== '--search',
    );
    if (unexpected.length > 0 || (listRest.some((arg) => arg === '--search') && search === null)) {
        return usageError('Wrong arguments', LIST_PHOTOS_USAGE);
    }
    if (suggestFlags.length > 0) {
        // The suggestions rank for one challenge and are not a search.
        if (suggestFlags.length > 1 || challengeId === null || listRest.length > 0) {
            return usageError('Wrong arguments', LIST_PHOTOS_USAGE);
        }
        return suggestPhotosCmd(challengeId);
    }
    return listPhotosCmd(challengeId, search);
};

const runBoost = async (challengeId: string, rest: string[]) => {
    const imageArg = rest.find((a) => a.startsWith('--image='));
    const imageId = imageArg ? imageArg.slice('--image='.length) || null : null;
    await boostChallenge(challengeId, { imageId });
    return 0;
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

const runSwapBack = async (challengeId: string, rest: string[]) => {
    const { imageId, yes } = parseSwapFlags(rest);
    return exitCodeOf(await swapBackCmd(challengeId, { imageId, yes }));
};

const runGetSetting: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    if (!rest[0]) return usageError('Please specify a setting key', 'Usage: get-setting <key> [--challenge=<id>]');
    getSetting(rest[0], challengeId);
    return 0;
};

const runSetSetting: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    if (!rest[0] || rest[1] === undefined) {
        return usageError('Please specify both key and value', 'Usage: set-setting <key> <value> [--challenge=<id>]');
    }
    // The warning about another account's lists comes before the write, the owner stamp after it.
    const stampOwner = await beforeChosenPhotosWrite(rest[0], rest[1]);
    // A name that is no setting, or a value it refuses, is a failure: the exit code says so to a script.
    const saved = setSetting(rest[0], rest[1], challengeId);
    if (saved) stampOwner();
    return saved ? 0 : 1;
};

const runResetSetting: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    if (!rest[0]) return usageError('Please specify a setting key', 'Usage: reset-setting <key> [--challenge=<id>]');
    return resetSetting(rest[0], challengeId) ? 0 : 1;
};

const runSetGlobalDefault: CommandHandler = async ([key, value]) => {
    if (!key || !value) {
        return usageError(
            'Please specify both setting key and value',
            'Usage: set-global-default <key> <value>',
            'Example: set-global-default exposure 80',
        );
    }
    const stampOwner = await beforeChosenPhotosWrite(key, value);
    const saved = setGlobalDefault(key, value);
    if (saved) stampOwner();
    return saved ? 0 : 1;
};

// It takes no arguments on purpose: a --challenge would suggest it clears one challenge, but it
// removes every saved list.
const runClearChosenPhotos: CommandHandler = async (argv) => {
    if (argv.length > 0) return usageError(`Unexpected arguments: ${argv.join(' ')}`, 'Usage: clear-chosen-photos');
    return exitCodeOf(clearChosenPhotos());
};

const runListProfiles: CommandHandler = async (argv) => {
    const { rest } = extractChallenge(argv);
    if (rest.length > 0) return usageError(`Unexpected arguments: ${rest.join(' ')}`, 'Usage: list-profiles');
    listProfiles();
    return 0;
};

/**
 * Command table: name → `(argv) => exitCode`, where argv is everything after
 * the command name. A handler resolving `undefined` leaves the process
 * running (continuous mode).
 */
const COMMANDS: Record<string, CommandHandler> = {
    login: async () => exitCodeOf(await handleLogin()),
    logout: async () => exitCodeOf(await handleLogout()),
    vote: runVote,
    run: runRun,
    boost: challengeCommand('Usage: boost --challenge=<id> [--image=<id>]', runBoost),
    pin: challengeCommand(PIN_USAGE, runPin),
    turbo: challengeCommand('Usage: turbo --challenge=<id>', async (challengeId) => {
        await turboChallenge(challengeId);
        return 0;
    }),
    submit: challengeCommand('Usage: submit --challenge=<id> [--all]', flagAction(fillChallenge, 'all', '--all')),
    'unlock-boost': challengeCommand(
        'Usage: unlock-boost --challenge=<id> [--yes]',
        flagAction(unlockBoostCmd, 'yes', '--yes'),
    ),
    swap: challengeCommand(SWAP_USAGE, async (challengeId, rest) =>
        exitCodeOf(await swapCmd(challengeId, parseSwapFlags(rest))),
    ),
    'swap-back': challengeCommand(SWAP_BACK_USAGE, runSwapBack),
    'fill-exposure': challengeCommand(
        'Usage: fill-exposure --challenge=<id> [--yes]',
        flagAction(fillExposureCmd, 'yes', '--yes'),
    ),
    'check-updates': exitsZero(checkUpdates),
    // Continuous mode keeps running — no exit code.
    start: async () => {
        await startContinuousVoting();
        return undefined;
    },
    status: exitsZero(showStatus),
    bankroll: exitsZero(showBankroll),
    coins: exitsZero(showBankroll),
    discover: exitsZero(showDiscover),
    join: runJoin,
    'forget-payment': runForgetPayment,
    'list-photos': runListPhotos,
    'get-setting': runGetSetting,
    'set-setting': runSetSetting,
    'list-settings': async (argv) => {
        listSettings(extractChallenge(argv).challengeId);
        return 0;
    },
    'reset-setting': runResetSetting,
    'clear-chosen-photos': runClearChosenPhotos,
    'set-global-default': runSetGlobalDefault,
    'reset-all-settings': exitsZero(resetAllSettings),
    'list-profiles': runListProfiles,
    'save-profile': profileCommand('save-profile', saveProfileFromChallenge, {
        needsChallenge: true,
        challengeHint: "Please specify --challenge=<id> to snapshot that challenge's overrides",
    }),
    'apply-profile': profileCommand('apply-profile', applyProfile, {
        needsChallenge: true,
        challengeHint: 'Please specify --challenge=<id> to apply the profile to',
    }),
    'delete-profile': profileCommand('delete-profile', (name) => deleteProfile(name)),
    'list-scenarios': scenarioCommand('Usage: list-scenarios', 0, () => scenarioCommands.listScenarios()),
    'scenario-template': scenarioCommand(
        'Usage: scenario-template <id> [file]',
        1,
        ([id, file]) => scenarioCommands.scenarioTemplate(id, file),
        2,
    ),
    'import-scenario': scenarioCommand('Usage: import-scenario <file> [--overwrite] [--yes]', 1, ([file], flags) =>
        scenarioCommands.importScenarioCmd(file, { overwrite: flags.has('--overwrite'), yes: flags.has('--yes') }),
    ),
    'export-scenario': scenarioCommand(
        'Usage: export-scenario "<name>" [file]',
        1,
        ([name, file]) => scenarioCommands.exportScenarioCmd(name, file),
        2,
    ),
    'rename-scenario': scenarioCommand('Usage: rename-scenario "<old>" "<new>"', 2, ([oldName, newName]) =>
        scenarioCommands.renameScenarioCmd(oldName, newName),
    ),
    'delete-scenario': scenarioCommand('Usage: delete-scenario "<name>"', 1, ([name]) =>
        scenarioCommands.deleteScenarioCmd(name),
    ),
    'scenario-status': challengeCommand('Usage: scenario-status --challenge=<id>', (id) =>
        scenarioCommands.scenarioStatusCmd(id),
    ),
    'scenario-dry-run': challengeCommand('Usage: scenario-dry-run --challenge=<id>', (id) =>
        scenarioCommands.scenarioDryRunCmd(id),
    ),
    'scenario-simulate': challengeCommand('Usage: scenario-simulate --challenge=<id>', (id) =>
        scenarioCommands.scenarioSimulateCmd(id),
    ),
    'scenario-reset': runScenarioReset,
    'scenario-vocabulary': scenarioCommand('Usage: scenario-vocabulary', 0, () =>
        scenarioCommands.scenarioVocabulary(),
    ),
    logs: runLogs,
    'reset-data': resetDataCmd,
    licenses: async () => licensesCmd(),
    'help-settings': exitsZero(helpSettings),
    'reset-windows': exitsZero(resetWindows),
    'settings-recovery': settingsRecoveryCmd,
    help: exitsZero(showHelp),
    '--help': exitsZero(showHelp),
    '-h': exitsZero(showHelp),
};

// The commands that hold no session marker, so they never make a local-data wipe wait: help and licenses, which only
// print, and `reset-data`, which checks for running sessions itself.
const MARKERLESS_COMMANDS = new Set(['help', '--help', '-h', 'licenses', 'reset-data']);

/**
 * Whether a command holds the CLI session marker while it runs: every command that loads the settings does, since a
 * load can write them back (a migration, a scrub) and a command can spend, so a wipe (or `reset-data` in another
 * terminal) refuses while it runs.
 */
const holdsSessionMarker = (name: string): boolean => !MARKERLESS_COMMANDS.has(name);

export { COMMANDS, holdsSessionMarker };
