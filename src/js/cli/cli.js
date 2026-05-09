#!/usr/bin/env node

/**
 * GuruShots Auto Voter - CLI Entry Point
 *
 * This script provides a command-line interface for the GuruShots Auto Voter.
 * It can run in two modes:
 * 1. Single execution mode: Run once and exit
 * 2. Continuous mode: Run with configurable cron scheduling
 *
 * The application:
 * 1. Runs immediately on startup to process current challenges
 * 2. Sets up a cron job to run on a configurable schedule to continue voting
 * 3. Keeps track of voting attempts with a counter
 *
 * The CLI automatically detects and uses the mock setting from the GUI,
 * and can prompt the user during login to choose between real and mock mode.
 *
 * Requirements:
 * - Valid GuruShots authentication token in settings
 * - Node.js with required dependencies
 */

// Import logger first for debugging
const logger = require('../logger');
logger.withCategory('api').debug('Logger imported', null);

const { createScheduler } = require('../scheduling/runScheduler');
logger.withCategory('api').debug('runScheduler imported', null);
const readline = require('readline');
logger.withCategory('api').debug('readline imported', null);

// Import the API factory (CLI respects the mock setting from GUI)
logger.withCategory('api').debug('About to import apiFactory', null);
const { getMiddleware } = require('../apiFactory');
logger.withCategory('api').debug('apiFactory imported', null);
const settings = require('../settings');
logger.withCategory('settings').debug('settings imported');
const { getDefaultSettings } = require('../settings');
const { parseSettingValue } = require('./parseValue');
logger.withCategory('settings').debug('getDefaultSettings imported');

// Get the middleware instance - but don't destructure methods at module level
const getMiddlewareInstance = () => getMiddleware();
logger.withCategory('api').debug('About to import randomizer', null);
const { initializeHeaders } = require('../api/randomizer');
logger.withCategory('api').debug('randomizer imported', null);

// Debug module loading
logger.withCategory('api').debug('CLI module loaded, starting initialization', null);

// Get command line arguments
const args = process.argv.slice(2);
const command = args[0];

/**
 * Create readline interface for user input
 */
const createReadlineInterface = () => {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
};

/**
 * Ask user a yes/no question
 */
const askYesNo = async (question, rl) => {
    return new Promise((resolve) => {
        rl.question(`${question} (y/n): `, (answer) => {
            const normalized = answer.toLowerCase().trim();
            resolve(normalized === 'y' || normalized === 'yes');
        });
    });
};

/**
 * Ask user for input
 */
const askInput = async (question, rl) => {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer.trim());
        });
    });
};

/**
 * Ask for a secret. Mutes terminal echo while the user types so the
 * password is not visible on screen / scrollback / shoulder-surf. Uses
 * readline's _writeToOutput hook (the standard mute pattern). Restores
 * the prompt prefix in stdout before muting so the user still sees
 * which question they're answering.
 */
const askSecret = async (question, rl) => {
    return new Promise((resolve) => {
        const promise = rl.question(question, (answer) => {
            // Move past the muted line so the next prompt starts clean.
            rl.output.write('\n');
            rl.stdoutMuted = false;
            resolve(answer.trim());
        });
        // Activate mute for everything written *after* the prompt prefix.
        rl.stdoutMuted = true;
        rl._writeToOutput = (s) => {
            if (rl.stdoutMuted) {
                // Allow the question prefix and newlines through; suppress
                // the keystroke echo. readline writes the question once
                // when mute is off (the question call above), then echoes
                // each character — those echoes are what we suppress.
                if (s.includes('\n') || s.includes('\r')) rl.output.write(s);
            } else {
                rl.output.write(s);
            }
        };
        return promise;
    });
};

/**
 * Display help information
 */
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

/**
 * Handle login with mock mode option
 */
const handleLogin = async () => {
    const rl = createReadlineInterface();

    try {
        logger.withCategory('ui').info('=== GuruShots Auto Voter - Login ===');

        // Check current mock setting
        const userSettings = settings.loadSettings();
        const currentMockMode = userSettings.mock;

        logger.withCategory('ui').info(`Current mode: ${currentMockMode ? 'MOCK' : 'REAL'}`);

        // Ask if user wants to change the mode
        const changeMode = await askYesNo('Do you want to change the mode?', rl);

        let useMockMode = currentMockMode;

        if (changeMode) {
            logger.withCategory('ui').info('Mode options:');
            logger.withCategory('ui').info('  REAL  - Connect to actual GuruShots API (production)');
            logger.withCategory('ui').info('  MOCK  - Simulate API calls for testing (development)');

            const useMock = await askYesNo('Use MOCK mode?', rl);
            useMockMode = useMock;

            // Update the setting
            settings.setSetting('mock', useMockMode);
            logger.withCategory('settings').success(`Mode changed to: ${useMockMode ? 'MOCK' : 'REAL'}`);
        }

        // Get credentials
        const email = await askInput('\nEnter your GuruShots email: ', rl);
        const password = await askSecret('Enter your GuruShots password: ', rl);

        logger.withCategory('authentication').startOperation('login-auth', 'Authenticating with GuruShots');

        // Get fresh middleware instance with updated settings
        const { refreshApi } = require('../apiFactory');
        refreshApi();
        const middleware = getMiddlewareInstance();

        // Attempt login
        const loginResult = await middleware.cliLogin(email, password);

        if (loginResult.success) {
            logger.withCategory('authentication').endOperation('login-auth', 'Login successful');
            logger.withCategory('authentication').success(`Token saved for ${useMockMode ? 'MOCK' : 'REAL'} mode`);
        } else {
            logger.withCategory('authentication').endOperation('login-auth', null, loginResult.error || 'Unknown error');
        }
    } catch (error) {
        logger.withCategory('authentication').error('Login error', error);
    } finally {
        rl.close();
    }
};

