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
const { boostChallenge, turboChallenge, fillChallenge } = require('./commands/actions');
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
  run      - Run one full auto-strategy cycle (boost / turbo / auto-fill / threshold-aware vote).
             Add --challenge=<id> to scope to a single challenge.
  boost    - Apply a boost to a challenge: boost --challenge=<id> [--image=<id>]
  turbo    - Play the turbo mini-game on a challenge: turbo --challenge=<id>
  fill     - Submit photo(s) to a challenge's empty slots: fill --challenge=<id> [--all]
  start    - Start continuous voting with cron scheduling (runs until stopped with Ctrl+C)
  status   - Show current status and settings
  check-updates - Check GitHub for a newer release
  get-setting <key> [--challenge=<id>] - Get a setting value (effective value for a challenge with --challenge)
  set-setting <key> <value> [--challenge=<id>] - Set a setting value (per-challenge override with --challenge)
  set-global-default <key> <value> - Set global default with validation
  list-settings [--challenge=<id>] - Show all settings (per-challenge view with --challenge)
  reset-setting <key> [--challenge=<id>] - Reset a setting to default (clear a challenge override with --challenge)
  reset-all-settings - Reset all settings to defaults
  help-settings - Show detailed settings help
  logs [--error|--api|--settings] [--lines=<n>] - Print the tail of a log file
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
  fill --challenge=12345 --all
  check-updates
  set-setting exposure 80 --challenge=12345
  list-settings --challenge=12345
  logs --error --lines=50
  start
  logout
  reset-windows

