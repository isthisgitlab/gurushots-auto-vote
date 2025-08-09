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

// Import node-cron for scheduling
const cron = require('node-cron');
logger.withCategory('api').debug('cron imported', null);
const readline = require('readline');
logger.withCategory('api').debug('readline imported', null);

// Import the API factory (CLI respects the mock setting from GUI)
logger.withCategory('api').debug('About to import apiFactory', null);
const {getMiddleware} = require('../apiFactory');
logger.withCategory('api').debug('apiFactory imported', null);
const settings = require('../settings');
logger.withCategory('settings').debug('settings imported');
const {getDefaultSettings} = require('../settings');
logger.withCategory('settings').debug('getDefaultSettings imported');

// Get the middleware instance - but don't destructure methods at module level
const getMiddlewareInstance = () => getMiddleware();
logger.withCategory('api').debug('About to import randomizer', null);
const {initializeHeaders} = require('../api/randomizer');
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
        const password = await askInput('Enter your GuruShots password: ', rl);
        
        logger.withCategory('auth').startOperation('login-auth', 'Authenticating with GuruShots');
        
        // Get fresh middleware instance with updated settings
        const {refreshApi} = require('../apiFactory');
        refreshApi();
        const middleware = getMiddlewareInstance();
        
        // Attempt login
        const loginResult = await middleware.cliLogin(email, password);
        
        if (loginResult.success) {
            logger.withCategory('auth').endOperation('login-auth', 'Login successful');
            logger.withCategory('authentication').success(`Token saved for ${useMockMode ? 'MOCK' : 'REAL'} mode`);
        } else {
            logger.withCategory('auth').endOperation('login-auth', null, loginResult.error || 'Unknown error');
        }
        
    } catch (error) {
        logger.withCategory('authentication').error('Login error', error);
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
        
        logger.withCategory('voting').info(`--- Voting Cycle ${cycleNumber} (${isMockMode ? 'MOCK' : 'REAL'} MODE) ---`);
        logger.withCategory('voting').info(`Time: ${new Date().toLocaleString()}`);

        // Check if user is authenticated
        if (!getMiddlewareInstance().isAuthenticated()) {
            logger.withCategory('authentication').error('No authentication token found. Please login first');
            logger.withCategory('ui').info('Run: login');
            return false;
        }

        // Start voting operation
        logger.withCategory('voting').startOperation(`vote-cycle-${cycleNumber}`, `Voting cycle ${cycleNumber}`);
        
        // Run the voting process with per-challenge exposure settings
        await getMiddlewareInstance().cliVote();
        
        logger.withCategory('voting').endOperation(`vote-cycle-${cycleNumber}`, `Voting cycle ${cycleNumber} completed`);
        
        // Note: Threshold scheduling update will be handled by the calling function
        // since we need access to the threshold functions defined in startContinuousVoting
        
        return true;
    } catch (error) {
        logger.withCategory('voting').error(`Error during voting cycle ${cycleNumber}`, error);
        logger.withCategory('voting').debug('Full voting cycle error details:', error);
        return false;
    }
};

/**
 * Run a single manual voting cycle (votes to 100% regardless of settings)
 */
const runManualVotingCycle = async (cycleNumber = 1) => {
    try {
        const userSettings = settings.loadSettings();
        const isMockMode = userSettings.mock;
        
        logger.withCategory('voting').info(`--- Manual Voting Cycle ${cycleNumber} (${isMockMode ? 'MOCK' : 'REAL'} MODE) ---`);
        logger.withCategory('voting').info(`Time: ${new Date().toLocaleString()}`);
        logger.withCategory('voting').info('Mode: Manual (votes to 100% regardless of threshold settings)');

        // Check if user is authenticated
        if (!getMiddlewareInstance().isAuthenticated()) {
            logger.withCategory('authentication').error('No authentication token found. Please login first');
            logger.withCategory('ui').info('Run: login');
            return false;
        }

        // Start manual voting operation
        logger.withCategory('voting').startOperation(`manual-vote-cycle-${cycleNumber}`, `Manual voting cycle ${cycleNumber}`);
        
        // Run the manual voting process (bypasses all thresholds, always votes to 100%)
        await getMiddlewareInstance().cliVoteManual();
        
        logger.withCategory('voting').endOperation(`manual-vote-cycle-${cycleNumber}`, `Manual voting cycle ${cycleNumber} completed`);
        
        return true;
    } catch (error) {
        logger.withCategory('voting').error(`Error during manual voting cycle ${cycleNumber}`, error);
        logger.withCategory('voting').debug('Full manual voting cycle error details:', error);
        return false;
    }
};

