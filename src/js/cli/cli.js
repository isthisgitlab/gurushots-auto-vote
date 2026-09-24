#!/usr/bin/env node

/**
 * GuruShots Auto Voter - CLI Entry Point
 *
 * Thin dispatcher: parses argv, routes to a command module, and owns
 * process-level concerns (init, exit codes, unhandled error handlers).
 * The actual command logic lives in:
 *   - cli/commands/auth.js     login flow
 *   - cli/commands/voting.js   vote cycles, status, continuous mode
 *   - cli/commands/settings.js get / set / list / reset
 *   - cli/prompts.js           readline I/O helpers (used by auth)
 *
 * Run: node src/js/cli/cli.js <command> [...args]
 */

const logger = require('../logger');
const { requireProfileArgs, requireChallenge } = require('./guards');
logger.withCategory('api').debug('CLI module loaded, starting initialization', null);

const settings = require('../settings');
const { initializeHeaders } = require('../api/randomizer');
const { handleLogin, handleLogout } = require('./commands/auth');
const {
    runVotingCycle,
    voteChallengeManual,
    parseChallengeFlag,
    startContinuousVoting,
    showStatus,
} = require('./commands/voting');
const {
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
} = require('./commands/actions');
const { showBankroll } = require('./commands/bankroll');
const { showDiscover, joinChallengeCmd } = require('./commands/join');
const { checkUpdates } = require('./commands/update');
const {
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
} = require('./commands/settings');
const { showLogs } = require('./commands/logs');

const args = process.argv.slice(2);
const command = args[0];

// Pull --challenge=<id> (or --challenge <id>) out of an arg list and return
// the remaining positional args, so per-challenge settings commands accept
// the flag in any position (mirrors `run --challenge=<id>`).
const extractChallenge = (argv) => {
    const challengeId = parseChallengeFlag(argv);
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--challenge') {
            i++; // skip the flag and its separate value
            continue;
        }
        if (argv[i].startsWith('--challenge=')) continue;
        rest.push(argv[i]);
    }
    return { challengeId, rest };
};

