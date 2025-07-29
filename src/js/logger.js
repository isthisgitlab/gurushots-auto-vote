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

// Check if we're actually running in an Electron app context
// process.type will be 'renderer' or 'main' in Electron apps
const isElectronApp = process.type === 'renderer' || process.type === 'main';

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
                fs.mkdirSync(userDataPath, {recursive: true});
            } catch {
                // Fallback to current directory if we can't create the proper path
                userDataPath = path.join(process.cwd(), 'userData');
                if (!fs.existsSync(userDataPath)) {
                    fs.mkdirSync(userDataPath, {recursive: true});
                }
            }
        }
    }

    return userDataPath;
};

// Create logs directory in the same location as settings
const logsDir = path.join(getUserDataPath(), 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, {recursive: true});
}

// Check if we're in development mode (not mock)
const isDevMode = process.env.NODE_ENV === 'development';

// Check if we're in CLI mode (not running in Electron app context)
const isCliMode = !isElectronApp;

// Get current date in YYYY-MM-DD format
const getCurrentDate = () => {
    return new Date().toISOString().split('T')[0];
};

// Get log file paths for current date
const getLogFilePaths = (date = getCurrentDate()) => {
    return {
        error: path.join(logsDir, `errors-${date}.log`),
        app: path.join(logsDir, `app-${date}.log`),
        api: path.join(logsDir, `api-${date}.log`),
    };
};

// Retention periods in days
const ERROR_RETENTION_DAYS = 30;
const GENERAL_RETENTION_DAYS = 7;
const API_RETENTION_DAYS = 1; // Only keep API logs for 1 day in dev mode

// Maximum file sizes in MB
const MAX_ERROR_LOG_SIZE = 10; // 10 MB
const MAX_APP_LOG_SIZE = 50;   // 50 MB
const MAX_API_LOG_SIZE = 20;   // 20 MB

// Parse date from filename (e.g., "errors-2025-07-28.log" -> "2025-07-28")
const parseDateFromFilename = (filename) => {
    const match = filename.match(/(errors|app|api)-(\d{4}-\d{2}-\d{2})\.log$/);
    return match ? match[2] : null;
};

// Check if a date is older than specified days
const isDateOlderThan = (dateString, days) => {
    const fileDate = new Date(dateString);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    return fileDate < cutoffDate;
};


const cleanupOldLogs = () => {
    try {
        const files = fs.readdirSync(logsDir);
        const now = new Date();

        files.forEach(file => {
            const filePath = path.join(logsDir, file);
            const stats = fs.statSync(filePath);
            const fileSizeMB = stats.size / (1024 * 1024);

            let shouldDelete = false;
            let reason = '';

            // Parse date from filename
            const fileDate = parseDateFromFilename(file);

            if (fileDate) {
                // Determine retention based on file type
                if (file.startsWith('errors-')) {
                    shouldDelete = isDateOlderThan(fileDate, ERROR_RETENTION_DAYS) || fileSizeMB > MAX_ERROR_LOG_SIZE;
                    reason = isDateOlderThan(fileDate, ERROR_RETENTION_DAYS) ? 'age' : 'size';
                } else if (file.startsWith('app-')) {
                    shouldDelete = isDateOlderThan(fileDate, GENERAL_RETENTION_DAYS) || fileSizeMB > MAX_APP_LOG_SIZE;
                    reason = isDateOlderThan(fileDate, GENERAL_RETENTION_DAYS) ? 'age' : 'size';
                } else if (file.startsWith('api-')) {
                    shouldDelete = isDateOlderThan(fileDate, API_RETENTION_DAYS) || fileSizeMB > MAX_API_LOG_SIZE;
                    reason = isDateOlderThan(fileDate, API_RETENTION_DAYS) ? 'age' : 'size';
                }
            } else if (file.startsWith('api-debug-')) {
                // Clean up old timestamped files
                const fileAge = now.getTime() - stats.mtime.getTime();
                shouldDelete = fileAge > (7 * 24 * 60 * 60 * 1000); // 7 days
                reason = 'age';
            }

            if (shouldDelete) {
                fs.unlinkSync(filePath);
                console.log(`Cleaned up old log file: ${file} (${reason}, ${fileSizeMB.toFixed(2)} MB)`);
            }
        });
    } catch (error) {
        console.error('Error during log cleanup:', error);
    }
};

// Write to log file with daily rotation
const writeToLogFile = (logFile, level, message, data = null) => {
    try {
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
    } catch (error) {
        console.error('Error writing to log file:', error);
    }
};

// Initialize cleanup on module load
cleanupOldLogs();

// Set up periodic cleanup (every hour) only in actual application contexts
let cleanupInterval;
if (typeof setInterval !== 'undefined' && (isElectronApp || (isCliMode && process.argv[1] && process.argv[1].includes('cli.js')))) {
    cleanupInterval = setInterval(cleanupOldLogs, 60 * 60 * 1000); // 1 hour
}


if (typeof process !== 'undefined') {
    process.on('exit', () => {
        if (cleanupInterval) {
            clearInterval(cleanupInterval);
        }
    });
}

// Get current log file paths
const currentLogFiles = getLogFilePaths();

// Export logger functions
module.exports = {
    // Error logging - 30 days retention
    error: (message, data) => writeToLogFile(currentLogFiles.error, 'ERROR', message, data),

    // General logging - 7 days retention
    info: (message, data) => writeToLogFile(currentLogFiles.app, 'INFO', message, data),
    debug: (message, data) => {
        // CLI mode: always log debug
        // GUI mode: only log debug in development
        if (isCliMode || isDevMode) {
            writeToLogFile(currentLogFiles.app, 'DEBUG', message, data);
        } else {
            // In GUI production mode, only log to console, not to file
            console.log(`[DEBUG] ${message}`);
        }
    },

    // API logging - only in dev mode, 1 day retention
    api: (message, data) => {
        if (isDevMode) {
            writeToLogFile(currentLogFiles.api, 'API', message, data);
        }
    },

    // Get current log file paths
    getLogFile: () => currentLogFiles.app,
    getErrorLogFile: () => currentLogFiles.error,
    getApiLogFile: () => currentLogFiles.api,

    // Get log files for a specific date
    getLogFileForDate: (date) => getLogFilePaths(date),

    // Manual cleanup function
    cleanup: cleanupOldLogs,
}; 