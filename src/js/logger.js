const fs = require('fs');
const path = require('path');
const os = require('os');

// Try to get Electron app (same logic as settings.js)
let electronApp;
try {
    electronApp = require('electron').app;
} catch {
    // Electron not available (CLI context)
}

// Get the same userData path that settings use
const getUserDataPath = () => {
    let userDataPath;
    
    if (electronApp && electronApp.getPath) {
        // Electron context - use app.getPath('userData')
        userDataPath = electronApp.getPath('userData');
    } else {
        // CLI context - create fallback userData path (same as settings.js)
        const appName = 'gurushots-auto-vote';
        
        // Use platform-specific paths
        switch (process.platform) {
        case 'darwin': // macOS
            userDataPath = path.join(os.homedir(), 'Library', 'Application Support', appName);
            break;
        case 'win32': // Windows
            userDataPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
            break;
        default: // Linux and others
            userDataPath = path.join(os.homedir(), '.config', appName);
            break;
        }
        
        // Ensure the directory exists
        if (!fs.existsSync(userDataPath)) {
            try {
                fs.mkdirSync(userDataPath, { recursive: true });
            } catch {
                // Fallback to current directory if we can't create the proper path
                userDataPath = path.join(process.cwd(), 'userData');
                if (!fs.existsSync(userDataPath)) {
                    fs.mkdirSync(userDataPath, { recursive: true });
                }
            }
        }
    }
    
    return userDataPath;
};

// Create logs directory in the same location as settings
const logsDir = path.join(getUserDataPath(), 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Create log file with timestamp
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = path.join(logsDir, `api-debug-${timestamp}.log`);

// Logger function
const logToFile = (level, message, data = null) => {
    const timestamp = new Date().toISOString();
    let logEntry = `[${timestamp}] [${level}] ${message}`;
    
    if (data) {
        if (typeof data === 'object') {
            logEntry += '\n' + JSON.stringify(data, null, 2);
        } else {
            logEntry += '\n' + data;
        }
    }
    
    logEntry += '\n' + '='.repeat(80) + '\n';
    
    // Write to file
    fs.appendFileSync(logFile, logEntry);
    
    // Also log to console for immediate feedback
    console.log(`[${level}] ${message}`);
};

// Export logger functions
module.exports = {
    info: (message, data) => logToFile('INFO', message, data),
    error: (message, data) => logToFile('ERROR', message, data),
    api: (message, data) => logToFile('API', message, data),
    debug: (message, data) => logToFile('DEBUG', message, data),
    getLogFile: () => logFile,
}; 