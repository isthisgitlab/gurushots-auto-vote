#!/usr/bin/env node

/**
 * GUI Refresh Script
 * 
 * This script attempts to refresh the GUI window after CLI settings changes.
 * It tries to connect to the running Electron app and trigger a window reload.
 */

const { spawn } = require('child_process');

// Function to check if the Electron app is running
function isElectronRunning() {
    return new Promise((resolve) => {
        const process = spawn('pgrep', ['-f', 'electron.*gurushots-auto-vote'], { stdio: 'pipe' });
        
        process.on('close', (code) => {
            resolve(code === 0);
        });
        
        process.on('error', () => {
            resolve(false);
        });
    });
}

// Main function
async function refreshGui() {
    try {
        const isRunning = await isElectronRunning();
        
        if (!isRunning) {
            console.log('ℹ️  GUI is not currently running. Settings will be applied when you next start the app.');
            return;
        }
        
        console.log('🔄 GUI is running. To apply CLI settings changes:');
        console.log('   1. Go to the GUI window');
        console.log('   2. Press Ctrl+R (Windows/Linux) or Cmd+R (Mac) to refresh');
        console.log('   3. Or restart the GUI application');
        console.log('');
        console.log('💡 Tip: Changes to theme, language, and timezone require a GUI refresh to be visible.');
        
    } catch (error) {
        console.error('❌ Error checking GUI status:', error.message);
        console.log('ℹ️  If the GUI is running, refresh it manually (Ctrl+R / Cmd+R).');
    }
}

refreshGui();