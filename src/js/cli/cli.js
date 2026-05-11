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
const { handleLogin } = require('./commands/auth');
const { runVotingCycle, parseChallengeFlag, startContinuousVoting, showStatus } = require('./commands/voting');
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

const args = process.argv.slice(2);
const command = args[0];

const showHelp = () => {
    const userSettings = settings.loadSettings();
    const isMockMode = userSettings.mock;

    logger.withCategory('ui').info(`
GuruShots Auto Voter - CLI ${isMockMode ? '(MOCK MODE)' : '(REAL MODE)'}

Usage: <command>

Commands:
  login    - Authenticate with GuruShots and save token
  vote     - Run one manual voting cycle (votes to 100% regardless of settings)
  run      - Run one full auto-strategy cycle (boost / turbo / auto-fill / threshold-aware vote).
             Add --challenge=<id> to scope to a single challenge.
  start    - Start continuous voting with cron scheduling
  stop     - Stop continuous voting (if running)
  status   - Show current status and settings
  get-setting <key> - Get a setting value
  set-setting <key> <value> - Set a setting value
  set-global-default <key> <value> - Set global default with validation
  list-settings - Show all settings and their values
  reset-setting <key> - Reset a setting to default
  reset-all-settings - Reset all settings to defaults
  help-settings - Show detailed settings help
  reset-windows  - Reset window positions to default
  help     - Show this help message

Examples:
  login
  vote
  run
  run --challenge=12345
  start
  reset-windows

Note: You must login first before you can vote.
      The 'start' command will run continuously until stopped.
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
            case 'vote':
                await runVotingCycle(1, { isManual: true });
                process.exit(0);
                break;
            case 'run': {
                const challengeId = parseChallengeFlag(args.slice(1));
                await runVotingCycle(1, { isManual: false, challengeId });
                process.exit(0);
                break;
            }
            case 'start':
                await startContinuousVoting();
                // Don't exit for continuous mode — it keeps running.
                break;
            case 'status':
                showStatus();
                process.exit(0);
                break;
            case 'get-setting':
                if (!args[1]) {
                    logger.withCategory('ui').error('Please specify a setting key');
                    logger.withCategory('ui').info('Usage: get-setting <key>');
                    process.exit(1);
                }
                getSetting(args[1]);
                process.exit(0);
                break;
            case 'set-setting':
                if (!args[1] || !args[2]) {
                    logger.withCategory('ui').error('Please specify both key and value');
                    logger.withCategory('ui').info('Usage: set-setting <key> <value>');
                    process.exit(1);
                }
                setSetting(args[1], args[2]);
                process.exit(0);
                break;
            case 'list-settings':
                listSettings();
                process.exit(0);
                break;
            case 'reset-setting':
                if (!args[1]) {
                    logger.withCategory('ui').error('Please specify a setting key');
                    logger.withCategory('ui').info('Usage: reset-setting <key>');
                    process.exit(1);
                }
                resetSetting(args[1]);
                process.exit(0);
                break;
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