/**
 * Run a single voting cycle. Pass {isManual: true} to use the manual
 * vote path (votes to 100% regardless of threshold settings). Pass
 * {challengeId} to scope a strategy cycle to a single challenge —
 * ignored when isManual is true.
 */
const runVotingCycle = async (cycleNumber = 1, { isManual = false, challengeId = null } = {}) => {
    const scopeSuffix = !isManual && challengeId != null ? ` (challenge ${challengeId})` : '';
    const label = isManual ? 'Manual Voting' : 'Voting';
    const opId = isManual ? `manual-vote-cycle-${cycleNumber}` : `vote-cycle-${cycleNumber}`;
    try {
        const userSettings = settings.loadSettings();
        const isMockMode = userSettings.mock;

        logger
            .withCategory('voting')
            .info(`--- ${label} Cycle ${cycleNumber}${scopeSuffix} (${isMockMode ? 'MOCK' : 'REAL'} MODE) ---`);
        logger.withCategory('voting').info(`Time: ${new Date().toLocaleString()}`);
        if (isManual) {
            logger.withCategory('voting').info('Mode: Manual (votes to 100% regardless of threshold settings)');
        }

        if (!getMiddlewareInstance().isAuthenticated()) {
            logger.withCategory('authentication').error('No authentication token found. Please login first');
            logger.withCategory('ui').info('Run: login');
            return false;
        }

        logger.withCategory('voting').startOperation(opId, `${label} cycle ${cycleNumber}${scopeSuffix}`);
        if (isManual) {
            await getMiddlewareInstance().cliVoteManual();
        } else {
            await getMiddlewareInstance().cliVote(challengeId);
        }
        logger.withCategory('voting').endOperation(opId, `${label} cycle ${cycleNumber} completed`);

        return true;
    } catch (error) {
        const noun = isManual ? 'manual voting' : 'voting';
        logger.withCategory('voting').error(`Error during ${noun} cycle ${cycleNumber}`, error);
        logger.withCategory('voting').debug(`Full ${noun} cycle error details:`, error);
        return false;
    }
};

/**
 * Pull a `--challenge=<id>` or `--challenge <id>` flag value from
 * the remaining argv tail. Returns null when absent.
 */
const parseChallengeFlag = (argv) => {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--challenge') {
            return argv[i + 1] ?? null;
        }
        if (a.startsWith('--challenge=')) {
            return a.slice('--challenge='.length) || null;
        }
    }
    return null;
};

/**
 * Start continuous voting with dynamic interval scheduling.
 * Delegates the scheduling engine to runScheduler; the CLI host
 * owns signal handling and process keep-alive.
 */
const startContinuousVoting = async () => {
    const userSettings = settings.loadSettings();
    const isMockMode = userSettings.mock;

    logger
        .withCategory('voting')
        .info(`=== Starting Continuous Voting Mode (${isMockMode ? 'MOCK' : 'REAL'} MODE) ===`);

    if (!getMiddlewareInstance().isAuthenticated()) {
        logger.withCategory('authentication').error('No authentication token found. Please login first');
        logger.withCategory('ui').info('Run: login');
        return;
    }

    const scheduler = createScheduler({
        runVotingCycle: (cycleNumber) => runVotingCycle(cycleNumber),
        getActiveChallenges: () => getMiddlewareInstance().getActiveChallenges(),
    });

    const handleShutdown = () => {
        logger.withCategory('voting').info('🛑 Shutting down continuous voting...');
        scheduler.stop();
        process.exit(0);
    };

    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);

    await scheduler.start();
    logger.withCategory('ui').info('Press Ctrl+C to stop');

    // Keep the process running
    process.stdin.resume();
};

/**
 * Show current status and settings
 */
