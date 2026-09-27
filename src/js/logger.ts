import * as fs from 'node:fs';
import * as path from 'node:path';
import * as runtime from './runtime';
import { formatTimeHMS } from './dateFormat';
import { oneLine } from './format/logSafe';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type ColorName = keyof typeof colors;

/**
 * One ring-buffer entry (getRecentLogs). `data` is the sanitized copy.
 */
export type LogEntry = {
    seq: number;
    level: LogLevel;
    context: string;
    category: string;
    timestamp: string;
    message: string;
    data: unknown;
};

/**
 * The GUI fan-out payload; `timestamp` is the HH:MM:SS display time.
 */
export type GuiLogEntry = Omit<LogEntry, 'data'>;

export type GuiLogSink = (entry: GuiLogEntry) => void;

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

// Whether this is a real Electron process (main or renderer). Decided by
// process.versions.electron via runtime, not process.type: the WebView
// bundles' process stub reports type 'browser' too.
const isElectronApp = runtime.isElectron();

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
    console.debug('[logger] fs not available; skipping file-based logging:', (err as Error).message);
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
 * @param date - YYYY-MM-DD
 */
const getLogFilePaths = (
    date: string = getCurrentDate(),
): { error: string; app: string; api: string; settings: string } => {
    return {
        error: path.join(logsDir, `errors-${date}.log`),
        app: path.join(logsDir, `app-${date}.log`),
        api: path.join(logsDir, `api-${date}.log`),
        settings: path.join(logsDir, `settings-${date}.log`),
    };
};

// Per-log-prefix retention rules: { days, maxMB }.
const LOG_RETENTION: Record<string, { days: number; maxMB: number }> = {
    errors: { days: 30, maxMB: 10 },
    app: { days: 7, maxMB: 50 },
    api: { days: 1, maxMB: 20 },
    settings: { days: 7, maxMB: 10 },
};

// Parse date from filename (e.g., "errors-2025-07-28.log" -> "2025-07-28")
const parseDateFromFilename = (filename: string): string | null => {
    const match = filename.match(/(errors|app|api|settings)-(\d{4}-\d{2}-\d{2})\.log$/);
    return match ? match[2] : null;
};

