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

// An ANSI escape sequence (CSI "ESC [ … final", or OSC "ESC ] … BEL/ST"). Built
// from the ESC code point rather than written as a literal, so the pattern
// holds no control character.
const ESC = String.fromCharCode(27);
const ANSI_SEQUENCE = new RegExp(`${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)?)`, 'g');

// The left-to-right and right-to-left marks and the Arabic letter mark, the bidi
// embedding, override and isolate controls, and the zero-width space, word joiner
// and zero-width no-break space (the BOM).
const BIDI_AND_ZERO_WIDTH = /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/**
 * Text from an untrusted source made safe to print to a terminal: ANSI
 * sequences are removed whole, line breaks and tabs become a space, and any
 * other control character (the C1 range included), the bidi controls and the
 * zero-width spaces are dropped, so the value can neither drive the terminal,
 * forge extra output lines, nor reorder or hide what is printed. The joiners
 * (ZWJ, ZWNJ) stay: emoji sequences and Persian text need them.
 */
const stripTerminalControl = (value: unknown): string =>
    String(value)
        .replace(ANSI_SEQUENCE, '')
        .replace(/[\t\r\n\v\f\u0085\u2028\u2029]+/g, ' ')
        .replace(/\p{Cc}/gu, '')
        .replace(BIDI_AND_ZERO_WIDTH, '');

/** Sentence-case a log's first word, including after a logger icon. */
const sentenceCaseLogMessage = (message: string): string => {
    const challenge = /^((?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s+)*)(\[Challenge [^\]]+\]\s+)(.+)$/u.exec(
        message,
    );
    if (challenge) return `${challenge[1]}${challenge[2]}${sentenceCaseLogMessage(challenge[3])}`;
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

export { oneLine, failureText, stripTerminalControl, sentenceCaseLogMessage };
