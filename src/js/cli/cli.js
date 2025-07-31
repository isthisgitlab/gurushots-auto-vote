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

// Import node-cron for scheduling
const cron = require('node-cron');
const readline = require('readline');

// Import the API factory (CLI respects the mock setting from GUI)
const {getMiddleware} = require('../apiFactory');
const settings = require('../settings');
const {getDefaultSettings} = require('../settings');

// Get the middleware instance - but don't destructure methods at module level
const getMiddlewareInstance = () => getMiddleware();
const {initializeHeaders} = require('../api/randomizer');

// Import logger for cleanup
const logger = require('../logger');

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
 * Display help information
 */
const showHelp = () => {
    const userSettings = settings.loadSettings();
    const isMockMode = userSettings.mock;
    
    console.log(`
GuruShots Auto Voter - CLI ${isMockMode ? '(MOCK MODE)' : '(REAL MODE)'}

Usage: <command>

Commands:
  login    - Authenticate with GuruShots and save token
  vote     - Start the voting process (requires authentication)
  start    - Start continuous voting with cron scheduling
  stop     - Stop continuous voting (if running)
  status   - Show current status and settings
  get-setting <key> - Get a setting value
  set-setting <key> <value> - Set a setting value
  list-settings - Show all settings and their values
  reset-setting <key> - Reset a setting to default
  reset-all-settings - Reset all settings to defaults
  help-settings - Show detailed settings help
  reset-windows  - Reset window positions to default
  help     - Show this help message

Examples:
  login
  vote
  start
  reset-windows

Note: You must login first before you can vote.
      The 'start' command will run continuously until stopped.
      Voting interval adjusts dynamically based on challenge states.
      Use 'get-setting checkFrequency' to view normal frequency, 'set-setting checkFrequency 5' to change.
      Current mode: ${isMockMode ? 'MOCK (simulated API calls)' : 'REAL (live API calls)'}
    `);
};

/**
 * Handle login with mock mode option
 */
const handleLogin = async () => {
    const rl = createReadlineInterface();
    
    try {
        logger.cliInfo('=== GuruShots Auto Voter - Login ===');
        
        // Check current mock setting
        const userSettings = settings.loadSettings();
        const currentMockMode = userSettings.mock;
        
        logger.cliInfo(`Current mode: ${currentMockMode ? 'MOCK' : 'REAL'}`);
        
        // Ask if user wants to change the mode
        const changeMode = await askYesNo('Do you want to change the mode?', rl);
        
        let useMockMode = currentMockMode;
        
        if (changeMode) {
            logger.cliInfo('Mode options:');
            logger.cliInfo('  REAL  - Connect to actual GuruShots API (production)');
            logger.cliInfo('  MOCK  - Simulate API calls for testing (development)');
            
            const useMock = await askYesNo('Use MOCK mode?', rl);
            useMockMode = useMock;
            
            // Update the setting
            settings.setSetting('mock', useMockMode);
            logger.cliSuccess(`Mode changed to: ${useMockMode ? 'MOCK' : 'REAL'}`);
        }
        
        // Get credentials
        const email = await askInput('\nEnter your GuruShots email: ', rl);
        const password = await askInput('Enter your GuruShots password: ', rl);
        
        logger.startOperation('login-auth', 'Authenticating with GuruShots');
        
        // Get fresh middleware instance with updated settings
        const {refreshApi} = require('../apiFactory');
        refreshApi();
        const middleware = getMiddlewareInstance();
        
        // Attempt login
        const loginResult = await middleware.cliLogin(email, password);
        
        if (loginResult.success) {
            logger.endOperation('login-auth', 'Login successful');
            logger.cliSuccess(`Token saved for ${useMockMode ? 'MOCK' : 'REAL'} mode`);
        } else {
            logger.endOperation('login-auth', null, loginResult.error || 'Unknown error');
        }
        
    } catch (error) {
        logger.cliError('Login error', error.message || error);
    } finally {
        rl.close();
    }
};

/**
 * Run a single voting cycle
 */
const runVotingCycle = async (cycleNumber = 1) => {
    try {
        const userSettings = settings.loadSettings();
        const isMockMode = userSettings.mock;
        
        logger.cliInfo(`--- Voting Cycle ${cycleNumber} (${isMockMode ? 'MOCK' : 'REAL'} MODE) ---`);
        logger.cliInfo(`Time: ${new Date().toLocaleString()}`);

        // Check if user is authenticated
        if (!getMiddlewareInstance().isAuthenticated()) {
            logger.cliError('No authentication token found. Please login first');
            logger.cliInfo('Run: login');
            return false;
        }

        // Start voting operation
        logger.startOperation(`vote-cycle-${cycleNumber}`, `Voting cycle ${cycleNumber}`);
        
        // Run the voting process with per-challenge exposure settings
        await getMiddlewareInstance().cliVote();
        
        logger.endOperation(`vote-cycle-${cycleNumber}`, `Voting cycle ${cycleNumber} completed`);
        return true;
    } catch (error) {
        logger.cliError(`Error during voting cycle ${cycleNumber}`, error.message || error);
        return false;
    }
};

