// @ts-check
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as runtime from './runtime';
import { formatTimeHMS } from './dateFormat';
import { oneLine } from './format/logSafe';

/** @typedef {'DEBUG' | 'INFO' | 'WARN' | 'ERROR'} LogLevel */
/** @typedef {keyof typeof colors} ColorName */

/**
 * One ring-buffer entry (getRecentLogs). `data` is the sanitized copy.
 * @typedef {{
 *   seq: number,
 *   level: LogLevel,
 *   context: string,
 *   category: string,
 *   timestamp: string,
 *   message: string,
 *   data: unknown,
 * }} LogEntry
 */

/**
 * The GUI fan-out payload; `timestamp` is the HH:MM:SS display time.
 * @typedef {Omit<LogEntry, 'data'>} GuiLogEntry
 */

/** @typedef {(entry: GuiLogEntry) => void} GuiLogSink */

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

// Check if we're actually running in an Electron app context
// process.type will be 'renderer' or 'browser' (the main process) in Electron apps
const isElectronApp = process.type === 'renderer' || process.type === 'browser';

// Runtime owns the single implementation of source-detection, app naming,
// and user-data resolution — logger re-exports isSourceCode/getAppName
// because settings.js and tests consume them through this module.
const { isSourceCode, getAppName } = runtime;
const getUserDataPath = runtime.getAppUserDataPath;

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
    console.debug('[logger] fs not available; skipping file-based logging:', /** @type {Error} */ (err).message);
    logsDir = '';
}

// Check if we're in development mode (not mock)
const devMode = runtime.isDevelopment();

// Check if we're in CLI mode vs GUI mode
// CLI mode: running directly from cli.js or when electron main process handles CLI commands
// GUI mode: electron main process handling GUI IPC calls
const startedViaCli = Boolean(process.argv[1] && process.argv[1].includes('cli.js'));
const cliMode = !isElectronApp || startedViaCli;

// Get current date in YYYY-MM-DD format
const getCurrentDate = () => {
    return new Date().toISOString().split('T')[0];
};

// Get log file paths for current date
/**
 * @param {string} [date] - YYYY-MM-DD
 * @returns {{ error: string, app: string, api: string, settings: string }}
 */
const getLogFilePaths = (date = getCurrentDate()) => {
    return {
        error: path.join(logsDir, `errors-${date}.log`),
        app: path.join(logsDir, `app-${date}.log`),
        api: path.join(logsDir, `api-${date}.log`),
        settings: path.join(logsDir, `settings-${date}.log`),
    };
};

// Per-log-prefix retention rules: { days, maxMB }.
/** @type {Record<string, { days: number, maxMB: number }>} */
const LOG_RETENTION = {
    errors: { days: 30, maxMB: 10 },
    app: { days: 7, maxMB: 50 },
    api: { days: 1, maxMB: 20 },
    settings: { days: 7, maxMB: 10 },
};

// Parse date from filename (e.g., "errors-2025-07-28.log" -> "2025-07-28")
/**
 * @param {string} filename
 * @returns {string | null}
 */
const parseDateFromFilename = (filename) => {
    const match = filename.match(/(errors|app|api|settings)-(\d{4}-\d{2}-\d{2})\.log$/);
    return match ? match[2] : null;
};

// Check if a date is older than specified days
/**
 * @param {string} dateString
 * @param {number} days
 * @returns {boolean}
 */
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
        // A non-empty logsDir means the module-load existsSync/mkdirSync on the
        // real fs succeeded, so fs is usable here; the directory may still have
        // been removed since.
        if (!fs.existsSync(logsDir)) {
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
    } catch (error) {
        // Silently ignore cleanup errors in test environments
        if (!runtime.isTest()) {
            console.error('Error during log cleanup:', error);
        }
    }
};

// Context override for explicit context setting
/** @type {string | null} */
let contextOverride = null;

/**
 * Set explicit context override (for IPC calls from GUI)
 * @param {string} context
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
 * @returns {string}
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
    if (startedViaCli) {
        return 'CLI';
    }

    // Default for Electron main process is GUI
    return 'GUI';
};

const getTimeString = () => formatTimeHMS();

// Severity colors — strict 4-level set.
/** @type {Record<LogLevel, ColorName>} */
const LEVEL_COLORS = {
    DEBUG: 'gray',
    INFO: 'blue',
    WARN: 'yellow',
    ERROR: 'red',
};

// Resolve the GUI fan-out sink. Electron main sets global.sendLogToGUI and
// the Capacitor bridge sets globalThis.sendLogToGUI; in Node `global` IS
// `globalThis`, so one lookup covers both surfaces.
/** @returns {GuiLogSink | null} */
const resolveGuiSink = () =>
    /** @type {typeof globalThis & { sendLogToGUI?: GuiLogSink }} */ (globalThis).sendLogToGUI || null;