Note: You must login first before you can vote, boost, turbo, or fill.
      The 'start' command will run continuously until stopped with Ctrl+C.
      Voting interval adjusts dynamically based on challenge states.
      Use 'get-setting checkFrequencyMin'/'checkFrequencyMax' to view, 'set-setting checkFrequencyMin 2' / 'set-setting checkFrequencyMax 5' to set the random range.
      Current mode: ${isMockMode ? 'MOCK (simulated API calls)' : 'REAL (live API calls)'}
    `);
};

const main = async () => {
    try {
        initializeHeaders();
        logger.withCategory('api').debug('main: Command is:', command);

        switch (command) {
            case 'login':
                await handleLogin();
                process.exit(0);
                break;
            case 'logout':
                handleLogout();
                process.exit(0);
                break;
            case 'vote': {
                // --challenge scopes to a single-challenge manual vote;
                // bare `vote` votes every challenge to 100%. A present-but-empty
                // --challenge is rejected rather than silently voting everything.
                const voteTail = args.slice(1);
                const challengeId = parseChallengeFlag(voteTail);
                const hasChallengeFlag = voteTail.some((a) => a === '--challenge' || a.startsWith('--challenge='));
                if (hasChallengeFlag && challengeId == null) {
                    logger.withCategory('ui').error('Please specify a challenge id with --challenge');
                    logger
                        .withCategory('ui')
                        .info('Usage: vote [--challenge=<id>]  (omit --challenge to vote every challenge)');
                    process.exit(1);
                    break;
                }
                if (challengeId != null) {
                    await voteChallengeManual(challengeId);
                } else {
                    await runVotingCycle(1, { isManual: true });
                }
                process.exit(0);
                break;
            }
            case 'run': {
                const challengeId = parseChallengeFlag(args.slice(1));
                await runVotingCycle(1, { isManual: false, challengeId });
                process.exit(0);
                break;
            }
            case 'boost': {
                const { challengeId, rest } = extractChallenge(args.slice(1));
                if (challengeId == null) {
                    logger.withCategory('ui').error('Please specify a challenge');
                    logger.withCategory('ui').info('Usage: boost --challenge=<id> [--image=<id>]');
                    process.exit(1);
                    break;
                }
                const imageArg = rest.find((a) => a.startsWith('--image='));
                const imageId = imageArg ? imageArg.slice('--image='.length) || null : null;
                await boostChallenge(challengeId, { imageId });
                process.exit(0);
                break;
            }
            case 'turbo': {
                const { challengeId } = extractChallenge(args.slice(1));
                if (challengeId == null) {
                    logger.withCategory('ui').error('Please specify a challenge');
                    logger.withCategory('ui').info('Usage: turbo --challenge=<id>');
                    process.exit(1);
                    break;
                }
                await turboChallenge(challengeId);
                process.exit(0);
                break;
            }
            case 'fill': {
                const { challengeId, rest } = extractChallenge(args.slice(1));
                if (challengeId == null) {
                    logger.withCategory('ui').error('Please specify a challenge');
                    logger.withCategory('ui').info('Usage: fill --challenge=<id> [--all]');
                    process.exit(1);
                    break;
                }
                await fillChallenge(challengeId, { all: rest.includes('--all') });
                process.exit(0);
                break;
            }
            case 'check-updates':
                await checkUpdates();
                process.exit(0);
                break;
            case 'start':
                await startContinuousVoting();
                // Don't exit for continuous mode — it keeps running.
                break;
            case 'status':
                await showStatus();
                process.exit(0);
                break;
            case 'get-setting': {
                const { challengeId, rest } = extractChallenge(args.slice(1));
                if (!rest[0]) {
                    logger.withCategory('ui').error('Please specify a setting key');
                    logger.withCategory('ui').info('Usage: get-setting <key> [--challenge=<id>]');
                    process.exit(1);
                }
                getSetting(rest[0], challengeId);
                process.exit(0);
                break;
            }
            case 'set-setting': {
                const { challengeId, rest } = extractChallenge(args.slice(1));
                if (!rest[0] || rest[1] === undefined) {
                    logger.withCategory('ui').error('Please specify both key and value');
                    logger.withCategory('ui').info('Usage: set-setting <key> <value> [--challenge=<id>]');
                    process.exit(1);
                }
                setSetting(rest[0], rest[1], challengeId);
                process.exit(0);
                break;
            }
            case 'list-settings': {
                const { challengeId } = extractChallenge(args.slice(1));
                listSettings(challengeId);
                process.exit(0);
                break;
            }
            case 'reset-setting': {
                const { challengeId, rest } = extractChallenge(args.slice(1));
                if (!rest[0]) {
                    logger.withCategory('ui').error('Please specify a setting key');
                    logger.withCategory('ui').info('Usage: reset-setting <key> [--challenge=<id>]');
                    process.exit(1);
                }
                resetSetting(rest[0], challengeId);
                process.exit(0);
                break;
            }
            case 'set-global-default':
                if (!args[1] || !args[2]) {
                    logger.withCategory('ui').error('Please specify both setting key and value');
                    logger.withCategory('ui').info('Usage: set-global-default <key> <value>');
                    logger.withCategory('ui').info('Example: set-global-default exposure 80');
                    process.exit(1);
                }
                setGlobalDefault(args[1], args[2]);
                process.exit(0);
                break;
            case 'reset-all-settings':
                resetAllSettings();
                process.exit(0);
                break;
            case 'logs': {
                const rest = args.slice(1);
                let category = 'app';
                if (rest.includes('--error')) category = 'error';
                else if (rest.includes('--api')) category = 'api';
                else if (rest.includes('--settings')) category = 'settings';
                const linesArg = rest.find((a) => a.startsWith('--lines='));
                const lines = linesArg ? parseInt(linesArg.slice('--lines='.length), 10) || 100 : 100;
                showLogs({ category, lines });
                process.exit(0);
                break;
            }
            case 'help-settings':
                helpSettings();
                process.exit(0);
                break;
            case 'reset-windows':
                resetWindows();
                process.exit(0);
                break;
            case 'help':
            case '--help':
            case '-h':
                showHelp();
                process.exit(0);
                break;
            default:
                if (!command) {
                    logger.withCategory('ui').info('No command specified. Use "help" to see available commands');
                } else {
                    logger.withCategory('ui').error(`Unknown command: ${command}`);
                    logger.withCategory('ui').info('Use "help" to see available commands');
                }
                process.exit(1);
                break;
        }
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
