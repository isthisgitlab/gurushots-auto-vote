/**
 * The debug log of a dirty build (core/buildInfo.ts): `logs/debug-<date>.log`, with everything the app does at its
 * edges written down as it is — IPC calls, API requests and responses with their headers, errors, and a copy of
 * every log entry. Nothing is redacted or cut short; only terminal control is escaped (see writeDebug). A release
 * build writes no such file.
 *
 * Only the Node platforms have a logs directory, so the Android WebView writes nothing.
 */

import * as fs from 'node:fs';
import { isDirtyBuild } from '../buildInfo';
import { errorMessage } from '../errorMessage';
import { escapeTerminalUnsafe, stripTerminalControl } from '../format/logSafe';
import { writeConsole } from './consoleSink';
import { getContext } from './context';
import { debugLogPath, logsDir } from './files';

import type { LogLevel } from './types';

/**
 * Whether the debug log is being written: a dirty build with a logs directory.
 */
const debugLogEnabled = (): boolean => logsDir !== '' && isDirtyBuild();

/**
 * The kind of a mirrored log entry.
 */
const logKind = (level: LogLevel, category: string | null | undefined): string =>
    `log:${level}:${category || 'general'}`;

/**
 * JSON.stringify's replacer for a debug record: a cycle becomes "[Circular]" (only a real cycle — a value reached
 * twice through different paths is written both times), an Error its name, message and stack, a BigInt its digits.
 */
const jsonReplacer = (): ((this: unknown, key: string, value: unknown) => unknown) => {
    const ancestors: unknown[] = [];
    return function (this: unknown, _key, value) {
        if (typeof value === 'bigint') return value.toString();
        const shown = value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
        if (typeof shown !== 'object' || shown === null) return shown;
        // `this` is the object holding this value, so everything above it in the stack has been closed.
        while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
        if (ancestors.includes(shown)) return '[Circular]';
        ancestors.push(shown);
        return shown;
    };
};

const dataText = (data: unknown): string => {
    // A bare string is written as it is, like the normal log file does, so its control characters are stripped.
    if (typeof data === 'string') return stripTerminalControl(data);
    // Control, C1, bidi and other invisible characters inside the document's strings become \uXXXX escapes.
    return escapeTerminalUnsafe(JSON.stringify(data, jsonReplacer()) ?? String(data));
};

// The first failure is reported on the console; reporting every one would bury it under a failing disk's noise.
let failureReported = false;

/**
 * Appends one record to today's debug log: `[timestamp] [kind] [CLI|GUI] message`, then the data as JSON on the next
 * line. A no-op unless the debug log is enabled. Synchronous, so a record written just before `process.exit` lands.
 *
 * Never throws, and reports a failure only through the console sink, once per process: a report through the logger
 * would come back here.
 *
 * @param kind - what the record is: `ipc-in`, `api-out`, `log:<LEVEL>:<category>`, …
 * @param data - written raw: no redaction, no length cap
 */
const writeDebug = (kind: string, message: string, data?: unknown): void => {
    try {
        if (!debugLogEnabled()) return;
        const header = `[${new Date().toISOString()}] [${kind}] [${getContext()}] ${stripTerminalControl(message)}`;
        const body = data === undefined || data === null ? '' : `\n${dataText(data)}`;
        fs.appendFileSync(debugLogPath(), `${header}${body}\n`, { mode: 0o600 });
    } catch (error) {
        if (failureReported) return;
        failureReported = true;
        writeConsole('error', '[logger] could not write the debug log:', errorMessage(error));
    }
};

export { writeDebug, debugLogEnabled, logKind };