const showStatus = () => {
    const userSettings = settings.loadSettings();
    const isMockMode = userSettings.mock;
    const isAuthenticated = getMiddlewareInstance().isAuthenticated();

    logger.withCategory('ui').info('=== GuruShots Auto Voter - Status ===');

    logger.withCategory('ui').info(`Mode: ${isMockMode ? 'MOCK (simulated API calls)' : 'REAL (live API calls)'}`);
    logger
        .withCategory('authentication')
        .info(`Authentication: ${isAuthenticated ? '✅ Authenticated' : '❌ Not authenticated'}`);

    if (isAuthenticated) {
        logger.withCategory('authentication').info(`Token: ${userSettings.token ? '✅ Present' : '❌ Missing'}`);
    }

    logger.withCategory('settings').info('\nSettings:');
    logger.withCategory('settings').info(`  Theme: ${userSettings.theme}`);
    logger.withCategory('settings').info(`  Language: ${userSettings.language}`);
    logger.withCategory('settings').info(`  Timezone: ${userSettings.timezone}`);
    logger.withCategory('settings').info(`  API Timeout: ${userSettings.apiTimeout}s`);
    {
        const min = userSettings.checkFrequencyMin;
        const max = userSettings.checkFrequencyMax;
        const label = min === max ? `${min}min` : `${min}–${max}min (random per cycle)`;
        logger.withCategory('settings').info(`  Check Frequency: ${label}`);
    }
    logger
        .withCategory('settings')
        .info(
            `  Last Minute Check Frequency: ${settings.getEffectiveSetting('lastMinuteCheckFrequency', 'global') || 1}min`,
        );

    // Show challenge settings if any exist
    if (userSettings.challengeSettings && Object.keys(userSettings.challengeSettings).length > 0) {
        logger.withCategory('settings').info('\nChallenge Settings:');
        Object.entries(userSettings.challengeSettings).forEach(([challengeId, challengeSettings]) => {
            logger.withCategory('settings').info(`  Challenge ${challengeId}:`);
            Object.entries(challengeSettings).forEach(([key, value]) => {
                logger.withCategory('settings').info(`    ${key}: ${value}`);
            });
        });
    }

    logger.withCategory('ui').info('\nTo change mode, run: login');
};

/**
 * Get a setting value
 */
const getSetting = (key) => {
    try {
        const value = settings.getSetting(key);
        if (value === undefined) {
            logger.withCategory('settings').error(`Setting '${key}' not found`);
            return;
        }
        logger.withCategory('settings').info(`${key}: ${JSON.stringify(value)}`);
    } catch (error) {
        logger.withCategory('settings').error(`Error getting setting '${key}'`, error);
    }
};

/**
 * Set a setting value
 */
const setSetting = (key, value) => {
    try {
        const parsedValue = parseSettingValue(value);
        settings.setSetting(key, parsedValue);
        logger.withCategory('settings').success(`Set ${key} = ${JSON.stringify(parsedValue)}`);
    } catch (error) {
        logger.withCategory('settings').error(`Error setting '${key}'`, error);
    }
};

/**
 * Set a global default value for a schema-based setting with validation
 */
const setGlobalDefault = (key, value) => {
    try {
        const parsedValue = parseSettingValue(value);

        // Check if this is a valid schema setting
        const schema = settings.SETTINGS_SCHEMA;
        if (!schema[key]) {
            logger.withCategory('settings').error(`Unknown schema setting '${key}'`);
            logger.withCategory('settings').info('Available settings:');
            Object.keys(schema).forEach((settingKey) => {
                logger.withCategory('settings').info(`  ${settingKey}`);
            });
            return;
        }

        // Use schema-based validation
        const success = settings.setGlobalDefault(key, parsedValue);
        if (success) {
            const actualValue = settings.getGlobalDefault(key);
            logger.withCategory('settings').success(`Set global default ${key} = ${JSON.stringify(actualValue)}`);
        } else {
            logger.withCategory('settings').error(`Failed to set global default '${key}' - validation failed`);
            logger.withCategory('settings').error(`Value ${JSON.stringify(parsedValue)} is invalid for this setting`);

            // Show setting info
            const config = schema[key];
            logger
                .withCategory('settings')
                .info(`Setting info: ${config.type} type, default: ${JSON.stringify(config.default)}`);
        }
    } catch (error) {
        logger.withCategory('settings').error(`Error setting global default '${key}'`, error);
    }
};

/**
 * List all settings and their values
 */