/**
 * Start continuous voting with dynamic interval scheduling
 */
const startContinuousVoting = async () => {
    const userSettings = settings.loadSettings();
    const isMockMode = userSettings.mock;
    
    logger.cliInfo(`=== Starting Continuous Voting Mode (${isMockMode ? 'MOCK' : 'REAL'} MODE) ===`);

    // Check if user is authenticated
    if (!getMiddlewareInstance().isAuthenticated()) {
        logger.cliError('No authentication token found. Please login first');
        logger.cliInfo('Run: login');
        return;
    }

    let cycleCount = 0;
    let isRunning = true;

    // Function to handle graceful shutdown
    const handleShutdown = () => {
        logger.cliInfo('🛑 Shutting down continuous voting...');
        isRunning = false;
        process.exit(0);
    };

    // Set up signal handlers for graceful shutdown
    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);

    // Run initial cycle
    logger.cliInfo('🚀 Running initial voting cycle...');
    await runVotingCycle(++cycleCount);

    // Get cron expression from CLI-specific setting
    const cronExpression = settings.getSetting('cliCronExpression') || getDefaultSettings().cliCronExpression;
    
    // Set up cron job using the setting
    const cronJob = cron.schedule(cronExpression, async () => {
        if (!isRunning) {
            cronJob.stop();
            return;
        }

        try {
            await runVotingCycle(++cycleCount);
        } catch (error) {
            logger.cliError('Error in scheduled voting cycle', error);
        }
    }, {
        scheduled: false,
    });

    // Start the cron job
    cronJob.start();
    logger.cliSuccess(`Continuous voting started with cron expression: ${cronExpression}`);
    logger.cliInfo('Press Ctrl+C to stop');

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
    
    logger.cliInfo('=== GuruShots Auto Voter - Status ===');
    
    logger.cliInfo(`Mode: ${isMockMode ? 'MOCK (simulated API calls)' : 'REAL (live API calls)'}`);
    logger.cliInfo(`Authentication: ${isAuthenticated ? '✅ Authenticated' : '❌ Not authenticated'}`);
    
    if (isAuthenticated) {
        logger.cliInfo(`Token: ${userSettings.token ? '✅ Present' : '❌ Missing'}`);
    }
    
    logger.cliInfo('\nSettings:');
    logger.cliInfo(`  Theme: ${userSettings.theme || 'default'}`);
    logger.cliInfo(`  Language: ${userSettings.language || 'en'}`);
    logger.cliInfo(`  Timezone: ${userSettings.timezone || 'local'}`);
    logger.cliInfo(`  API Timeout: ${userSettings.apiTimeout || getDefaultSettings().apiTimeout}s`);
    logger.cliInfo(`  Check Frequency: ${userSettings.checkFrequency || getDefaultSettings().checkFrequency}min`);
    logger.cliInfo(`  Last Minute Check Frequency: ${settings.getEffectiveSetting('lastMinuteCheckFrequency', 'global') || 1}min`);
    logger.cliInfo(`  CLI Cron Expression: ${userSettings.cliCronExpression || getDefaultSettings().cliCronExpression}`);
    
    // Show challenge settings if any exist
    if (userSettings.challengeSettings && Object.keys(userSettings.challengeSettings).length > 0) {
        logger.cliInfo('\nChallenge Settings:');
        Object.entries(userSettings.challengeSettings).forEach(([challengeId, challengeSettings]) => {
            logger.cliInfo(`  Challenge ${challengeId}:`);
            Object.entries(challengeSettings).forEach(([key, value]) => {
                logger.cliInfo(`    ${key}: ${value}`);
            });
        });
    }
    
    logger.cliInfo('\nTo change mode, run: login');
};

/**
 * Get a setting value
 */
const getSetting = (key) => {
    try {
        const value = settings.getSetting(key);
        if (value === undefined) {
            logger.cliError(`Setting '${key}' not found`);
            return;
        }
        logger.cliInfo(`${key}: ${JSON.stringify(value)}`);
    } catch (error) {
        logger.cliError(`Error getting setting '${key}'`, error.message);
    }
};

/**
 * Set a setting value
 */
const setSetting = (key, value) => {
    try {
        // Parse value if it looks like JSON
        let parsedValue = value;
        if (value === 'true') parsedValue = true;
        else if (value === 'false') parsedValue = false;
        else if (!isNaN(value) && value !== '') parsedValue = Number(value);
        else if (value.startsWith('[') || value.startsWith('{')) {
            try {
                parsedValue = JSON.parse(value);
            } catch {
                // Keep as string if JSON parsing fails
            }
        }

        settings.setSetting(key, parsedValue);
        logger.cliSuccess(`Set ${key} = ${JSON.stringify(parsedValue)}`);
    } catch (error) {
        logger.cliError(`Error setting '${key}'`, error.message);
    }
};