/**
 * Start continuous voting with dynamic interval scheduling
 */
const startContinuousVoting = async () => {
    logger.withCategory('voting').debug('startContinuousVoting: Function entered', null);
    const userSettings = settings.loadSettings();
    logger.withCategory('settings').debug('startContinuousVoting: Settings loaded');
    const isMockMode = userSettings.mock;
    
    logger.withCategory('voting').info(`=== Starting Continuous Voting Mode (${isMockMode ? 'MOCK' : 'REAL'} MODE) ===`);

    // Check if user is authenticated
    if (!getMiddlewareInstance().isAuthenticated()) {
        logger.withCategory('authentication').error('No authentication token found. Please login first');
        logger.withCategory('ui').info('Run: login');
        return;
    }

    let cycleCount = 0;
    let isRunning = true;
    let thresholdScheduler = null; // For scheduling threshold cron changes
    let currentScheduledChallenge = null; // Track currently scheduled challenge to prevent duplicates
    let lastSettingsHash = null; // Track settings changes
    let currentCronJob = null; // Track current cron job

    // Function to handle graceful shutdown
    const handleShutdown = () => {
        logger.withCategory('voting').info('🛑 Shutting down continuous voting...');
        isRunning = false;
        
        // Clear threshold scheduler
        if (thresholdScheduler) {
            clearTimeout(thresholdScheduler);
            thresholdScheduler = null;
        }
        
        // Stop cron job
        if (currentCronJob) {
            currentCronJob.stop();
        }
        
        process.exit(0);
    };

    // Set up signal handlers for graceful shutdown
    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);

    /**
     * Calculate when the next challenge will enter the last threshold period
     */
    const calculateNextLastThresholdEntry = async (challenges, now) => {
        let nextEntry = null;
        let earliestEntryTime = Infinity;

        for (const challenge of challenges) {
            // Skip flash challenges and ended challenges
            if (challenge.type === 'flash' || challenge.close_time <= now) {
                continue;
            }

            const effectiveLastMinuteThreshold = settings.getEffectiveSetting('lastMinuteThreshold', challenge.id.toString());
            const thresholdEntryTime = challenge.close_time - (effectiveLastMinuteThreshold * 60);

            // Only consider future entries
            if (thresholdEntryTime > now && thresholdEntryTime < earliestEntryTime) {
                earliestEntryTime = thresholdEntryTime;
                nextEntry = {
                    challengeId: challenge.id,
                    challengeTitle: challenge.title,
                    entryTime: thresholdEntryTime,
                    lastMinuteThreshold: effectiveLastMinuteThreshold,
                };
            }
        }

        return nextEntry;
    };

    /**
     * Schedule a cron change when a challenge enters the last threshold period
     */
    const scheduleThresholdCronChange = async (nextEntry) => {
        if (!nextEntry || !isRunning) {
            return;
        }

        // Check if we're already scheduling the same challenge
        if (currentScheduledChallenge && 
            currentScheduledChallenge.challengeId === nextEntry.challengeId &&
            currentScheduledChallenge.entryTime === nextEntry.entryTime) {
            logger.withCategory('voting').debug(`⏰ Already scheduling threshold change for challenge "${nextEntry.challengeTitle}", skipping duplicate`);
            return;
        }

        const now = Math.floor(Date.now() / 1000);
        const timeUntilEntry = (nextEntry.entryTime - now) * 1000; // Convert to milliseconds

        // Only schedule if the entry time is in the future
        if (timeUntilEntry <= 0) {
            logger.withCategory('voting').debug(`⏰ Threshold entry time for challenge "${nextEntry.challengeTitle}" has already passed, skipping`);
            return;
        }

        logger.withCategory('voting').info(`⏰ Scheduling threshold cron change for challenge "${nextEntry.challengeTitle}" in ${Math.round(timeUntilEntry / 1000)} seconds`);

        // Clear any existing scheduler
        if (thresholdScheduler) {
            clearTimeout(thresholdScheduler);
            thresholdScheduler = null;
        }

        // Track the currently scheduled challenge
        currentScheduledChallenge = {
            challengeId: nextEntry.challengeId,
            challengeTitle: nextEntry.challengeTitle,
            entryTime: nextEntry.entryTime,
            lastMinuteThreshold: nextEntry.lastMinuteThreshold,
        };

        // Schedule the cron change
        thresholdScheduler = setTimeout(async () => {
            if (isRunning) {
                logger.withCategory('voting').info(`⏰ Threshold entry time reached for challenge "${nextEntry.challengeTitle}", switching to last threshold frequency`);
                
                // Stop current cron job
                if (currentCronJob) {
                    currentCronJob.stop();
                }

                // Create new cron job with last threshold frequency
                const lastMinuteCheckFrequency = settings.getEffectiveSetting('lastMinuteCheckFrequency', 'global');
                const thresholdCronExpression = `*/${lastMinuteCheckFrequency} * * * *`;

                currentCronJob = cron.schedule(thresholdCronExpression, async () => {
                    if (!isRunning) {
                        currentCronJob.stop();
                        return;
                    }

                    try {
                        await runVotingCycle(++cycleCount);
                        
                        // Update threshold scheduling after each voting cycle
                        await updateThresholdScheduling();
                    } catch (error) {
                        logger.withCategory('voting').error('Error in scheduled voting cycle');
                        logger.withCategory('voting').debug('Full threshold cron error details:', error);
                    }
                }, {
                    scheduled: false,
                });

                currentCronJob.start();
                logger.withCategory('voting').info(`⏰ Switched to last threshold cron: ${thresholdCronExpression} (every ${lastMinuteCheckFrequency} minutes)`);
                
                // Clear the scheduled challenge tracking
                currentScheduledChallenge = null;
                
                // Update threshold scheduling for the next potential entry
                await updateThresholdScheduling();
            }
        }, timeUntilEntry);
    };

    /**
     * Update threshold scheduling based on current challenges
     */
    const updateThresholdScheduling = async () => {
        logger.withCategory('voting').debug('updateThresholdScheduling: Function entered', null);
        if (!isRunning) {
            logger.withCategory('voting').debug('updateThresholdScheduling: Not running, returning', null);
            return;
        }

        try {
            logger.withCategory('challenges').debug('updateThresholdScheduling: About to get active challenges', null);
            // Get current challenges
            const challengesResponse = await getMiddlewareInstance().getActiveChallenges();
            logger.withCategory('api').debug(`updateThresholdScheduling: Got response, type: ${typeof challengesResponse}`, null);
            const challenges = challengesResponse?.challenges || [];
            logger.withCategory('challenges').debug(`updateThresholdScheduling: Extracted challenges array, length: ${challenges.length}`, null);
            const now = Math.floor(Date.now() / 1000);
            logger.withCategory('voting').debug(`updateThresholdScheduling: Current timestamp: ${now}`, null);

            // Check if settings have changed (relevant settings for threshold scheduling)
            logger.withCategory('settings').debug('updateThresholdScheduling: About to get settings');
            const lastMinuteCheckFrequency = settings.getEffectiveSetting('lastMinuteCheckFrequency', 'global');
            logger.withCategory('settings').debug(`updateThresholdScheduling: Got lastMinuteCheckFrequency: ${lastMinuteCheckFrequency}`, null);
            const lastMinuteThreshold = settings.getEffectiveSetting('lastMinuteThreshold', 'global');
            logger.withCategory('settings').debug(`updateThresholdScheduling: Got lastMinuteThreshold: ${lastMinuteThreshold}`, null);
            
            const currentSettingsHash = JSON.stringify({
                lastMinuteCheckFrequency,
                lastMinuteThreshold,
            });
            logger.withCategory('settings').debug(`updateThresholdScheduling: Created settings hash: ${currentSettingsHash.length} chars`);
            logger.withCategory('settings').debug(`updateThresholdScheduling: lastSettingsHash is: ${lastSettingsHash}`);
            logger.withCategory('settings').debug('updateThresholdScheduling: About to compare settings hashes');
            
            if (lastSettingsHash !== null && lastSettingsHash !== currentSettingsHash) {
                logger.withCategory('settings').info('⏰ Settings changed, clearing existing threshold scheduler');
                if (thresholdScheduler) {
                    clearTimeout(thresholdScheduler);
                    thresholdScheduler = null;
                }
                currentScheduledChallenge = null;
            }
            lastSettingsHash = currentSettingsHash;

            const nextEntry = await calculateNextLastThresholdEntry(challenges, now);
            
            if (nextEntry) {
                await scheduleThresholdCronChange(nextEntry);
            } else {
                // Clear any existing scheduler if no upcoming entries
                if (thresholdScheduler) {
                    clearTimeout(thresholdScheduler);
                    thresholdScheduler = null;
                    currentScheduledChallenge = null;
                    logger.withCategory('voting').info('⏰ No upcoming threshold entries, cleared threshold scheduler');
                }
            }
        } catch (error) {
            logger.withCategory('voting').warning('Error updating threshold scheduling:');
            logger.withCategory('voting').debug('updateThresholdScheduling error details:', error);
        }
    };

    // Run initial cycle
    logger.withCategory('voting').info('🚀 Running initial voting cycle...');
    await runVotingCycle(++cycleCount);

    // Set up initial cron job with normal frequency
    const normalCronExpression = settings.getSetting('cliCronExpression') || getDefaultSettings().cliCronExpression;
    
    currentCronJob = cron.schedule(normalCronExpression, async () => {
        if (!isRunning) {
            currentCronJob.stop();
            return;
        }

        try {
            await runVotingCycle(++cycleCount);
            
            // Update threshold scheduling after each voting cycle
            await updateThresholdScheduling();
        } catch (error) {
            logger.withCategory('voting').error('Error in scheduled voting cycle');
            logger.withCategory('voting').debug('Full normal cron error details:', error);
        }
    }, {
        scheduled: false,
    });

    // Start the cron job
    currentCronJob.start();
    logger.withCategory('voting').success(`Continuous voting started with cron expression: ${normalCronExpression}`);
    logger.withCategory('ui').info('Press Ctrl+C to stop');

    // Set up proactive threshold scheduling
    await updateThresholdScheduling();

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
    logger.withCategory('authentication').info(`Authentication: ${isAuthenticated ? '✅ Authenticated' : '❌ Not authenticated'}`);
    
    if (isAuthenticated) {
        logger.withCategory('authentication').info(`Token: ${userSettings.token ? '✅ Present' : '❌ Missing'}`);
    }
    
    logger.withCategory('settings').info('\nSettings:');
    logger.withCategory('settings').info(`  Theme: ${userSettings.theme}`);
    logger.withCategory('settings').info(`  Language: ${userSettings.language}`);
    logger.withCategory('settings').info(`  Timezone: ${userSettings.timezone}`);
    logger.withCategory('settings').info(`  API Timeout: ${userSettings.apiTimeout}s`);
    logger.withCategory('settings').info(`  Check Frequency: ${userSettings.checkFrequency}min`);
    logger.withCategory('settings').info(`  Last Minute Check Frequency: ${settings.getEffectiveSetting('lastMinuteCheckFrequency', 'global') || 1}min`);
    logger.withCategory('settings').info(`  CLI Cron Expression: ${userSettings.cliCronExpression}`);
    
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
        // Parse value appropriately
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

        // Check if this is a valid schema setting
        const schema = settings.SETTINGS_SCHEMA;
        if (!schema[key]) {
            logger.withCategory('settings').error(`Unknown schema setting '${key}'`);
            logger.withCategory('settings').info('Available settings:');
            Object.keys(schema).forEach(settingKey => {
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
            logger.withCategory('settings').info(`Setting info: ${config.type} type, default: ${JSON.stringify(config.default)}`);
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
        Object.keys(defaultSettings).forEach(key => {
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
            await runManualVotingCycle();
            process.exit(0);
            break;
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
main().catch(error => {
    logger.withCategory('api').error('Error caught in main() call');
    logger.withCategory('error').debug('Main() call error details:', error);
    process.exit(1);
});