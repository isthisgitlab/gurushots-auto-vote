const fs = require('fs');
const path = require('path');
const os = require('os');

// ANSI color codes for CLI output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m',
    bgCyan: '\x1b[46m',
};

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

/**
 * Detect if we're running from source code vs built app
 * @returns {boolean} - True if running from source, false if built
 */
const isSourceCode = () => {
    // If we're in Electron and it's packaged, we're definitely built
    if (electronApp && electronApp.isPackaged) {
        return false;
    }
    
    // For CLI: check if we're running as a pkg binary
    if (process.pkg) {
        return false;
    }
    
    // Check if __dirname contains .asar (Electron packaged but somehow not detected)
    if (__dirname.includes('.asar')) {
        return false;
    }
    
    // If none of the above, assume we're running from source
    return true;
};

/**
 * Get the app name with environment suffix if needed
 * @returns {string} - App name with -dev suffix for source code
 */
const getAppName = () => {
    const baseAppName = 'gurushots-auto-vote';
    return isSourceCode() ? `${baseAppName}-dev` : baseAppName;
};

// Get the same userData path that settings use
const getUserDataPath = () => {
    let userDataPath;

    if (electronApp && electronApp.getPath) {
        // Electron context - use app.getPath('userData')
        // For source code, we need to modify the path to include -dev suffix
        userDataPath = electronApp.getPath('userData');
        if (isSourceCode()) {
            // Running from source code - append -dev to the base userData path
            userDataPath = userDataPath + '-dev';
        }
    } else {
        // CLI context - create fallback userData path (same as settings.js)
        const appName = getAppName();

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

// Check if we're in CLI mode vs GUI mode
// CLI mode: running directly from cli.js or when electron main process handles CLI commands
// GUI mode: electron main process handling GUI IPC calls
const isCliMode = !isElectronApp || (process.argv[1] && process.argv[1].includes('cli.js'));

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
        // Check if fs and path modules are available (they might not be in test environments)
        if (typeof require !== 'undefined') {
            const fs = require('fs');
            const path = require('path');
            
            // Check if logsDir exists and is accessible
            if (!fs.existsSync(logsDir)) {
                return;
            }
            
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
        }
    } catch (error) {
        // Silently ignore cleanup errors in test environments
        if (process.env.NODE_ENV !== 'test') {
            console.error('Error during log cleanup:', error);
        }
    }
};

// Context override for explicit context setting
let contextOverride = null;

/**
 * Set explicit context override (for IPC calls from GUI)
 */
const setContext = (context) => {
    contextOverride = context;
};

/**
 * Clear context override
 */
const clearContext = () => {
    contextOverride = null;
};

/**
 * Get context identifier (CLI/GUI)
 */
const getContext = () => {
    // Use explicit override if set
    if (contextOverride) {
        return contextOverride;
    }
    
    // Check if we're in a pure CLI environment (no Electron at all)
    if (!isElectronApp) {
        return 'CLI';
    }
    
    // If we're in Electron, check if we were started via CLI
    if (process.argv[1] && process.argv[1].includes('cli.js')) {
        return 'CLI';
    }
    
    // Default for Electron main process is GUI
    return 'GUI';
};

/**
 * Get timestamp in HH:MM:SS format
 */
const getTimeString = () => {
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
};

/**
 * Apply color to text (only in CLI mode)
 */
const colorize = (text, color) => {
    if (!isCliMode || !process.stdout.isTTY) {
        return text;
    }
    return `${colors[color]}${text}${colors.reset}`;
};

/**
 * Format console output with context and colors
 */
const formatConsoleMessage = (level, message, context = getContext(), timestamp = getTimeString()) => {
    const levelColors = {
        'INFO': 'blue',
        'SUCCESS': 'green',
        'WARNING': 'yellow',
        'ERROR': 'red',
        'DEBUG': 'gray',
        'API': 'cyan',
        'PROGRESS': 'magenta',
    };

    const color = levelColors[level] || 'white';
    const coloredLevel = colorize(`[${level}]`, color);
    const coloredContext = colorize(`[${context}]`, 'cyan');
    const coloredTime = colorize(`[${timestamp}]`, 'gray');

    return `${coloredContext} ${coloredTime} ${coloredLevel} ${message}`;
};

/**
 * Write to log file with enhanced formatting
 */
const writeToLogFile = (logFile, level, message, data = null, context = getContext()) => {
    try {
        const timestamp = new Date().toISOString();
        let logEntry = `[${timestamp}] [${context}] [${level}] ${message}`;

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

        // Also log to console with formatting
        console.log(formatConsoleMessage(level, message, context));
    } catch (error) {
        console.error('Error writing to log file:', error);
    }
};

/**
 * Enhanced logging with operation tracking
 */
const logWithOperation = (level, operation, message, data = null, duration = null) => {
    let formattedMessage = message;
    
    if (operation) {
        formattedMessage = `${operation}: ${message}`;
    }
    
    if (duration !== null) {
        formattedMessage += ` ${colorize(`(${duration}ms)`, 'dim')}`;
    }
    
    const logFile = level === 'ERROR' ? currentLogFiles.error : 
        level === 'API' ? currentLogFiles.api : currentLogFiles.app;
    
    writeToLogFile(logFile, level, formattedMessage, data);
};

/**
 * Progress indicator for long operations
 */
