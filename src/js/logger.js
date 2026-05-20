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

// Severity colors — strict 4-level set.
const LEVEL_COLORS = {
    DEBUG: 'gray',
    INFO: 'blue',
    WARN: 'yellow',
    ERROR: 'red',
};

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
 * Format console output. Fixed-column order:
 *   [timestamp] [LEVEL] [CONTEXT] [category] message
 */
const formatConsoleMessage = (
    level,
    message,
    context = getContext(),
    timestamp = getTimeString(),
    forConsole = false,
    category = 'general',
) => {
    const color = LEVEL_COLORS[level] || 'white';
    const coloredTime = colorize(`[${timestamp}]`, 'gray', forConsole);
    const coloredLevel = colorize(`[${level}]`, color, forConsole);
    const coloredContext = colorize(`[${context}]`, 'cyan', forConsole);
    const coloredCategory = colorize(`[${category}]`, 'yellow', forConsole);

    return `${coloredTime} ${coloredLevel} ${coloredContext} ${coloredCategory} ${message}`;
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

// Message-level counterpart to sanitizeForLog. sanitizeForLog only sees the
// structured `data` object; it never touches the free-form message string.
// Callers that fold a credential into the message via positional args (the
// renderer login shim used to log `login with: <user> <password>`) would
// otherwise leak plaintext to disk. This scrubs the value after any
// sensitive key written as `key: value` or `key=value` (quotes optional)
// and runs on every writeLog message. The key set mirrors SENSITIVE_KEY_RE;
// \b anchors keep `tokenizer` etc. from matching.
const SENSITIVE_MSG_RE =
    /\b(token|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|password|api[_-]?key|secret|cookie|authorization|x[_-]?auth[_-]?token)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

const redactMessage = (message) => {
    if (typeof message !== 'string') return message;
    return message.replace(SENSITIVE_MSG_RE, (_match, key, sep) => `${key}${sep}${REDACTED}`);
};

// Ring buffer of recent log entries — drives the GUI Logs page on mount
// so users see the backlog since app start instead of "Waiting...". The
// monotonic seq lets the renderer de-dupe live messages that race the
// backlog fetch.
const MAX_RECENT = 1000;
const recentLogs = [];
let nextSeq = 1;

// Routes a log entry to the appropriate disk file. ERROR always wins
// over category-based routing so errors stay co-located across domains.
const routeLogFile = (level, category) => {
    if (level === 'ERROR') return currentLogFiles.error;
    if (category === 'api') return currentLogFiles.api;
    if (category === 'settings') return currentLogFiles.settings;
    return currentLogFiles.app;
};

/**
 * Core write path. All sugar methods funnel through this.
 *
 * Emits to ring buffer, disk (when fs is available), console, and the
 * GUI IPC fan-out (when wired). Sanitizes data for disk; sends raw to
 * the GUI which renders it.
 */
const writeLog = (level, message, data = null, category = null) => {
    try {
        const context = getContext();
        const timestamp = new Date().toISOString();
        const cat = category || 'general';
        // Scrub credentials folded into the message string before it reaches
        // the ring buffer, disk, console, or the GUI fan-out below.
        message = redactMessage(message);
        const sanitized = data ? sanitizeForLog(data) : null;
        const seq = nextSeq++;
        const entry = { seq, level, context, category: cat, timestamp, message, data: sanitized };

        recentLogs.push(entry);
        if (recentLogs.length > MAX_RECENT) recentLogs.shift();

        if (logsDir && typeof fs.appendFileSync === 'function') {
            const target = routeLogFile(level, cat);
            let line = `[${timestamp}] [${level}] [${context}] [${cat}] ${message}`;
            if (sanitized) {
                line += '\n' + (typeof sanitized === 'object' ? JSON.stringify(sanitized, null, 2) : sanitized);
            }
            line += '\n' + '='.repeat(80) + '\n';
            try {
                fs.appendFileSync(target, line);
            } catch {
                // best-effort; never let a log write tear down the app.
            }
        }

        console.log(formatConsoleMessage(level, message, context, getTimeString(), true, cat));

        if (typeof global !== 'undefined' && global.sendLogToGUI) {
            global.sendLogToGUI({
                seq,
                level,
                context,
                category: cat,
                timestamp: getTimeString(),
                message,
            });
        }
    } catch (error) {
        console.error('Error writing log entry:', error);
    }
};

/**
 * Operation tracker. `startOperation` stores the level + category so
 * `endOperation` can emit the success line at the same severity as the
 * start (e.g. inner ops both start and end at DEBUG without cluttering
 * the default log). Failures always emit at ERROR regardless of start
 * level — a real bug should never be silently swallowed.
 */
const operations = new Map();

const startOperation = (operationId, message, level = 'INFO', category = null) => {
    const startTime = Date.now();
    operations.set(operationId, { startTime, message, level, category });
    writeLog(level, `🔄 ${message}...`, null, category);
    return startTime;
};

const endOperation = (operationId, successMessage = null, errorMessage = null) => {
    const operation = operations.get(operationId);
    if (!operation) return;

    const duration = Date.now() - operation.startTime;
    operations.delete(operationId);

    if (errorMessage) {
        const failMessage = `❌ ${operation.message} failed: ${errorMessage}`;
        writeLog('ERROR', failMessage, null, operation.category);
    } else {
        const completeMessage = successMessage || `${operation.message} completed`;
        writeLog(operation.level, `✅ ${completeMessage} (${duration}ms)`, null, operation.category);
    }

    return duration;
};

/** Build a progress message with optional [bar] suffix. */
const buildProgressMessage = (message, current, total) => {
    if (current === null || total === null) return message;
    const percentage = Math.round((current / total) * 100);
    const bar = '█'.repeat(Math.floor(percentage / 5)) + '░'.repeat(20 - Math.floor(percentage / 5));
    return `${message} [${bar}] ${percentage}% (${current}/${total})`;
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

// API and debug emissions only land in source-code builds — packaged
// apps stay quiet on these noisy channels.
const apiOrDebugEnabled = () => isSourceCode();

// Export logger functions
module.exports = {
    // Category constants
    CATEGORIES: LOG_CATEGORIES,

    // Basic logging methods
    error: (message, data, category) => writeLog('ERROR', message, data, category),
    info: (message, data, category) => writeLog('INFO', message, data, category),
    debug: (message, data, category) => {
        if (apiOrDebugEnabled()) writeLog('DEBUG', message, data, category);
    },
    api: (message, data, category = 'api') => {
        if (apiOrDebugEnabled()) writeLog('INFO', message, data, category);
    },

    // Enhanced logging methods
    success: (message, data = null, duration = null, category = null) => {
        const suffix = duration !== null ? ` (${duration}ms)` : '';
        writeLog('INFO', `✅ ${message}${suffix}`, data, category);
    },
    warning: (message, data = null, category = null) => {
        writeLog('WARN', `⚠️ ${message}`, data, category);
    },
    progress: (message, current = null, total = null) => {
        writeLog('INFO', buildProgressMessage(message, current, total), null, null);
    },

    // Category logging - creates a logger bound to a category
    withCategory: (category) => ({
        info: (message, data) => writeLog('INFO', message, data, category),
        error: (message, data) => writeLog('ERROR', message, data, category),
        debug: (message, data) => {
            if (apiOrDebugEnabled()) writeLog('DEBUG', message, data, category);
        },
        api: (message, data) => {
            if (apiOrDebugEnabled()) writeLog('INFO', message, data, category);
        },
        apiRequest: (method, url, duration = null) => {
            if (!apiOrDebugEnabled()) return;
            const suffix = duration !== null ? ` (${duration}ms)` : '';
            writeLog('INFO', `🌐 REQUEST: ${method} ${url}${suffix}`, null, category);
        },
        apiResponse: (method, url, status, duration = null) => {
            if (!apiOrDebugEnabled()) return;
            const statusEmoji = status >= 200 && status < 300 ? '✅' : '❌';
            const suffix = duration !== null ? ` (${duration}ms)` : '';
            writeLog('INFO', `${statusEmoji} RESPONSE: ${method} ${url} → ${status}${suffix}`, null, category);
        },
        success: (message, data, duration) => {
            const suffix = duration !== null && duration !== undefined ? ` (${duration}ms)` : '';
            writeLog('INFO', `✅ ${message}${suffix}`, data, category);
        },
        warning: (message, data) => writeLog('WARN', `⚠️ ${message}`, data, category),
        progress: (message, current = null, total = null) => {
            writeLog('INFO', buildProgressMessage(message, current, total), null, category);
        },
        startOperation: (operationId, message, level = 'INFO') => startOperation(operationId, message, level, category),
        endOperation,
    }),

    // Operation tracking (top-level)
    startOperation,
    endOperation,

    // API-specific logging with timing (top-level convenience)
    apiRequest: (method, url, duration = null) => {
        if (!apiOrDebugEnabled()) return;
        const suffix = duration !== null ? ` (${duration}ms)` : '';
        writeLog('INFO', `🌐 REQUEST: ${method} ${url}${suffix}`, null, 'api');
    },

    apiResponse: (method, url, status, duration = null) => {
        if (!apiOrDebugEnabled()) return;
        const statusEmoji = status >= 200 && status < 300 ? '✅' : '❌';
        const suffix = duration !== null ? ` (${duration}ms)` : '';
        writeLog('INFO', `${statusEmoji} RESPONSE: ${method} ${url} → ${status}${suffix}`, null, 'api');
    },

    // Ring buffer accessor — drives GUI backlog replay on mount.
    getRecentLogs: () => recentLogs.slice(),

    // Formats a challenge object as the standard log prefix
    // `[Challenge {id}: {title}]`. Pass the whole challenge object or
    // (id, title) directly; missing fields render as 'unknown'.
    challengeTag: (challengeOrId, title) => {
        if (challengeOrId && typeof challengeOrId === 'object') {
            return `[Challenge ${challengeOrId.id ?? 'unknown'}: ${challengeOrId.title ?? 'unknown'}]`;
        }
        return `[Challenge ${challengeOrId ?? 'unknown'}: ${title ?? 'unknown'}]`;
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

    // Test seam: redacts credentials folded into a message string. Applied
    // automatically by writeLog; exported so the contract is unit-testable.
    redactMessage,
};