const listSettings = () => {
    try {
        const userSettings = settings.loadSettings();
        const defaultSettings = getDefaultSettings();

        logger.withCategory('settings').info('=== All Settings ===');

        // Get all possible setting keys (user settings + defaults)
        const allKeys = new Set([...Object.keys(userSettings), ...Object.keys(defaultSettings)]);

        // Sort keys for consistent output
        const sortedKeys = Array.from(allKeys).sort();

        sortedKeys.forEach((key) => {
            const currentValue = userSettings[key];
            const defaultValue = defaultSettings[key];
            const isModified = JSON.stringify(currentValue) !== JSON.stringify(defaultValue);

            logger.withCategory('settings').info(`${key}:`);
            logger.withCategory('settings').info(`  Current: ${JSON.stringify(currentValue)}`);
            logger.withCategory('settings').info(`  Default: ${JSON.stringify(defaultValue)}`);
            if (isModified) {
                logger.withCategory('settings').info('  Status:  Modified ✏️');
            } else {
                logger.withCategory('settings').info('  Status:  Default ✅');
            }
            logger.withCategory('settings').info('');
        });

        logger.withCategory('ui').info('💡 Use "help-settings" for detailed information about each setting');
    } catch (error) {
        logger.withCategory('settings').error('Error listing settings', error);
    }
};

/**
 * Reset a specific setting to default
 */
const resetSetting = (key) => {
    try {
        const defaultSettings = getDefaultSettings();
        const defaultValue = defaultSettings[key];

        if (defaultValue === undefined) {
            logger.withCategory('settings').error(`Setting '${key}' not found in defaults`);
            return;
        }

        settings.setSetting(key, defaultValue);
        logger.withCategory('settings').success(`Reset ${key} to default: ${JSON.stringify(defaultValue)}`);
    } catch (error) {
        logger.withCategory('settings').error(`Error resetting setting '${key}'`, error);
    }
};

/**
 * Reset all settings to defaults
 */
const resetAllSettings = () => {
    try {
        const defaultSettings = getDefaultSettings();

        // Reset all settings to defaults
        Object.keys(defaultSettings).forEach((key) => {
            settings.setSetting(key, defaultSettings[key]);
        });

        logger.withCategory('settings').success('All settings reset to defaults');
        logger.withCategory('ui').info('💡 Run "list-settings" to see all current values');
    } catch (error) {
        logger.withCategory('settings').error('Error resetting all settings', error);
    }
};

/**
 * Show detailed help about settings
 */
const helpSettings = () => {
    logger.withCategory('ui').info(`
=== Settings Management Help ===

Available Commands:
  get-setting <key>     - Get current value of a setting
  set-setting <key> <value> - Set a setting value
  list-settings         - Show all settings and their values
  reset-setting <key>   - Reset a setting to its default value
  reset-all-settings    - Reset all settings to defaults
  help-settings         - Show this help message

Common Settings:
  apiTimeout           - API request timeout in seconds (default: 30)
  checkFrequencyMin    - Minimum minutes between voting cycles (default: 3)
  checkFrequencyMax    - Maximum minutes between voting cycles (default: 3). Each cycle picks
                         a random delay in [min, max]; set min === max for a fixed cadence.
  mock                 - Use mock API for testing (default: false)
  theme                - UI theme: "light" or "dark" (default: "light")
  language             - UI language: "en" or "lv" (default: "en")
  timezone             - Timezone for timestamps (default: "Europe/Riga")

Value Types:
  String:   "value" or value
  Number:   30, 3, 100
  Boolean:  true, false
  Array:    [1, 2, 3]
  Object:   {"key": "value"}

Examples:
  set-setting checkFrequencyMin 2
  set-setting checkFrequencyMax 5
  set-setting apiTimeout 60
  set-setting mock true
  get-setting checkFrequencyMin
  reset-setting checkFrequencyMax

💡 Tip: Use "list-settings" to see all available settings and their current values
`);
};

/**
 * Reset window positions to default
 */
const resetWindows = () => {
    try {
        const userSettings = settings.loadSettings();

        // Reset window bounds to default
        const defaultSettings = settings.getDefaultSettings();
        userSettings.windowBounds = defaultSettings.windowBounds;

        // Save the updated settings
        settings.saveSettings(userSettings);

        logger.withCategory('settings').success('Window positions reset to default');
    } catch (error) {
        logger.withCategory('settings').error('Error resetting window positions', error);
    }
};

/**
 * Main function to handle commands
 */
const main = async () => {
    try {
        logger.withCategory('api').debug('main: Function started', null);
        // Initialize headers for API calls
        initializeHeaders();
        logger.withCategory('api').debug('main: Headers initialized', null);
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
                logger.withCategory('voting').debug('About to start continuous voting', null);
                await startContinuousVoting();
                logger.withCategory('voting').debug('startContinuousVoting completed', null);
                // Don't exit for continuous mode - it keeps running
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
        // Clean up logger
        logger.cleanup();
    }
};

// Add global error handlers
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

// Run the main function
logger.withCategory('api').debug('About to call main() function', null);
main().catch((error) => {
    logger.withCategory('api').error('Error caught in main() call');
    logger.withCategory('error').debug('Main() call error details:', error);
    process.exit(1);
});
