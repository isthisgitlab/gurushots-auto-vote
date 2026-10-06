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
import { showBankroll } from './commands/bankroll';
import { showDiscover, joinChallengeCmd } from './commands/join';
import { listPhotosCmd, parseSearchFlag } from './commands/photos';
import { checkUpdates } from './commands/update';
import {
    getSetting,
    setSetting,
    setGlobalDefault,
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

const runJoin: CommandHandler = async (argv) => {
    const yes = argv.includes('--yes');
    const id = argv.find((a) => !a.startsWith('--'));
    await joinChallengeCmd(id, { yes });
    return 0;
};

const runListPhotos: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    const search = parseSearchFlag(rest);
    // Anything that is neither a --search flag nor its value is a typo.
    const unexpected = rest.filter((arg, i) => !arg.startsWith('--search') && rest[i - 1] !== '--search');
    if (unexpected.length > 0 || (rest.some((arg) => arg === '--search') && search === null)) {
        return usageError('Wrong arguments', 'Usage: list-photos [--challenge=<id>] [--search=<tag>]');
    }
    return listPhotosCmd(challengeId, search);
};

const runBoost = async (challengeId: string, rest: string[]) => {
    const imageArg = rest.find((a) => a.startsWith('--image='));
    const imageId = imageArg ? imageArg.slice('--image='.length) || null : null;
    await boostChallenge(challengeId, { imageId });
    return 0;
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
    setSetting(rest[0], rest[1], challengeId);
    return 0;
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
    setGlobalDefault(key, value);
    return 0;
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
    login: exitsZero(handleLogin),
    logout: exitsZero(handleLogout),
    vote: runVote,
    run: runRun,
    boost: challengeCommand('Usage: boost --challenge=<id> [--image=<id>]', runBoost),
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
    'list-photos': runListPhotos,
    'get-setting': runGetSetting,
    'set-setting': runSetSetting,
    'list-settings': async (argv) => {
        listSettings(extractChallenge(argv).challengeId);
        return 0;
    },
    'reset-setting': runResetSetting,
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
    'scenario-reset': challengeCommand('Usage: scenario-reset --challenge=<id>', (id) =>
        scenarioCommands.scenarioResetCmd(id),
    ),
    'scenario-vocabulary': scenarioCommand('Usage: scenario-vocabulary', 0, () =>
        scenarioCommands.scenarioVocabulary(),
    ),
    logs: runLogs,
    'help-settings': exitsZero(helpSettings),
    'reset-windows': exitsZero(resetWindows),
    help: exitsZero(showHelp),
    '--help': exitsZero(showHelp),
    '-h': exitsZero(showHelp),
};

export { COMMANDS };