const showHelp = () => {
    const userSettings = settings.loadSettings();
    const isMockMode = userSettings.mock;

    logger.withCategory('ui').info(`
GuruShots Auto Voter - CLI ${isMockMode ? '(MOCK MODE)' : '(REAL MODE)'}

Usage: <command>

Commands:
  login    - Authenticate with GuruShots and save token
  logout   - Clear the saved authentication token
  vote     - Run one manual voting cycle (votes to 100% regardless of settings).
             Add --challenge=<id> to manually vote a single challenge.
  run      - Run one full auto-strategy cycle (boost / turbo / auto-submit / threshold-aware vote).
             Add --challenge=<id> to scope to a single challenge.
  boost    - Apply a boost to a challenge: boost --challenge=<id> [--image=<id>]
  turbo    - Play the turbo mini-game on a challenge: turbo --challenge=<id>
  submit   - Submit photo(s) to a challenge's empty slots: submit --challenge=<id> [--all]
  unlock-boost  - Spend a key to unlock a locked boost (does not apply it):
             unlock-boost --challenge=<id> [--yes]
  swap     - Spend a swap to replace an entered photo with a different one:
             swap --challenge=<id> --image=<id> [--to=<id> --yes]
  swap-back - Swap a photo that was swapped out while boosted/turbo'd back in (it gets
             its boost/turbo back): swap-back --challenge=<id> --image=<current id> [--yes]
  fill-exposure - Spend a fill to top exposure up to 100%: fill-exposure --challenge=<id> [--yes]
             Currency actions spend nothing without --yes; they print the cost first.
  start    - Start continuous voting with cron scheduling (runs until stopped with Ctrl+C)
  status   - Show current status and settings
  bankroll - Show your currency balances (keys / swaps / fills / coins). Alias: coins
  discover - List open (un-joined) challenges you can join
  join <id> [--yes] - Join an open challenge. Free joins immediately; paid joins
             print the coin cost and require --yes before spending coins.
  check-updates - Check GitHub for a newer release
  get-setting <key> [--challenge=<id>] - Get a setting value (effective value for a challenge with --challenge)
  set-setting <key> <value> [--challenge=<id>] - Set a setting value (per-challenge override with --challenge)
  set-global-default <key> <value> - Set global default with validation
  list-settings [--challenge=<id>] - Show all settings (per-challenge view with --challenge)
  reset-setting <key> [--challenge=<id>] - Reset a setting to default (clear a challenge override with --challenge)
  reset-all-settings - Reset all settings to defaults
  list-profiles - Show saved challenge-settings profiles
  save-profile "<name>" --challenge=<id> - Save a challenge's overrides as a named profile
  apply-profile "<name>" --challenge=<id> - Replace a challenge's overrides with a profile
  delete-profile "<name>" - Delete a saved profile
  help-settings - Show detailed settings help (includes profile details)
  logs [--error|--api|--settings|--lexicon] [--lines=<n>] - Show logs or the local lexicon report
  reset-windows  - Reset window positions to default
  help     - Show this help message

Examples:
  login
  vote
  vote --challenge=12345
  run
  run --challenge=12345
  boost --challenge=12345
  turbo --challenge=12345
  submit --challenge=12345 --all
  unlock-boost --challenge=12345 --yes
  swap --challenge=12345 --image=abc123
  fill-exposure --challenge=12345 --yes
  bankroll
  discover
  join 12345
  join 12345 --yes
  check-updates
  set-setting exposure 80 --challenge=12345
  list-settings --challenge=12345
  logs --error --lines=50
  start
  logout
  reset-windows

Note: You must login first before you can vote, boost, turbo, or submit.
      The 'start' command will run continuously until stopped with Ctrl+C.
      Voting interval adjusts dynamically based on challenge states.
      Use 'get-setting checkFrequencyMin'/'checkFrequencyMax' to view, 'set-setting checkFrequencyMin 2' / 'set-setting checkFrequencyMax 5' to set the random range.
      Current mode: ${isMockMode ? 'MOCK (simulated API calls)' : 'REAL (live API calls)'}
    `);
};

/** Log a usage error (one error line, then any usage/help lines) and yield exit code 1. */
const usageError = (message, ...usage) => {
    logger.withCategory('ui').error(message);
    for (const line of usage) logger.withCategory('ui').info(line);
    return 1;
};

/** A command that only runs `fn` and then exits 0. */
const exitsZero = (fn) => async () => {
    await fn();
    return 0;
};

/** Exit code for a command reporting `false` on failure. */
const exitCodeOf = (ok) => (ok === false ? 1 : 0);

/**
 * A per-challenge action: pull --challenge out of argv, require it (printing
 * `usage` otherwise), then `run(challengeId, rest)` → exit code.
 */
const challengeCommand = (usage, run) => async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    requireChallenge({ challengeId }, usage);
    return run(challengeId, rest);
};

/** A profile command: resolve the profile name via requireProfileArgs, then `run(name, challengeId)`. */
const profileCommand =
    (name, run, ...options) =>
    async (argv) => {
        const parsed = extractChallenge(argv);
        const profile = requireProfileArgs(name, parsed, ...options);
        run(profile, parsed.challengeId);
        return 0;
    };

