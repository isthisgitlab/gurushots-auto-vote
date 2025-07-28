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
 * Requirements:
 * - Valid GuruShots authentication token in settings
 * - Node.js with required dependencies
 */

// Import node-cron for scheduling
const cron = require('node-cron');

// Import the real API directly (CLI always uses real API)
const realApi = require('../api/middleware');
const { fetchChallengesAndVote, cliLogin } = realApi;

// Get the middleware once to avoid recreation
const middleware = realApi;

// Import settings
const settings = require('../settings');

// Get command line arguments
const args = process.argv.slice(2);
const command = args[0];

/**
 * Display help information
 */
const showHelp = () => {
    console.log(`
GuruShots Auto Voter - CLI

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
    `);
};

/**
 * Run a single voting cycle
 */
const runVotingCycle = async (cycleNumber = 1) => {
    try {
        console.log(`--- Voting Cycle ${cycleNumber} ---`);
        console.log(`Time: ${new Date().toLocaleString()}`);
        
        // Check if user is authenticated
        if (!middleware.isAuthenticated()) {
            console.error('No authentication token found. Please login first.');
            console.log('Run: node cli.js login');
            return false;
        }
        
        // Get token from settings
        const userSettings = settings.loadSettings();
        const token = userSettings.token;
        
        // Run the voting process
        await fetchChallengesAndVote(token);
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
    console.log('=== Starting Continuous Voting Mode ===');
    
    // Check if user is authenticated
    if (!middleware.isAuthenticated()) {
        console.error('No authentication token found. Please login first.');
        console.log('Run: node cli.js login');
        process.exit(1);
    }
    
    // Load settings (CLI always uses real API)
    const userSettings = settings.loadSettings();
    console.log('Mode: REAL API (CLI mode)');
    console.log(`Stay logged in: ${userSettings.stayLoggedIn ? 'Yes' : 'No'}`);
    
    // Counter to track number of voting attempts
    let voteCounter = 0;
    
    // Cron interval: Run every 3 minutes
    // Format: second(optional) minute hour day-of-month month day-of-week
    const interval = '*/3 * * * *';
    
    console.log(`Scheduling voting every 3 minutes (${interval})`);
    console.log('Press Ctrl+C to stop continuous voting\n');
    
    // Create the scheduled task
    const task = cron.schedule(interval, () => {
        voteCounter += 1;
        runVotingCycle(voteCounter);
    });
    
    // Run immediately on startup
    console.log('--- Initial voting run ---');
    voteCounter += 1;
    await runVotingCycle(voteCounter);
    
    // Start the scheduled task
    task.start();
    
    // Keep the process running
    process.on('SIGINT', () => {
        console.log('\n=== Stopping Continuous Voting ===');
        task.stop();
        console.log('Continuous voting stopped.');
        process.exit(0);
    });
    
    process.on('SIGTERM', () => {
        console.log('\n=== Stopping Continuous Voting ===');
        task.stop();
        console.log('Continuous voting stopped.');
        process.exit(0);
    });
};

/**
 * Show current status
 */
const showStatus = () => {
    const userSettings = settings.loadSettings();
    
    console.log('=== GuruShots Auto Voter Status ===');
    console.log('Mode: REAL API (CLI mode)');
    console.log(`Stay logged in: ${userSettings.stayLoggedIn ? 'Yes' : 'No'}`);
    console.log(`Theme: ${userSettings.theme}`);
    
    // Show environment information
    console.log('Environment: CLI (real API mode)');
    console.log('Mock Setting: ignored (CLI forces real API)');
    
    // Show window bounds information
    const windowBounds = userSettings.windowBounds;
    if (windowBounds) {
        console.log('Window Bounds:');
        if (windowBounds.login) {
            console.log(`  Login: ${windowBounds.login.width}x${windowBounds.login.height} at (${windowBounds.login.x || 'auto'}, ${windowBounds.login.y || 'auto'})`);
        }
        if (windowBounds.main) {
            console.log(`  Main: ${windowBounds.main.width}x${windowBounds.main.height} at (${windowBounds.main.x || 'auto'}, ${windowBounds.main.y || 'auto'})`);
        }
    }
    
    // Show userData path information
    const userDataPath = settings.getUserDataPath();
    console.log(`Settings location: ${userDataPath}`);
    
    if (middleware.isAuthenticated()) {
        const token = userSettings.token;
        const tokenStart = token.substring(0, 6);
        const tokenEnd = token.substring(token.length - 4);
        const maskedLength = Math.max(0, token.length - 10);
        const maskedPart = '*'.repeat(maskedLength);
        
        console.log('Authentication: ✅ Logged in');
        console.log(`Token: ${tokenStart}${maskedPart}${tokenEnd}`);
        
        if (userSettings.token.startsWith('mock_')) {
            console.log('Token Type: MOCK (for testing)');
        } else {
            console.log('Token Type: PRODUCTION');
        }
    } else {
        console.log('Authentication: ❌ Not logged in');
        console.log('Token: Not set');
    }
    
    console.log('\nTo login: node cli.js login');
    console.log('To vote once: node cli.js vote');
    console.log('To start continuous voting: node cli.js start');
    console.log('\nNote: Mock mode is environment-dependent and cannot be overridden.');
};

/**
 * Main CLI function
 */
const main = async () => {
    try {
        switch (command) {
        case 'login':
            console.log('Starting login process...');
            await cliLogin();
            break;
                
        case 'vote':
            if (!middleware.isAuthenticated()) {
                console.error('You must login first before voting.');
                console.log('Run: node cli.js login');
                process.exit(1);
            }
            console.log('Starting single voting cycle...');
            await runVotingCycle(1);
            break;
                
        case 'start':
            await startContinuousVoting();
            break;
                
        case 'status':
            showStatus();
            break;
                
        case 'reset-windows': {
            console.log('Resetting window positions to default...');
            const defaultSettings = settings.getDefaultSettings();
            settings.saveSettings({ windowBounds: defaultSettings.windowBounds });
            console.log('Window positions reset successfully.');
            break;
        }
                
        case 'help':
        case '--help':
        case '-h':
            showHelp();
            break;
                
        default:
            if (!command) {
                console.error('No command specified.');
            } else {
                console.error(`Unknown command: ${command}`);
            }
            console.log('Run "node cli.js help" for usage information.');
            process.exit(1);
        }
    } catch (error) {
        console.error('Error:', error.message || error);
        process.exit(1);
    }
};

// Run the CLI if this file is executed directly
if (require.main === module) {
    main();
}

module.exports = { main, runVotingCycle, startContinuousVoting, showStatus }; 