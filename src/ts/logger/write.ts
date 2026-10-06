import * as fs from 'node:fs';
import { oneLine, sentenceCaseLogMessage, stripTerminalControl } from '../format/logSafe';
import { getContext } from './context';
import { writeConsole } from './consoleSink';
import { logsDir, currentLogFiles } from './files';
import { formatConsoleMessage, getTimeString, withIcon, LEVEL_ICONS } from './format';
import { sanitizeForLog, redactMessage } from './sanitize';

import type { GuiLogSink, LogEntry, LogLevel } from './types';

// Resolve the GUI fan-out sink. Electron main sets global.sendLogToGUI and
// the Capacitor bridge sets globalThis.sendLogToGUI; in Node `global` IS
// `globalThis`, so one lookup covers both surfaces.
const resolveGuiSink = (): GuiLogSink | null =>
    (globalThis as typeof globalThis & { sendLogToGUI?: GuiLogSink }).sendLogToGUI || null;

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
        if (typeof message === 'string') message = sentenceCaseLogMessage(withIcon(oneLine(message), icon));
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
                fs.appendFileSync(target, line, { mode: 0o600 });
            } catch {
                // best-effort; never let a log write tear down the app.
            }
        }

        writeConsole('log', formatConsoleMessage(level, message, context, getTimeString(), cat));

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
        writeConsole('error', 'Error writing log entry:', error);
    }
};

/**
 * Write a line to the console only: no log file, ring buffer or GUI feed. For
 * output a command was asked for (a long listing) that must not be persisted.
 * Credentials folded into the text are redacted like any log message; untrusted
 * content is otherwise printed as given, so callers strip it themselves.
 */
const printLine = (text: string): void => writeConsole('log', redactMessage(text));

/**
 * Write a note to the console's error stream only (stderr; redacted, like printLine). For a
 * warning that belongs next to a document printed on stdout without ending up inside it,
 * so that piping the document stays valid.
 */
const printStderr = (text: string): void => writeConsole('error', redactMessage(text));

/**
 * Write a document the user asked for (help, a scenario's JSON) to the console only,
 * exactly as it is: line breaks and tabs kept, nothing redacted — redaction would
 * corrupt JSON, and these documents hold no credentials — and every other control
 * character stripped so the text cannot drive the terminal. Never in the log file,
 * the ring buffer or the GUI feed. Use printLine for anything that might carry a
 * credential.
 */
const printDocument = (text: string): void => writeConsole('log', stripTerminalControl(text, { keepLayout: true }));

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

// Ring buffer accessor — drives GUI backlog replay on mount.
const getRecentLogs = () => recentLogs.slice();

export { writeLog, printLine, printStderr, printDocument, startOperation, endOperation, getRecentLogs };
