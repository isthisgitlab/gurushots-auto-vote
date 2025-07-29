#!/usr/bin/env node

/**
 * GuruShots Auto Voter - CLI Entry Point
 *
 * This script provides a command-line interface for the GuruShots Auto Voter.
 * It can run in two modes:
 * 1. Single execution mode: Run once and exit
 * 2. Continuous mode: Run with cron scheduling every 3 minutes
 *
 * The application:
 * 1. Runs immediately on startup to process current challenges
 * 2. Sets up a cron job to run every 3 minutes to continue voting
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
        output: process.stdout
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

Usage: node cli.js <command>

Commands:
  login    - Authenticate with GuruShots and save token
  vote     - Start the voting process (requires authentication)
  start    - Start continuous voting with cron scheduling (every 3 minutes)
  stop     - Stop continuous voting (if running)
  status   - Show current status and settings
  reset-windows  - Reset window positions to default
  help     - Show this help message

Examples:
  node cli.js login
  node cli.js vote
  node cli.js start
  node cli.js reset-windows

Note: You must login first before you can vote.
      The 'start' command will run continuously until stopped.
      Current mode: ${isMockMode ? 'MOCK (simulated API calls)' : 'REAL (live API calls)'}
    `);
};

/**
 * Handle login with mock mode option
 */
const handleLogin = async () => {
    const rl = createReadlineInterface();
    
    try {
        console.log('=== GuruShots Auto Voter - Login ===\n');
        
        // Check current mock setting
        const userSettings = settings.loadSettings();
        const currentMockMode = userSettings.mock;
        
        console.log(`Current mode: ${currentMockMode ? 'MOCK' : 'REAL'}`);
        
        // Ask if user wants to change the mode
        const changeMode = await askYesNo('Do you want to change the mode?', rl);
        
        let useMockMode = currentMockMode;
        
        if (changeMode) {
            console.log('\nMode options:');
            console.log('  REAL  - Connect to actual GuruShots API (production)');
            console.log('  MOCK  - Simulate API calls for testing (development)');
            
            const useMock = await askYesNo('Use MOCK mode?', rl);
            useMockMode = useMock;
            
            // Update the setting
            settings.setSetting('mock', useMockMode);
            console.log(`\n✅ Mode changed to: ${useMockMode ? 'MOCK' : 'REAL'}`);
        }
        
        // Get credentials
        const email = await askInput('\nEnter your GuruShots email: ', rl);
        const password = await askInput('Enter your GuruShots password: ', rl);
        
        console.log('\n🔐 Authenticating...');
        
        // Get fresh middleware instance with updated settings
        const {refreshApi} = require('../apiFactory');
        refreshApi();
        const middleware = getMiddlewareInstance();
        
        // Attempt login
        const loginResult = await middleware.cliLogin(email, password);
        
        if (loginResult.success) {
            console.log('✅ Login successful!');
            console.log(`Token saved for ${useMockMode ? 'MOCK' : 'REAL'} mode.`);
        } else {
            console.error('❌ Login failed:', loginResult.error || 'Unknown error');
        }
        
    } catch (error) {
        console.error('❌ Login error:', error.message || error);
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
        
        console.log(`--- Voting Cycle ${cycleNumber} (${isMockMode ? 'MOCK' : 'REAL'} MODE) ---`);
        console.log(`Time: ${new Date().toLocaleString()}`);

        // Check if user is authenticated
        if (!getMiddlewareInstance().isAuthenticated()) {
            console.error('No authentication token found. Please login first.');
            console.log('Run: node cli.js login');
            return false;
        }

        // Get token from settings
        const token = userSettings.token;

        // Create a function to get the effective exposure setting for each challenge
        const getExposureThreshold = (challengeId) => {
            try {
                return settings.getEffectiveSetting('exposure', challengeId);
            } catch (error) {
                console.warn(`Error getting exposure setting for challenge ${challengeId}:`, error);
                return settings.SETTINGS_SCHEMA.exposure.default; // Fallback to schema default
            }
        };

        // Run the voting process with per-challenge exposure settings
        await getMiddlewareInstance().cliVote();
        console.log(`--- Voting Cycle ${cycleNumber} Completed ---\n`);
        return true;
    } catch (error) {
        console.error(`Error during voting cycle ${cycleNumber}:`, error.message || error);
        return false;
    }
};

