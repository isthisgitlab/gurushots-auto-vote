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

/**
 * Text from an untrusted source made safe to print to a terminal: ANSI sequences are
 * removed whole, every other control character (the C1 range included) and every
 * invisible format character (`\p{Cf}`: the bidi controls, zero-width spaces, word
 * joiner, invisible operators, the soft hyphen, interlinear annotation marks, the
 * tag characters) is dropped, so the value can neither drive the terminal nor
 * reorder or hide what is printed. The two joiners, ZWJ (U+200D) and ZWNJ
 * (U+200C), stay: emoji sequences and Persian text need them.
 *
 * Line breaks and tabs become a space, so the value cannot forge extra output lines —
 * unless `keepLayout` is set, for a document whose own lines are wanted: then `\n` and
 * `\t` stay, and the other line separators (CR, CRLF, VT, FF, NEL, LS, PS) become `\n`.
 */
const stripTerminalControl = (value: unknown, { keepLayout = false }: { keepLayout?: boolean } = {}): string => {
    const text = String(value).replace(ANSI_SEQUENCE, '');
    const laidOut = keepLayout
        ? text.replace(/\r\n?|[\v\f\u0085\u2028\u2029]/g, '\n')
        : text.replace(/[\t\r\n\v\f\u0085\u2028\u2029]+/g, ' ');
    return laidOut.replace(/(?![\n\t\u200C\u200D])[\p{Cc}\p{Cf}]/gu, '');
};

/**
 * A JSON document made safe to print: every character `stripTerminalControl` would drop (control,
 * C1, invisible format characters, the Unicode line and paragraph separators) becomes its
 * `\uXXXX` escape — a surrogate pair above the BMP. Inside a JSON string that is the same value,
 * so the document parses back unchanged and prints the same on a terminal as it is written to a
 * file, where stripping would have altered the data. Layout whitespace and the two joiners stay.
 */
const escapeTerminalUnsafe = (json: string): string =>
    json.replace(/(?![\n\r\t\u200C\u200D])[\p{Cc}\p{Cf}\u2028\u2029]/gu, (char) =>
        Array.from({ length: char.length }, (_, i) => `\\u${char.charCodeAt(i).toString(16).padStart(4, '0')}`).join(
            '',
        ),
    );

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

export { oneLine, failureText, stripTerminalControl, escapeTerminalUnsafe, sentenceCaseLogMessage };