/**
 * Wrap text in an ANSI color. Only the console line is colored — the GUI
 * sink and the log files receive the plain message.
 * @param {string} text
 * @param {ColorName} color
 * @returns {string}
 */
const colorize = (text, color) => `${colors[color]}${text}${colors.reset}`;

/**
 * Format console output. Fixed-column order:
 *   [timestamp] [LEVEL] [CONTEXT] [category] message
 * @param {LogLevel} level
 * @param {string} message
 * @param {string} context
 * @param {string} timestamp
 * @param {string} category
 * @returns {string}
 */
const formatConsoleMessage = (level, message, context, timestamp, category) => {
    const color = LEVEL_COLORS[level] || 'white';
    const coloredTime = colorize(`[${timestamp}]`, 'gray');
    const coloredLevel = colorize(`[${level}]`, color);
    const coloredContext = colorize(`[${context}]`, 'cyan');
    const coloredCategory = colorize(`[${category}]`, 'yellow');

    return `${coloredTime} ${coloredLevel} ${coloredContext} ${coloredCategory} ${message}`;
};

// Keys whose values must never reach disk in plaintext. Match is case-
// insensitive and covers the OAuth-style underscored names the GuruShots
// auth response actually uses (access_token, auth_token, refresh_token)
// alongside the camelCase + standard HTTP credential header names.
// Bounded recursion depth + a seen-set prevent pathological inputs.
const SENSITIVE_KEY_RE =
    /^(token|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|password|api[_-]?key|secret|cookie|authorization|x[_-]auth[_-]token|x[_-]token)$/i;
const REDACTED = '[REDACTED]';
const MAX_SANITIZE_DEPTH = 6;

/**
 * Copy of `value` with sensitive keys redacted, depth-bounded and cycle-safe.
 * A top-level plain object comes back as a plain object.
 * @overload
 * @param {Record<string, unknown>} value
 * @returns {Record<string, unknown>}
 */
/**
 * @overload
 * @param {unknown} value
 * @param {number} [depth]
 * @param {WeakSet<object>} [seen]
 * @returns {unknown}
 */
/**
 * @param {unknown} value
 * @param {number} [depth]
 * @param {WeakSet<object>} [seen]
 * @returns {unknown}
 */
function sanitizeForLog(value, depth = 0, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_SANITIZE_DEPTH) return '[Object]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeForLog(item, depth + 1, seen));
    }

    /** @type {Record<string, unknown>} */
    const out = {};
    const record = /** @type {Record<string, unknown>} */ (value);
    for (const key of Object.keys(record)) {
        if (SENSITIVE_KEY_RE.test(key)) {
            out[key] = REDACTED;
        } else {
            out[key] = sanitizeForLog(record[key], depth + 1, seen);
        }
    }
    return out;
}

// Bounds an untrusted string before it is interpolated into a log line:
// CR/LF/tab collapse to spaces (a newline would otherwise forge a synthetic
// log line in the plain-text file) and the result is truncated. Shared by the
// IPC shell (actions.handlers) and the core services (challengeTitlePin) so
// both sides sanitize identically.
/**
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
const sanitizeLogString = (value, maxLength = 200) =>
    String(value ?? '')
        .replace(/[\r\n\t]/g, ' ')
        .slice(0, maxLength);

// Message-level counterpart to sanitizeForLog. sanitizeForLog only sees the
// structured `data` object; it never touches the free-form message string.
// Callers that fold a credential into the message via positional args (e.g.
// a `login with: <user> <password>` line) would
// otherwise leak plaintext to disk. This scrubs the value after any
// sensitive key written as `key: value` or `key=value` (quotes optional)
// and runs on every writeLog message. The key set mirrors SENSITIVE_KEY_RE;
// \b anchors keep `tokenizer` etc. from matching.
const SENSITIVE_MSG_RE =
    /\b(token|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|password|api[_-]?key|secret|cookie|authorization|x[_-]?auth[_-]?token|x[_-]?token)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

/**
 * @overload
 * @param {string} message
 * @returns {string}
 */
/**
 * @overload
 * @param {unknown} message
 * @returns {unknown}
 */
/**
 * @param {unknown} message
 * @returns {unknown}
 */
function redactMessage(message) {
    if (typeof message !== 'string') return message;
    return message.replace(SENSITIVE_MSG_RE, (_match, key, sep) => `${key}${sep}${REDACTED}`);
}

