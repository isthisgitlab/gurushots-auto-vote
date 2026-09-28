/**
 * Log-safety formatting for untrusted values.
 *
 * Lives here rather than on the logger so that consumers can reach it without
 * depending on the logger's shape — the logger is jest-mocked in much of the suite,
 * and a sanitizer that silently disappears under a mock is worse than no sanitizer
 * at all (the mocked run stops exercising the escaping path entirely).
 */

import { errorMessage } from '../errorMessage';

/**
 * Collapse line-breaking characters in a value before it is interpolated into a
 * log message.
 *
 * Anything sourced from the GuruShots API — challenge id, challenge title — must go
 * through this. A newline inside one would otherwise start what looks like a new
 * log entry in the plain-text log file, letting a crafted value forge log lines
 * (log injection, CWE-117).
 *
 * Collapses CR/LF plus the other characters a log viewer might treat as a line
 * break — vertical tab, form feed, NEL (U+0085), and the Unicode line/paragraph
 * separators (U+2028/U+2029) — not just \r\n.
 */
const oneLine = (value: unknown): string => String(value).replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ');

/** Sentence-case a log's first word, including after a logger icon. */
const sentenceCaseLogMessage = (message: string): string => {
    const match = /^((?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s+)*)(\p{Ll}[\p{L}\p{N}-]*)/u.exec(message);
    if (!match) return message;
    const [, icon, word] = match;
    const rest = message.slice(match[0].length);
    // A leading URL, key or product name is data rather than a sentence.
    if (word === 'macOS' || /^(?::\/\/|[.=])/.test(rest)) return message;
    // Keep operation names and command names exact; case the description instead.
    if (/[A-Z]/.test(word.slice(1)) || /^(?:main|swap|swap-back|skip-version)$/.test(word)) {
        if (rest.startsWith(': ')) return `${icon}${word}: ${sentenceCaseLogMessage(rest.slice(2))}`;
        if (rest.startsWith(' ')) return `${icon}${word}: ${sentenceCaseLogMessage(rest.slice(1))}`;
        return message;
    }
    return `${icon}${word[0].toUpperCase()}${word.slice(1)}${rest}`;
};

/**
 * Text for a caught value in a failure log line: its `message`, else the value
 * itself as text, else 'unknown error'. Never empty — `logger.endOperation`
 * records an operation as completed when its error text is empty, so a
 * rejection with null, undefined or '' must still read as a failure.
 *
 * @param error - anything a promise can reject with
 */
const failureText = (error: unknown): string => errorMessage(error) || String(error ?? '') || 'unknown error';

export { oneLine, failureText, sentenceCaseLogMessage };