// --challenge scopes to a single-challenge manual vote; bare `vote` votes
// every challenge to 100%. A present-but-empty --challenge is rejected rather
// than silently voting everything.
const runVote = async (argv) => {
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

const LOG_CATEGORY_FLAGS = {
    '--error': 'error',
    '--api': 'api',
    '--settings': 'settings',
    '--lexicon': 'lexicon',
};

const runLogs = async (argv) => {
    const category = LOG_CATEGORY_FLAGS[argv.find((arg) => Object.hasOwn(LOG_CATEGORY_FLAGS, arg))] || 'app';
    const linesArg = argv.find((a) => a.startsWith('--lines='));
    const lines = linesArg ? parseInt(linesArg.slice('--lines='.length), 10) || 100 : 100;
    showLogs({ category, lines });
    return 0;
};

const runRun = async (argv) => {
    await runVotingCycle(1, { isManual: false, challengeId: parseChallengeFlag(argv) });
    return 0;
};

const runJoin = async (argv) => {
    const yes = argv.includes('--yes');
    const id = argv.find((a) => !a.startsWith('--'));
    await joinChallengeCmd(id, { yes });
    return 0;
};

const runBoost = async (challengeId, rest) => {
    const imageArg = rest.find((a) => a.startsWith('--image='));
    const imageId = imageArg ? imageArg.slice('--image='.length) || null : null;
    await boostChallenge(challengeId, { imageId });
    return 0;
};

const runSwapBack = async (challengeId, rest) => {
    const { imageId, yes } = parseSwapFlags(rest);
    return exitCodeOf(await swapBackCmd(challengeId, { imageId, yes }));
};

/** A per-challenge action taking only a `{ [option]: flagPresent }` bag, then exiting 0. */
const flagAction = (fn, option, flag) => async (challengeId, rest) => {
    await fn(challengeId, { [option]: rest.includes(flag) });
    return 0;
};

const runGetSetting = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    if (!rest[0]) return usageError('Please specify a setting key', 'Usage: get-setting <key> [--challenge=<id>]');
    getSetting(rest[0], challengeId);
    return 0;
};

const runSetSetting = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    if (!rest[0] || rest[1] === undefined) {
        return usageError('Please specify both key and value', 'Usage: set-setting <key> <value> [--challenge=<id>]');
    }
    setSetting(rest[0], rest[1], challengeId);
    return 0;
};

const runResetSetting = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    if (!rest[0]) return usageError('Please specify a setting key', 'Usage: reset-setting <key> [--challenge=<id>]');
    return resetSetting(rest[0], challengeId) ? 0 : 1;
};

const runSetGlobalDefault = async ([key, value]) => {
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

const runListProfiles = async (argv) => {
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
const COMMANDS = {
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
    logs: runLogs,
    'help-settings': exitsZero(helpSettings),
    'reset-windows': exitsZero(resetWindows),
    help: exitsZero(showHelp),
    '--help': exitsZero(showHelp),
    '-h': exitsZero(showHelp),
};

const dispatch = (name, argv) => {
    if (!name) {
        logger.withCategory('ui').info('No command specified. Use "help" to see available commands');
        return 1;
    }
    if (!Object.hasOwn(COMMANDS, name)) {
        return usageError(`Unknown command: ${name}`, 'Use "help" to see available commands');
    }
    return COMMANDS[name](argv);
};

const main = async () => {
    try {
        initializeHeaders();
        // Seed the curated intent presets once (idempotent; never fatal) so
        // the `settings` command lists them and they can be applied from CLI.
        try {
            settings.seedIntentProfiles();
        } catch (err) {
            logger.withCategory('settings').warning('Intent profile seeding failed (non-fatal):', err);
        }
        logger.withCategory('api').debug('main: Command is:', command);

        const code = await dispatch(command, args.slice(1));
        if (code !== undefined) process.exit(code);
    } catch (error) {
        logger.withCategory('api').error('Error');
        logger.withCategory('api').debug('Full main function error details:', error);
        process.exit(1);
    } finally {
        logger.cleanup();
    }
};

process.on('unhandledRejection', (reason, promise) => {
    logger.withCategory('api').error('Unhandled Promise Rejection');
    logger.withCategory('api').debug('Unhandled Promise Rejection details:', { reason, promise });
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    logger.withCategory('api').error('Uncaught Exception');
    logger.withCategory('api').debug('Uncaught Exception details:', error);
    process.exit(1);
});

main().catch((error) => {
    logger.withCategory('api').error('Error caught in main() call');
    logger.withCategory('error').debug('Main() call error details:', error);
    process.exit(1);
});
