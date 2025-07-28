#!/usr/bin/env node

/**
 * GuruShots Auto Voter - Mock CLI Entry Point
 * 
 * This script provides a command-line interface for testing the mock functionality.
 * It can run in two modes:
 * 1. Single execution mode: Run once and exit
 * 2. Continuous mode: Run with cron scheduling every 3 minutes
 * 
 * The application:
 * 1. Runs immediately on startup to process current challenges
 * 2. Sets up a cron job to run every 3 minutes to continue voting
 * 3. Keeps track of voting attempts with a counter
 * 
 * This is a MOCK version that simulates API calls without making real requests.
 */

// Import node-cron for scheduling
const cron = require('node-cron');

// Import the API factory (Mock CLI always uses mock API by forcing mock=true)
const { getMiddleware } = require('../apiFactory');
const settings = require('../settings');

// Ensure Mock CLI always uses mock API regardless of settings
settings.setSetting('mock', true);

// Get the middleware instance - but don't destructure methods at module level
const getMiddlewareInstance = () => getMiddleware();

// Import logger for cleanup
const logger = require('../logger');

// Get command line arguments
const args = process.argv.slice(2);
const command = args[0];

/**
 * Display help information
 */
const showHelp = () => {
    console.log(`
GuruShots Auto Voter - Mock CLI

Usage: node mock-cli.js <command>

Commands:
  login    - Mock authentication with GuruShots (accepts any email/password)
  vote     - Start the mock voting process (requires authentication)
  start    - Start continuous mock voting with cron scheduling (every 3 minutes)
  stop     - Stop continuous voting (if running)
  status   - Show current status and settings
  help     - Show this help message

Examples:
  node mock-cli.js login
  node mock-cli.js vote
  node mock-cli.js start

Note: This is a MOCK version that simulates API calls without making real requests.
      You must login first before you can vote.
      The 'start' command will run continuously until stopped.
    `);
};

/**
 * Run a single mock voting cycle
 */
const runMockVotingCycle = async (cycleNumber = 1) => {
    try {
        console.log(`--- Mock Voting Cycle ${cycleNumber} ---`);
        console.log(`Time: ${new Date().toLocaleString()}`);
        
        // Check if user is authenticated
        if (!getMiddlewareInstance().isAuthenticated()) {
            console.error('No authentication token found. Please login first.');
            console.log('Run: node mock-cli.js login');
            return false;
        }
        
        // Run the mock voting process
        await getMiddlewareInstance().cliVote();
        console.log(`--- Mock Voting Cycle ${cycleNumber} Completed ---\n`);
        return true;
    } catch (error) {
        console.error(`Error during mock voting cycle ${cycleNumber}:`, error.message || error);
        return false;
    }
};

/**
 * Start continuous mock voting with cron scheduling
 */
const startContinuousMockVoting = async () => {
    console.log('=== Starting Continuous Mock Voting Mode ===');
    
    // Check if user is authenticated
    if (!getMiddlewareInstance().isAuthenticated()) {
        console.error('No authentication token found. Please login first.');
        console.log('Run: node mock-cli.js login');
        process.exit(1);
    }
    
    // Load settings to check if mock mode is enabled
    const userSettings = settings.loadSettings();
    console.log('Mode: MOCK API (for testing/development)');
    console.log(`Stay logged in: ${userSettings.stayLoggedIn ? 'Yes' : 'No'}`);
    
    // Counter to track number of voting attempts
    let voteCounter = 0;
    
    // Cron interval: Run every 3 minutes
    // Format: second(optional) minute hour day-of-month month day-of-week
    const interval = '*/3 * * * *';
    
    console.log(`Scheduling mock voting every 3 minutes (${interval})`);
    console.log('Press Ctrl+C to stop continuous voting\n');
    
    // Create the scheduled task
    const task = cron.schedule(interval, () => {
        voteCounter += 1;
        runMockVotingCycle(voteCounter);
    });
    
    // Run immediately on startup
    console.log('--- Initial mock voting run ---');
    voteCounter += 1;
    await runMockVotingCycle(voteCounter);
    
    // Start the scheduled task
    task.start();
    
    // Keep the process running
    process.on('SIGINT', () => {
        console.log('\n=== Stopping Continuous Mock Voting ===');
        task.stop();
        console.log('Continuous mock voting stopped.');
        process.exit(0);
    });
    
    process.on('SIGTERM', () => {
        console.log('\n=== Stopping Continuous Mock Voting ===');
        task.stop();
        console.log('Continuous mock voting stopped.');
        process.exit(0);
    });
};

/**
 * Show current status
 */
const showMockStatus = () => {
    const userSettings = settings.loadSettings();
    const envInfo = settings.getEnvironmentInfo();
    
    console.log('=== GuruShots Auto Voter - Mock Status ===');
    console.log('Mode: MOCK API (for testing/development)');
    console.log(`Stay logged in: ${userSettings.stayLoggedIn ? 'Yes' : 'No'}`);
    console.log(`Theme: ${userSettings.theme}`);
    
    // Show environment information
    console.log(`Environment: ${envInfo.nodeEnv || 'development'}`);
    console.log(`Mock Setting: ${envInfo.defaultMock ? 'true (dev)' : 'false (prod)'}`);
    
    // Show userData path information
    const userDataPath = settings.getUserDataPath();
    console.log(`Settings location: ${userDataPath}`);
    
    if (getMiddlewareInstance().isAuthenticated()) {
        const token = userSettings.token;
        const tokenStart = token.substring(0, 6);
        const tokenEnd = token.substring(token.length - 4);
        const maskedLength = Math.max(0, token.length - 10);
        const maskedPart = '*'.repeat(maskedLength);
        
        console.log('Authentication: ✅ Mock logged in');
        console.log(`Token: ${tokenStart}${maskedPart}${tokenEnd}`);
        console.log('Token Type: MOCK (for testing)');
    } else {
        console.log('Authentication: ❌ Not logged in');
        console.log('Token: Not set');
    }
    
    console.log('\nTo login: node mock-cli.js login');
    console.log('To vote once: node mock-cli.js vote');
    console.log('To start continuous voting: node mock-cli.js start');
    console.log('\nNote: This is a MOCK version for testing only!');
};

/**
 * Main mock CLI function
 */
const main = async () => {
    try {
        // Run log cleanup on mock CLI startup
        logger.cleanup();
        
        switch (command) {
        case 'login':
            console.log('Starting mock login process...');
            await getMiddlewareInstance().cliLogin();
            process.exit(0);
            break;
                
        case 'vote':
            if (!getMiddlewareInstance().isAuthenticated()) {
                console.error('You must login first before voting.');
                console.log('Run: node mock-cli.js login');
                process.exit(1);
            }
            console.log('Starting single mock voting cycle...');
            await runMockVotingCycle(1);
            process.exit(0);
            break;
                
        case 'start':
            await startContinuousMockVoting();
            break;
                
        case 'status':
            showMockStatus();
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
                console.error('No command specified.');
            } else {
                console.error(`Unknown command: ${command}`);
            }
            console.log('Run "node mock-cli.js help" for usage information.');
            process.exit(1);
        }
    } catch (error) {
        console.error('Error:', error.message || error);
        process.exit(1);
    }
};

// Run the mock CLI if this file is executed directly
if (require.main === module) {
    main();
}

module.exports = { main, runMockVotingCycle, startContinuousMockVoting, showMockStatus }; 