const fs = require('node:fs');
const path = require('node:path');
const runtime = require('./runtime');
const { formatTimeHMS } = require('./dateFormat');

// ANSI color codes for CLI output (referenced via bracket notation in formatConsoleMessage)
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

    // For CLI: check if we're running inside a Node Single Executable App
    try {
        if (require('node:sea').isSea()) {
            return false;
        }
    } catch {
        // node:sea unavailable — fall through to other detection
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
        userDataPath = runtime.getUserDataDir(getAppName());

        // Ensure the directory exists
        if (!fs.existsSync(userDataPath)) {
            try {
                fs.mkdirSync(userDataPath, { recursive: true });
            } catch (mkdirError) {
                // logger module isn't ready here (we're inside its bootstrap),
                // so console.warn is the only safe channel.
                console.warn(
                    `[logger] failed to create userData dir ${userDataPath} (${mkdirError.code || mkdirError.message}); falling back to cwd/userData`,
                );
                userDataPath = path.join(process.cwd(), 'userData');
                if (!fs.existsSync(userDataPath)) {
                    fs.mkdirSync(userDataPath, { recursive: true });
                }
            }
        }
    }

    return userDataPath;
};

// Create logs directory in the same location as settings.
// Wrapped in try/catch so the Capacitor WebView (no fs) can load the
// logger module without crashing — file writes downstream silently
// no-op when logsDir is '' / fs is the bundler shim.
let logsDir = '';
try {
    logsDir = path.join(getUserDataPath(), 'logs');
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
} catch (err) {
    // Browser / Capacitor context — fs is a require shim. Logger falls
    // back to console output only; in-app log streaming uses sendLogToGUI.
    if (typeof console !== 'undefined' && console.debug) {
        console.debug('[logger] fs not available; skipping file-based logging:', err.message);
    }
    logsDir = '';
}

// Check if we're in development mode (not mock)
const isDevMode = runtime.isDevelopment();

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
        settings: path.join(logsDir, `settings-${date}.log`),
    };
};

// Per-log-prefix retention rules: { days, maxMB }.
const LOG_RETENTION = {
    errors: { days: 30, maxMB: 10 },
    app: { days: 7, maxMB: 50 },
    api: { days: 1, maxMB: 20 },
    settings: { days: 7, maxMB: 10 },
};