// Check if a date is older than specified days
const isDateOlderThan = (dateString: string, days: number): boolean => {
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
let contextOverride: string | null = null;

/**
 * Set explicit context override (for IPC calls from GUI)
 */
const setContext = (context: string) => {
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
const getContext = (): string => {
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
const LEVEL_COLORS: Record<LogLevel, ColorName> = {
    DEBUG: 'gray',
    INFO: 'blue',
    WARN: 'yellow',
    ERROR: 'red',
};

// Leading icon for a message that doesn't bring its own, so every log line
// starts with one. `success` overrides INFO's with ✅.
const LEVEL_ICONS: Record<LogLevel, string> = {
    DEBUG: '🔍',
    INFO: 'ℹ️',
    WARN: '⚠️',
    ERROR: '❌',
};

// Messages left as-is: already icon-led, blank, or CLI layout lines — indented
// detail rows and `===` / `---` banners, where an icon would break alignment.
const NO_ICON_RE = /^(?:$|\s|[=-]|\p{Extended_Pictographic})/u;

const withIcon = (message: string, icon: string): string => (NO_ICON_RE.test(message) ? message : `${icon} ${message}`);

// Resolve the GUI fan-out sink. Electron main sets global.sendLogToGUI and
// the Capacitor bridge sets globalThis.sendLogToGUI; in Node `global` IS
// `globalThis`, so one lookup covers both surfaces.
const resolveGuiSink = (): GuiLogSink | null =>
    (globalThis as typeof globalThis & { sendLogToGUI?: GuiLogSink }).sendLogToGUI || null;

/**
 * Wrap text in an ANSI color. Only the console line is colored — the GUI
 * sink and the log files receive the plain message.
 */
const colorize = (text: string, color: ColorName): string => `${colors[color]}${text}${colors.reset}`;

/**
 * Format console output. Fixed-column order:
 *   [timestamp] [LEVEL] [CONTEXT] [category] message
 */
const formatConsoleMessage = (
    level: LogLevel,
    message: string,
    context: string,
    timestamp: string,
    category: string,
): string => {
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
 */
function sanitizeForLog(value: Record<string, unknown>): Record<string, unknown>;
function sanitizeForLog(value: unknown, depth?: number, seen?: WeakSet<object>): unknown;
function sanitizeForLog(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_SANITIZE_DEPTH) return '[Object]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeForLog(item, depth + 1, seen));
    }

    const out: Record<string, unknown> = {};
    const record = value as Record<string, unknown>;
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
const sanitizeLogString = (value: unknown, maxLength: number = 200): string =>
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

function redactMessage(message: string): string;
function redactMessage(message: unknown): unknown;
function redactMessage(message: unknown): unknown {
    if (typeof message !== 'string') return message;
    return message.replace(SENSITIVE_MSG_RE, (_match, key, sep) => `${key}${sep}${REDACTED}`);
}

// Ring buffer of recent log entries — drives the GUI Logs page on mount
// so users see the backlog since app start instead of "Waiting...". The
// monotonic seq lets the renderer de-dupe live messages that race the
// backlog fetch.
const MAX_RECENT = 1000;
const recentLogs: LogEntry[] = [];
let nextSeq = 1;

// Routes a log entry to the appropriate disk file. ERROR always wins
// over category-based routing so errors stay co-located across domains.
const routeLogFile = (level: LogLevel, category: string): string => {
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
 * @param icon - prefixed unless the message already leads with one
 */
const writeLog = (
    level: LogLevel,
    message: string,
    data: unknown = null,
    category: string | null = null,
    icon: string = LEVEL_ICONS[level],
) => {
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
        if (typeof message === 'string') message = withIcon(oneLine(message), icon);
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
const operations: Map<string, { startTime: number; message: string; level: LogLevel; category: string | null }> =
    new Map();

/**
 * @returns the start time (ms)
 */
const startOperation = (
    operationId: string,
    message: string,
    level: LogLevel = 'INFO',
    category: string | null = null,
): number => {
    const startTime = Date.now();
    operations.set(operationId, { startTime, message, level, category });
    writeLog(level, `🔄 ${message}...`, null, category);
    return startTime;
};

/**
 * @param errorMessage - non-empty marks the operation failed
 * @returns the duration (ms), or undefined for an unknown id
 */
const endOperation = (
    operationId: string,
    successMessage: string | null = null,
    errorMessage: string | null = null,
): number | undefined => {
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
 */
const buildProgressMessage = (message: string, current: number | null, total: number | null): string => {
    if (current === null || total === null) return message;
    const percentage = Math.round((current / total) * 100);
    const bar = '█'.repeat(Math.floor(percentage / 5)) + '░'.repeat(20 - Math.floor(percentage / 5));
    return `${message} [${bar}] ${percentage}% (${current}/${total})`;
};

// Initialize cleanup on module load
cleanupOldLogs();

// Set up periodic cleanup (every hour) only in actual application contexts
let cleanupInterval: ReturnType<typeof setInterval> | undefined;
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
    // Mission-aware join / fill / turbo automation.
    MISSIONS: 'missions',
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
export const error: (message: string, data?: unknown, category?: string | null) => void = (
    message,
    data,
    category,
): void => writeLog('ERROR', message, data, category);
export const info: (message: string, data?: unknown, category?: string | null) => void = (
    message,
    data,
    category,
): void => writeLog('INFO', message, data, category);
export const debug: (message: string, data?: unknown, category?: string | null) => void = (
    message,
    data,
    category,
): void => {
    if (apiOrDebugEnabled()) writeLog('DEBUG', message, data, category);
};
export const api: (message: string, data?: unknown, category?: string | null) => void = (
    message,
    data,
    category = 'api',
): void => {
    if (apiOrDebugEnabled()) writeLog('INFO', message, data, category);
};
// Enhanced logging methods
export const success: (message: string, data?: unknown, duration?: number | null, category?: string | null) => void = (
    message,
    data = null,
    duration = null,
    category = null,
): void => {
    const suffix = duration !== null ? ` (${duration}ms)` : '';
    writeLog('INFO', `${message}${suffix}`, data, category, '✅');
};
export const warning: (message: string, data?: unknown, category?: string | null) => void = (
    message,
    data = null,
    category = null,
): void => {
    writeLog('WARN', message, data, category);
};
export const progress: (message: string, current?: number | null, total?: number | null) => void = (
    message,
    current = null,
    total = null,
): void => {
    writeLog('INFO', buildProgressMessage(message, current, total), null, null);
};

/**
 * A logger bound to one category (withCategory).
 */
export type CategoryLogger = {
    info: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
    debug: (message: string, data?: unknown) => void;
    api: (message: string, data?: unknown) => void;
    apiRequest: (method: string, url: string, duration?: number | null) => void;
    apiResponse: (method: string, url: string, status: number, duration?: number | null) => void;
    success: (message: string, data?: unknown, duration?: number | null) => void;
    warning: (message: string, data?: unknown) => void;
    progress: (message: string, current?: number | null, total?: number | null) => void;
    startOperation: (operationId: string, message: string, level?: LogLevel) => number;
    endOperation: typeof endOperation;
};

// Category logging - creates a logger bound to a category
export const withCategory = (category: string): CategoryLogger => ({
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
        writeLog('INFO', `${message}${suffix}`, data, category, '✅');
    },
    warning: (message, data) => writeLog('WARN', message, data, category),
    progress: (message, current = null, total = null) => {
        writeLog('INFO', buildProgressMessage(message, current, total), null, category);
    },
    startOperation: (operationId, message, level = 'INFO') => startOperation(operationId, message, level, category),
    endOperation,
});
// API-specific logging with timing (top-level convenience)
export const apiRequest: (method: string, url: string, duration?: number | null) => void = (
    method,
    url,
    duration = null,
): void => {
    if (!apiOrDebugEnabled()) return;
    const suffix = duration !== null ? ` (${duration}ms)` : '';
    writeLog('INFO', `🌐 REQUEST: ${method} ${url}${suffix}`, null, 'api');
};
export const apiResponse: (method: string, url: string, status: number, duration?: number | null) => void = (
    method,
    url,
    status,
    duration = null,
): void => {
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
export const challengeTag = (
    challengeOrId: { id?: string | number; title?: string } | string | number | null | undefined,
    title?: string | null,
): string => {
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
/** @param date - YYYY-MM-DD */
export const getLogFileForDate = (date: string) => getLogFilePaths(date);
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