/**
 * List all settings and their values
 */
const listSettings = () => {
    try {
        const userSettings = settings.loadSettings();
        const defaultSettings = getDefaultSettings();
        
        logger.cliInfo('=== All Settings ===');
        
        // Get all possible setting keys (user settings + defaults)
        const allKeys = new Set([
            ...Object.keys(userSettings),
            ...Object.keys(defaultSettings),
        ]);
        
        // Sort keys for consistent output
        const sortedKeys = Array.from(allKeys).sort();
        
        sortedKeys.forEach(key => {
            const currentValue = userSettings[key];
            const defaultValue = defaultSettings[key];
            const isModified = JSON.stringify(currentValue) !== JSON.stringify(defaultValue);
            
            logger.cliInfo(`${key}:`);
            logger.cliInfo(`  Current: ${JSON.stringify(currentValue)}`);
            logger.cliInfo(`  Default: ${JSON.stringify(defaultValue)}`);
            if (isModified) {
                logger.cliInfo('  Status:  Modified ✏️');
            } else {
                logger.cliInfo('  Status:  Default ✅');
            }
            logger.cliInfo('');
        });
        
        logger.cliInfo('💡 Use "help-settings" for detailed information about each setting');
    } catch (error) {
        logger.cliError('Error listing settings', error.message);
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
            logger.cliError(`Setting '${key}' not found in defaults`);
            return;
        }
        
        settings.setSetting(key, defaultValue);
        logger.cliSuccess(`Reset ${key} to default: ${JSON.stringify(defaultValue)}`);
    } catch (error) {
        logger.cliError(`Error resetting setting '${key}'`, error.message);
    }
};

/**
 * Reset all settings to defaults
 */
const resetAllSettings = () => {
    try {
        const defaultSettings = getDefaultSettings();
        
        // Reset all settings to defaults
        Object.keys(defaultSettings).forEach(key => {
            settings.setSetting(key, defaultSettings[key]);
        });
        
        logger.cliSuccess('All settings reset to defaults');
        logger.cliInfo('💡 Run "list-settings" to see all current values');
    } catch (error) {
        logger.cliError('Error resetting all settings', error.message);
    }
};

/**
 * Show detailed help about settings
 */
const helpSettings = () => {
    console.log(`
=== Settings Management Help ===

Available Commands:
  get-setting <key>     - Get current value of a setting
  set-setting <key> <value> - Set a setting value
  list-settings         - Show all settings and their values
  reset-setting <key>   - Reset a setting to its default value
  reset-all-settings    - Reset all settings to defaults
  help-settings         - Show this help message

Common Settings:
  cliCronExpression     - Cron expression for continuous voting (default: "*/3 * * * *")
  apiTimeout           - API request timeout in seconds (default: 30)
  checkFrequency       - Check frequency in minutes (default: 3)
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
  set-setting cliCronExpression "*/5 * * * *"
  set-setting apiTimeout 60
  set-setting mock true
  get-setting cliCronExpression
  reset-setting cliCronExpression

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
        
        logger.cliSuccess('Window positions reset to default');
    } catch (error) {
        logger.cliError('Error resetting window positions', error.message || error);
    }
};

/**
 * Main function to handle commands
 */
const main = async () => {
    try {
        // Initialize headers for API calls
        initializeHeaders();

        switch (command) {
        case 'login':
            await handleLogin();
            process.exit(0);
            break;
        case 'vote':
            await runVotingCycle();
            process.exit(0);
            break;
        case 'start':
            await startContinuousVoting();
            // Don't exit for continuous mode - it keeps running
            break;
        case 'status':
            showStatus();
            process.exit(0);
            break;
        case 'get-setting':
            if (!args[1]) {
                logger.cliError('Please specify a setting key');
                logger.cliInfo('Usage: get-setting <key>');
                process.exit(1);
            }
            getSetting(args[1]);
            process.exit(0);
            break;
        case 'set-setting':
            if (!args[1] || !args[2]) {
                logger.cliError('Please specify both key and value');
                logger.cliInfo('Usage: set-setting <key> <value>');
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
                logger.cliError('Please specify a setting key');
                logger.cliInfo('Usage: reset-setting <key>');
                process.exit(1);
            }
            resetSetting(args[1]);
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
                logger.cliInfo('No command specified. Use "help" to see available commands');
            } else {
                logger.cliError(`Unknown command: ${command}`);
                logger.cliInfo('Use "help" to see available commands');
            }
            process.exit(1);
            break;
        }
    } catch (error) {
        logger.cliError('Error', error.message || error);
        process.exit(1);
    } finally {
        // Clean up logger
        logger.cleanup();
    }
};

// Run the main function
main();