// Parse date from filename (e.g., "errors-2025-07-28.log" -> "2025-07-28")
const parseDateFromFilename = (filename) => {
    const match = filename.match(/(errors|app|api|settings)-(\d{4}-\d{2}-\d{2})\.log$/);
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
    // Browser / Capacitor context has no logsDir; nothing to clean up.
    if (!logsDir) return;
    try {
        // Check if fs and path modules are available (they might not be in test environments)
        if (typeof require !== 'undefined') {
            const fs = require('node:fs');
            const path = require('node:path');

            // Check if logsDir exists and is accessible
            if (typeof fs.existsSync !== 'function' || !fs.existsSync(logsDir)) {
                return;
            }

            const files = fs.readdirSync(logsDir);
            const now = new Date();

            files.forEach((file) => {
                const filePath = path.join(logsDir, file);
                const stats = fs.statSync(filePath);
                const fileSizeMB = stats.size / (1024 * 1024);

                let shouldDelete = false;
                let reason = '';

                // Parse date from filename
                const fileDate = parseDateFromFilename(file);

                if (fileDate) {
                    const prefix = Object.keys(LOG_RETENTION).find((p) => file.startsWith(`${p}-`));
                    if (prefix) {
                        const { days, maxMB } = LOG_RETENTION[prefix];
                        const tooOld = isDateOlderThan(fileDate, days);
                        shouldDelete = tooOld || fileSizeMB > maxMB;
                        reason = tooOld ? 'age' : 'size';
                    }
                } else if (file.startsWith('api-debug-')) {
                    // Clean up old timestamped files
                    const fileAge = now.getTime() - stats.mtime.getTime();
                    shouldDelete = fileAge > 7 * 24 * 60 * 60 * 1000; // 7 days
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
        if (!runtime.isTest()) {
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

const getTimeString = () => formatTimeHMS();

/**
 * Apply color to text (only in CLI mode and when not sending to GUI)
 */
const colorize = (text, color, forConsole = false) => {
    // Only apply colors in CLI mode with TTY or when explicitly for console output
    if ((!isCliMode || !process.stdout.isTTY) && !forConsole) {
        return text;
    }
    // Don't apply colors if we're sending to GUI (even in CLI mode)
    if (typeof global !== 'undefined' && global.sendLogToGUI && !forConsole) {
        return text;
    }
    return `${colors[color]}${text}${colors.reset}`;
};

/**
 * Format console output with context and colors
 */
const formatConsoleMessage = (
    level,
    message,
    context = getContext(),
    timestamp = getTimeString(),
    forConsole = false,
    category = null,
) => {
    const levelColors = {
        INFO: 'blue',
        SUCCESS: 'green',
        WARNING: 'yellow',
        ERROR: 'red',
        DEBUG: 'gray',
        API: 'cyan',
        PROGRESS: 'magenta',
    };

    const color = levelColors[level] || 'white';
    const coloredLevel = colorize(`[${level}]`, color, forConsole);
    const coloredContext = colorize(`[${context}]`, 'cyan', forConsole);
    const coloredTime = colorize(`[${timestamp}]`, 'gray', forConsole);
    const categoryString = category ? colorize(`[${category.toUpperCase()}]`, 'yellow', forConsole) + ' ' : '';

    return `${categoryString}${coloredContext} ${coloredLevel} ${coloredTime} ${message}`;
};

// Keys whose values must never reach disk in plaintext. Match is case-
// insensitive and covers the OAuth-style underscored names the GuruShots
// auth response actually uses (access_token, auth_token, refresh_token)
// alongside the camelCase + standard HTTP credential header names.
// Bounded recursion depth + a seen-set prevent pathological inputs.
const SENSITIVE_KEY_RE =
    /^(token|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|password|api[_-]?key|secret|cookie|authorization|x[_-]auth[_-]token)$/i;
const REDACTED = '[REDACTED]';
const MAX_SANITIZE_DEPTH = 6;

const sanitizeForLog = (value, depth = 0, seen = new WeakSet()) => {
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_SANITIZE_DEPTH) return '[Object]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeForLog(item, depth + 1, seen));
    }

    const out = {};
    for (const key of Object.keys(value)) {
        if (SENSITIVE_KEY_RE.test(key)) {
            out[key] = REDACTED;
        } else {
            out[key] = sanitizeForLog(value[key], depth + 1, seen);
        }
    }
    return out;
};

/**
 * Write to log file with enhanced formatting
 */
const writeToLogFile = (logFile, level, message, data = null, context = getContext(), category = null) => {
    try {
        const timestamp = new Date().toISOString();
        const categoryString = category ? `[${category.toUpperCase()}] ` : '';
        let logEntry = `${categoryString}[${context}] [${level}] [${timestamp}] ${message}`;

        if (data) {
            if (typeof data === 'object') {
                logEntry += '\n' + JSON.stringify(sanitizeForLog(data), null, 2);
            } else {
                logEntry += '\n' + data;
            }
        }

        logEntry += '\n' + '='.repeat(80) + '\n';

        // Route settings logs to settings file
        let targetLogFile = logFile;
        if (category === 'settings') {
            targetLogFile = currentLogFiles.settings;
        }

        // Write to file. On Capacitor / browser, logsDir is empty and
        // fs is the require-shim — skip silently and rely on the
        // console.log below + sendLogToGUI for in-app log surfacing.
        if (logsDir && typeof fs.appendFileSync === 'function') {
            try {
                fs.appendFileSync(targetLogFile, logEntry);
            } catch {
                // best-effort; never let a log write tear down the app.
            }
        }

        // Also log to console with formatting (colors enabled for console)
        console.log(formatConsoleMessage(level, message, context, getTimeString(), true, category));

        // Send to GUI if available and log stream is active (no colors for GUI)
        if (typeof global !== 'undefined' && global.sendLogToGUI) {
            const timeString = getTimeString();
            global.sendLogToGUI(level, message, context, timeString, category);
        }
    } catch (error) {
        console.error('Error writing to log file:', error);
    }
};

/**
 * Enhanced logging with operation tracking
 */
const logWithOperation = (level, operation, message, data = null, duration = null) => {
    let baseMessage = message;

    if (operation) {
        baseMessage = `${operation}: ${message}`;
    }

    // Create clean message for GUI/file (without colors)
    let cleanMessage = baseMessage;

    if (duration !== null) {
        cleanMessage += ` (${duration}ms)`;
    }

    const logFile =
        level === 'ERROR' ? currentLogFiles.error : level === 'API' ? currentLogFiles.api : currentLogFiles.app;

    // Use the clean message for file/GUI logging
    writeToLogFile(logFile, level, cleanMessage, data);
};

/**
 * Progress indicator for long operations
 */
const logProgress = (message, current = null, total = null) => {
    let progressMessage = message;

    if (current !== null && total !== null) {
        const percentage = Math.round((current / total) * 100);
        const progressBar = '█'.repeat(Math.floor(percentage / 5)) + '░'.repeat(20 - Math.floor(percentage / 5));
        progressMessage += ` [${progressBar}] ${percentage}% (${current}/${total})`;
    }

    console.log(formatConsoleMessage('PROGRESS', progressMessage, getContext(), getTimeString(), true));
};

/**
 * Success message with checkmark
 */
const logSuccess = (message, data = null, duration = null, category = null) => {
    let successMessage = `✅ ${message}`;
    if (duration !== null) {
        successMessage += ` (${duration}ms)`;
    }
    writeToLogFile(currentLogFiles.app, 'SUCCESS', successMessage, data, getContext(), category);
};

/**
 * Warning message with warning symbol
 */
const logWarning = (message, data = null, category = null) => {
    const warningMessage = `⚠️ ${message}`;
    writeToLogFile(currentLogFiles.app, 'WARNING', warningMessage, data, getContext(), category);
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
if (
    typeof setInterval !== 'undefined' &&
    (isElectronApp || (isCliMode && process.argv[1] && process.argv[1].includes('cli.js')))
) {
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

// Log categories for consistent usage across the application. The
// logger accepts free-form category strings, but listing the well-known
// values here keeps grep / log-routing predictable and gives developers
// a single source of truth for category names.
const LOG_CATEGORIES = {
    SETTINGS: 'settings',
    AUTHENTICATION: 'authentication',
    VOTING: 'voting',
    CHALLENGES: 'challenges',
    API: 'api',
    UI: 'ui',
    TRANSLATION: 'translation',
    MIDDLEWARE: 'middleware',
    UPDATE: 'update',
    BOOST: 'boost',
    TURBO: 'turbo',
    // Catch-all for events that don't belong to a domain category —
    // bridge plumbing failures, bootstrap errors, etc. Routes to the
    // shared app-YYYY-MM-DD.log alongside other non-settings categories;
    // there is no dedicated general.log file.
    GENERAL: 'general',
};

// Export logger functions
module.exports = {
    // Category constants
    CATEGORIES: LOG_CATEGORIES,
    // Basic logging methods (backward compatibility)
    error: (message, data, category) =>
        writeToLogFile(currentLogFiles.error, 'ERROR', message, data, getContext(), category),
    info: (message, data, category) =>
        writeToLogFile(currentLogFiles.app, 'INFO', message, data, getContext(), category),
    debug: (message, data, category) => {
        // Only log debug messages in non-built app (source code)
        if (isSourceCode()) {
            writeToLogFile(currentLogFiles.app, 'DEBUG', message, data, getContext(), category);
        }
        // In built app, debug messages are completely suppressed for both CLI and GUI
    },
    api: (message, data, category) => {
        // Always log API messages to file in non-built app
        if (isSourceCode()) {
            writeToLogFile(currentLogFiles.api, 'API', message, data, getContext(), category);
        }
    },

    // Enhanced logging methods
    success: logSuccess,
    warning: logWarning,
    progress: logProgress,

    // Category logging - creates a logger for any category
    withCategory: (category) => ({
        info: (message, data) => writeToLogFile(currentLogFiles.app, 'INFO', message, data, getContext(), category),
        error: (message, data) => writeToLogFile(currentLogFiles.error, 'ERROR', message, data, getContext(), category),
        debug: (message, data) => {
            if (isSourceCode()) {
                writeToLogFile(currentLogFiles.app, 'DEBUG', message, data, getContext(), category);
            }
        },
        api: (message, data) => {
            // Always log API messages to file in non-built app
            if (isSourceCode()) {
                writeToLogFile(currentLogFiles.api, 'API', message, data, getContext(), category);
            }
        },
        apiRequest: (method, url, duration = null) => {
            const message = duration ? `${method} ${url} (${duration}ms)` : `${method} ${url}`;
            // Always log API requests to file in non-built app
            if (isSourceCode()) {
                writeToLogFile(currentLogFiles.api, 'API', `🌐 REQUEST: ${message}`, null, getContext(), category);
            }
        },
        success: (message, data, duration) => logSuccess(message, data, duration, category),
        warning: (message, data) => logWarning(message, data, category),
        progress: (message, current = null, total = null) => {
            let progressMessage = message;

            if (current !== null && total !== null) {
                const percentage = Math.round((current / total) * 100);
                const progressBar =
                    '█'.repeat(Math.floor(percentage / 5)) + '░'.repeat(20 - Math.floor(percentage / 5));
                progressMessage += ` [${progressBar}] ${percentage}% (${current}/${total})`;
            }

            console.log(
                formatConsoleMessage('PROGRESS', progressMessage, getContext(), getTimeString(), true, category),
            );
        },
        startOperation: (operationId, message) => {
            const startTime = Date.now();
            operations.set(operationId, { startTime, message });

            const startMessage = `🔄 ${message}...`;
            writeToLogFile(currentLogFiles.app, 'INFO', startMessage, null, getContext(), category);

            return startTime;
        },
        endOperation: (operationId, successMessage = null, errorMessage = null) => {
            const operation = operations.get(operationId);
            if (!operation) return;

            const duration = Date.now() - operation.startTime;
            operations.delete(operationId);

            if (errorMessage) {
                const failMessage = `❌ ${operation.message} failed: ${errorMessage}`;
                writeToLogFile(currentLogFiles.error, 'ERROR', failMessage, null, getContext(), category);
            } else {
                const completeMessage = successMessage || `${operation.message} completed`;
                logSuccess(completeMessage, null, duration, category);
            }

            return duration;
        },
    }),

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
        const message = duration ? `${method} ${url} (${duration}ms)` : `${method} ${url}`;
        // Always log API requests to file in non-built app
        if (isSourceCode()) {
            writeToLogFile(currentLogFiles.api, 'API', `🌐 REQUEST: ${message}`);
        }
    },

    apiResponse: (method, url, status, duration = null) => {
        const statusEmoji = status >= 200 && status < 300 ? '✅' : '❌';
        const message = duration ? `${method} ${url} → ${status} (${duration}ms)` : `${method} ${url} → ${status}`;
        // Always log API responses to file in non-built app
        if (isSourceCode()) {
            writeToLogFile(currentLogFiles.api, 'API', `${statusEmoji} RESPONSE: ${message}`);
        }
    },

    // Utility methods
    getLogFile: () => currentLogFiles.app,
    getErrorLogFile: () => currentLogFiles.error,
    getApiLogFile: () => currentLogFiles.api,
    getSettingsLogFile: () => currentLogFiles.settings,
    getLogFileForDate: (date) => getLogFilePaths(date),
    cleanup: cleanupOldLogs,

    // Context helpers
    getContext,
    setContext,
    clearContext,
    isCliMode: () => isCliMode,
    isDevMode: () => isDevMode,

    // Runtime detection (canonical home — settings.js re-exports these)
    isSourceCode,
    getAppName,

    // Test seam: redacts sensitive keys before disk write. Exported so the
    // contract is unit-testable; production callers don't need to call it.
    sanitizeForLog,
};