/**
 * Start continuous voting with cron scheduling
 */
const startContinuousVoting = async () => {
    const userSettings = settings.loadSettings();
    const isMockMode = userSettings.mock;
    
    console.log(`=== Starting Continuous Voting Mode (${isMockMode ? 'MOCK' : 'REAL'} MODE) ===`);

    // Check if user is authenticated
    if (!getMiddlewareInstance().isAuthenticated()) {
        console.error('No authentication token found. Please login first.');
        console.log('Run: node cli.js login');
        return;
    }

    let cycleCount = 0;
    let isRunning = true;

    // Function to handle graceful shutdown
    const handleShutdown = () => {
        console.log('\n🛑 Shutting down continuous voting...');
        isRunning = false;
        process.exit(0);
    };

    // Set up signal handlers for graceful shutdown
    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);

    // Run initial cycle
    console.log('🚀 Running initial voting cycle...');
    await runVotingCycle(++cycleCount);

    // Set up cron job to run every 3 minutes
    const cronJob = cron.schedule('*/3 * * * *', async () => {
        if (!isRunning) {
            cronJob.stop();
            return;
        }

        try {
            await runVotingCycle(++cycleCount);
        } catch (error) {
            console.error('Error in scheduled voting cycle:', error);
        }
    }, {
        scheduled: false
    });

    // Start the cron job
    cronJob.start();
    console.log('⏰ Continuous voting started. Press Ctrl+C to stop.');

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
    
    console.log('=== GuruShots Auto Voter - Status ===\n');
    
    console.log(`Mode: ${isMockMode ? 'MOCK (simulated API calls)' : 'REAL (live API calls)'}`);
    console.log(`Authentication: ${isAuthenticated ? '✅ Authenticated' : '❌ Not authenticated'}`);
    
    if (isAuthenticated) {
        console.log(`Token: ${userSettings.token ? '✅ Present' : '❌ Missing'}`);
    }
    
    console.log(`\nSettings:`);
    console.log(`  Theme: ${userSettings.theme || 'default'}`);
    console.log(`  Language: ${userSettings.language || 'en'}`);
    console.log(`  Timezone: ${userSettings.timezone || 'local'}`);
    console.log(`  API Timeout: ${userSettings.apiTimeout || 30000}ms`);
    console.log(`  Voting Interval: ${userSettings.votingInterval || 3000}ms`);
    
    // Show challenge settings if any exist
    if (userSettings.challengeSettings && Object.keys(userSettings.challengeSettings).length > 0) {
        console.log(`\nChallenge Settings:`);
        Object.entries(userSettings.challengeSettings).forEach(([challengeId, challengeSettings]) => {
            console.log(`  Challenge ${challengeId}:`);
            Object.entries(challengeSettings).forEach(([key, value]) => {
                console.log(`    ${key}: ${value}`);
            });
        });
    }
    
    console.log('\nTo change mode, run: node cli.js login');
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
        
        console.log('✅ Window positions reset to default');
    } catch (error) {
        console.error('❌ Error resetting window positions:', error.message || error);
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
                    console.log('No command specified. Use "help" to see available commands.');
                } else {
                    console.log(`Unknown command: ${command}`);
                    console.log('Use "help" to see available commands.');
                }
                process.exit(1);
                break;
        }
    } catch (error) {
        console.error('❌ Error:', error.message || error);
        process.exit(1);
    } finally {
        // Clean up logger
        logger.cleanup();
    }
};

// Run the main function
main();