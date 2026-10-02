import { formatTimeHMS } from '../dateFormat';

import type { LogLevel } from './types';

export type ColorName = keyof typeof colors;

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

// Messages left without an added icon: already icon-led, blank, or CLI layout lines — indented
// detail rows and `===` / `---` banners, where an icon would break alignment.
const NO_ICON_RE = /^(?:$|\s|[=-]|\p{Extended_Pictographic})/u;

const withIcon = (message: string, icon: string): string => (NO_ICON_RE.test(message) ? message : `${icon} ${message}`);

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

/**
 * Build a progress message with optional [bar] suffix.
 */
const buildProgressMessage = (message: string, current: number | null, total: number | null): string => {
    if (current === null || total === null) return message;
    const percentage = Math.round((current / total) * 100);
    const bar = '█'.repeat(Math.floor(percentage / 5)) + '░'.repeat(20 - Math.floor(percentage / 5));
    return `${message} [${bar}] ${percentage}% (${current}/${total})`;
};

export { formatConsoleMessage, getTimeString, withIcon, buildProgressMessage, LEVEL_ICONS };
