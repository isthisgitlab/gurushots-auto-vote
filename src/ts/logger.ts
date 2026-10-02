import { oneLine } from './format/logSafe';
import { isSourceCode, getAppName, getContext, setContext, clearContext, devMode, cliMode } from './logger/context';
import { currentLogFiles, cleanupOldLogs } from './logger/files';
import { buildProgressMessage } from './logger/format';
import { sanitizeForLog, sanitizeLogString, redactMessage } from './logger/sanitize';
import { writeLog, startOperation, endOperation, getRecentLogs } from './logger/write';

import type { LogLevel } from './logger/types';

export type { ColorName } from './logger/format';
export type { LogLevel, LogEntry, GuiLogEntry, GuiLogSink } from './logger/types';

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
export const isCliMode = () => cliMode;
export const isDevMode = () => devMode;
export {
    LOG_CATEGORIES as CATEGORIES,
    getRecentLogs,
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