const logProgress = (message, current = null, total = null) => {
    let progressMessage = message;
    
    if (current !== null && total !== null) {
        const percentage = Math.round((current / total) * 100);
        const progressBar = '█'.repeat(Math.floor(percentage / 5)) + 
                           '░'.repeat(20 - Math.floor(percentage / 5));
        progressMessage += ` [${progressBar}] ${percentage}% (${current}/${total})`;
    }
    
    console.log(formatConsoleMessage('PROGRESS', progressMessage));
};

/**
 * Success message with checkmark
 */
const logSuccess = (message, data = null, duration = null) => {
    let successMessage = `✅ ${message}`;
    if (duration !== null) {
        successMessage += ` ${colorize(`(${duration}ms)`, 'dim')}`;
    }
    writeToLogFile(currentLogFiles.app, 'SUCCESS', successMessage, data);
};

/**
 * Warning message with warning symbol
 */
const logWarning = (message, data = null) => {
    const warningMessage = `⚠️ ${message}`;
    writeToLogFile(currentLogFiles.app, 'WARNING', warningMessage, data);
};

/**
 * Operation start tracker
 */
const operations = new Map();

const startOperation = (operationId, message) => {
    const startTime = Date.now();
    operations.set(operationId, { startTime, message });
    
    const startMessage = `🔄 ${message}...`;
    writeToLogFile(currentLogFiles.app, 'INFO', startMessage);
    
    return startTime;
};

const endOperation = (operationId, successMessage = null, errorMessage = null) => {
    const operation = operations.get(operationId);
    if (!operation) return;
    
    const duration = Date.now() - operation.startTime;
    operations.delete(operationId);
    
    if (errorMessage) {
        const failMessage = `❌ ${operation.message} failed: ${errorMessage}`;
        writeToLogFile(currentLogFiles.error, 'ERROR', failMessage);
    } else {
        const completeMessage = successMessage || `${operation.message} completed`;
        logSuccess(completeMessage, null, duration);
    }
    
    return duration;
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
    // Basic logging methods (backward compatibility)
    error: (message, data) => writeToLogFile(currentLogFiles.error, 'ERROR', message, data),
    info: (message, data) => writeToLogFile(currentLogFiles.app, 'INFO', message, data),
    debug: (message, data) => {
        // Only log debug messages in non-built app (source code)
        if (isSourceCode()) {
            writeToLogFile(currentLogFiles.app, 'DEBUG', message, data);
        }
        // In built app, debug logs are completely silent
    },
    api: (message, data) => {
        // Always log API messages to file in non-built app
        if (isSourceCode()) {
            writeToLogFile(currentLogFiles.api, 'API', message, data);
        }
    },

    // Enhanced logging methods
    success: logSuccess,
    warning: logWarning,
    progress: logProgress,
    
    // Operation tracking
    startOperation,
    endOperation,
    
    // Enhanced logging with context
    logWithOperation,
    
    // Challenge-specific logging
    challengeInfo: (challengeId, challengeTitle, message, data) => {
        const contextMessage = `[Challenge ${challengeId}: ${challengeTitle}] ${message}`;
        writeToLogFile(currentLogFiles.app, 'INFO', contextMessage, data);
    },
    
    challengeSuccess: (challengeId, challengeTitle, message, data, duration) => {
        const contextMessage = `[Challenge ${challengeId}: ${challengeTitle}] ✅ ${message}`;
        logSuccess(contextMessage, data, duration);
    },
    
    challengeError: (challengeId, challengeTitle, message, data) => {
        const contextMessage = `[Challenge ${challengeId}: ${challengeTitle}] ❌ ${message}`;
        writeToLogFile(currentLogFiles.error, 'ERROR', contextMessage, data);
    },
    
    // API-specific logging with timing
    apiRequest: (method, url, duration = null) => {
        const message = duration ? 
            `${method} ${url} (${duration}ms)` : 
            `${method} ${url}`;
        // Always log API requests to file in non-built app
        if (isSourceCode()) {
            writeToLogFile(currentLogFiles.api, 'API', `🌐 REQUEST: ${message}`);
        }
    },
    
    apiResponse: (method, url, status, duration = null) => {
        const statusEmoji = status >= 200 && status < 300 ? '✅' : '❌';
        const message = duration ? 
            `${method} ${url} → ${status} (${duration}ms)` : 
            `${method} ${url} → ${status}`;
        // Always log API responses to file in non-built app
        if (isSourceCode()) {
            writeToLogFile(currentLogFiles.api, 'API', `${statusEmoji} RESPONSE: ${message}`);
        }
    },
    
    // CLI-specific methods
    cliInfo: (message, data) => {
        if (isCliMode) {
            writeToLogFile(currentLogFiles.app, 'INFO', message, data);
        }
    },
    
    cliSuccess: (message, data, duration) => {
        if (isCliMode) {
            logSuccess(message, data, duration);
        }
    },
    
    cliError: (message, data) => {
        if (isCliMode) {
            writeToLogFile(currentLogFiles.error, 'ERROR', message, data);
        }
    },

    // Utility methods
    getLogFile: () => currentLogFiles.app,
    getErrorLogFile: () => currentLogFiles.error,
    getApiLogFile: () => currentLogFiles.api,
    getLogFileForDate: (date) => getLogFilePaths(date),
    cleanup: cleanupOldLogs,
    
    // Context helpers
    getContext,
    setContext,
    clearContext,
    isCliMode: () => isCliMode,
    isDevMode: () => isDevMode,
}; 