// Ring buffer of recent log entries — drives the GUI Logs page on mount
// so users see the backlog since app start instead of "Waiting...". The
// monotonic seq lets the renderer de-dupe live messages that race the
// backlog fetch.
const MAX_RECENT = 1000;
/** @type {LogEntry[]} */
const recentLogs = [];
let nextSeq = 1;

// Routes a log entry to the appropriate disk file. ERROR always wins
// over category-based routing so errors stay co-located across domains.
/**
 * @param {LogLevel} level
 * @param {string} category
 * @returns {string}
 */
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
 * @param {LogLevel} level
 * @param {string} message
 * @param {unknown} [data]
 * @param {string | null} [category]
 */
const writeLog = (level, message, data = null, category = null) => {
    try {
        const context = getContext();
        const timestamp = new Date().toISOString();
        const cat = category || 'general';
        // Scrub credentials folded into the message string before it reaches
        // the ring buffer, disk, console, or the GUI fan-out below.
        message = redactMessage(message);
        // Collapse CR/LF in the composed message centrally (defense-in-depth
        // against log injection / CWE-117). Per-call-site oneLine()/challengeTag()
        // on untrusted API strings is still the first line of defence, but a
        // single missed call site (e.g. a raw `${challenge.title}` in a log
        // message) must not be able to forge a fake log line in the plain-text
        // log file. Messages are single-line by convention; structured detail
        // goes in `data`, which is serialised separately below.
        if (typeof message === 'string') message = oneLine(message);
        let sanitized = data ? sanitizeForLog(data) : null;
        // A bare-string (or number) `data` value is written to the log file
        // verbatim (the non-object branch below), and rendered in the GUI, so it
        // needs the same CR/LF collapse as the message to close the log-injection
        // (CWE-117) path — e.g. an error string echoing a malformed API/update-feed
        // response must not forge a log line. Object data is already newline-safe:
        // JSON.stringify escapes embedded CR/LF into a literal \n.
        if (sanitized != null && typeof sanitized !== 'object') sanitized = oneLine(sanitized);
        const seq = nextSeq++;
        const entry = { seq, level, context, category: cat, timestamp, message, data: sanitized };

        recentLogs.push(entry);
        if (recentLogs.length > MAX_RECENT) recentLogs.shift();

        if (logsDir) {
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

        console.log(formatConsoleMessage(level, message, context, getTimeString(), cat));

        const guiSink = resolveGuiSink();
        if (guiSink) {
            guiSink({
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
/** @type {Map<string, { startTime: number, message: string, level: LogLevel, category: string | null }>} */
const operations = new Map();

/**
 * @param {string} operationId
 * @param {string} message
 * @param {LogLevel} [level]
 * @param {string | null} [category]
 * @returns {number} the start time (ms)
 */
const startOperation = (operationId, message, level = 'INFO', category = null) => {
    const startTime = Date.now();
    operations.set(operationId, { startTime, message, level, category });
    writeLog(level, `🔄 ${message}...`, null, category);
    return startTime;
};

/**
 * @param {string} operationId
 * @param {string | null} [successMessage]
 * @param {string | null} [errorMessage] - non-empty marks the operation failed
 * @returns {number | undefined} the duration (ms), or undefined for an unknown id
 */
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

/**
 * Build a progress message with optional [bar] suffix.
 * @param {string} message
 * @param {number | null} current
 * @param {number | null} total
 * @returns {string}
 */
const buildProgressMessage = (message, current, total) => {
    if (current === null || total === null) return message;
    const percentage = Math.round((current / total) * 100);
    const bar = '█'.repeat(Math.floor(percentage / 5)) + '░'.repeat(20 - Math.floor(percentage / 5));
    return `${message} [${bar}] ${percentage}% (${current}/${total})`;
};

// Initialize cleanup on module load
cleanupOldLogs();

// Set up periodic cleanup (every hour) only in actual application contexts
/** @type {ReturnType<typeof setInterval> | undefined} */
let cleanupInterval;
if (isElectronApp || startedViaCli) {
    cleanupInterval = setInterval(cleanupOldLogs, 60 * 60 * 1000); // 1 hour
}

process.on('exit', () => {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
    }
});

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
    // Bankroll-currency spends (key unlock / swap / exposure fill).
    CURRENCY: 'currency',
    // Automatic challenge/mission prize claiming.
    CLAIM: 'claim',
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
// Basic logging methods
/** @type {(message: string, data?: unknown, category?: string | null) => void} */
export const error = (message, data, category) => writeLog('ERROR', message, data, category);
/** @type {(message: string, data?: unknown, category?: string | null) => void} */
export const info = (message, data, category) => writeLog('INFO', message, data, category);
/** @type {(message: string, data?: unknown, category?: string | null) => void} */
export const debug = (message, data, category) => {
    if (apiOrDebugEnabled()) writeLog('DEBUG', message, data, category);
};
/** @type {(message: string, data?: unknown, category?: string | null) => void} */
export const api = (message, data, category = 'api') => {
    if (apiOrDebugEnabled()) writeLog('INFO', message, data, category);
};
// Enhanced logging methods
/** @type {(message: string, data?: unknown, duration?: number | null, category?: string | null) => void} */
export const success = (message, data = null, duration = null, category = null) => {
    const suffix = duration !== null ? ` (${duration}ms)` : '';
    writeLog('INFO', `✅ ${message}${suffix}`, data, category);
};
/** @type {(message: string, data?: unknown, category?: string | null) => void} */
export const warning = (message, data = null, category = null) => {
    writeLog('WARN', `⚠️ ${message}`, data, category);
};
/** @type {(message: string, current?: number | null, total?: number | null) => void} */
export const progress = (message, current = null, total = null) => {
    writeLog('INFO', buildProgressMessage(message, current, total), null, null);
};

/**
 * A logger bound to one category (withCategory).
 * @typedef {{
 *   info: (message: string, data?: unknown) => void,
 *   error: (message: string, data?: unknown) => void,
 *   debug: (message: string, data?: unknown) => void,
 *   api: (message: string, data?: unknown) => void,
 *   apiRequest: (method: string, url: string, duration?: number | null) => void,
 *   apiResponse: (method: string, url: string, status: number, duration?: number | null) => void,
 *   success: (message: string, data?: unknown, duration?: number | null) => void,
 *   warning: (message: string, data?: unknown) => void,
 *   progress: (message: string, current?: number | null, total?: number | null) => void,
 *   startOperation: (operationId: string, message: string, level?: LogLevel) => number,
 *   endOperation: typeof endOperation,
 * }} CategoryLogger
 */

// Category logging - creates a logger bound to a category
/**
 * @param {string} category
 * @returns {CategoryLogger}
 */
export const withCategory = (category) => ({
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
});
// API-specific logging with timing (top-level convenience)
/** @type {(method: string, url: string, duration?: number | null) => void} */
export const apiRequest = (method, url, duration = null) => {
    if (!apiOrDebugEnabled()) return;
    const suffix = duration !== null ? ` (${duration}ms)` : '';
    writeLog('INFO', `🌐 REQUEST: ${method} ${url}${suffix}`, null, 'api');
};
/** @type {(method: string, url: string, status: number, duration?: number | null) => void} */
export const apiResponse = (method, url, status, duration = null) => {
    if (!apiOrDebugEnabled()) return;
    const statusEmoji = status >= 200 && status < 300 ? '✅' : '❌';
    const suffix = duration !== null ? ` (${duration}ms)` : '';
    writeLog('INFO', `${statusEmoji} RESPONSE: ${method} ${url} → ${status}${suffix}`, null, 'api');
};
// Ring buffer accessor — drives GUI backlog replay on mount.
export const getRecentLogs = () => recentLogs.slice();
// Formats a challenge object as the standard log prefix
// `[Challenge {id}: {title}]`. Pass the whole challenge object or
// (id, title) directly; missing fields render as 'unknown'.
/**
 * @param {{ id?: unknown, title?: unknown } | string | number | null | undefined} challengeOrId
 * @param {unknown} [title]
 * @returns {string}
 */
export const challengeTag = (challengeOrId, title) => {
    if (challengeOrId && typeof challengeOrId === 'object') {
        const id = challengeOrId.id ?? 'unknown';
        const t = challengeOrId.title ?? 'unknown';
        return `[Challenge ${oneLine(id)}: ${oneLine(t)}]`;
    }
    return `[Challenge ${oneLine(challengeOrId ?? 'unknown')}: ${oneLine(title ?? 'unknown')}]`;
};
// Utility methods
export const getLogFile = () => currentLogFiles.app;
export const getErrorLogFile = () => currentLogFiles.error;
export const getApiLogFile = () => currentLogFiles.api;
export const getSettingsLogFile = () => currentLogFiles.settings;
/** @param {string} date - YYYY-MM-DD */
export const getLogFileForDate = (date) => getLogFilePaths(date);
export const isCliMode = () => cliMode;
export const isDevMode = () => devMode;
export {
    LOG_CATEGORIES as CATEGORIES,
    startOperation,
    endOperation,
    cleanupOldLogs as cleanup,
    getContext,
    setContext,
    clearContext,
    isSourceCode,
    getAppName,
    sanitizeForLog,
    sanitizeLogString,
    redactMessage,
};
