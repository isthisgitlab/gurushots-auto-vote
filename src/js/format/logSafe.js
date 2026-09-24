/**
 * Log-safety formatting for untrusted values.
 *
 * Lives here rather than on the logger so that consumers can reach it without
 * depending on the logger's shape — the logger is jest-mocked in much of the suite,
 * and a sanitizer that silently disappears under a mock is worse than no sanitizer
 * at all (the mocked run stops exercising the escaping path entirely).
 */

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
 *
 * @param {*} value
 * @returns {string}
 */
const oneLine = (value) => String(value).replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ');

/**
 * Text for a caught value in a failure log line: its `message`, else the value
 * itself as text, else 'unknown error'. Never empty — `logger.endOperation`
 * records an operation as completed when its error text is empty, so a
 * rejection with null, undefined or '' must still read as a failure.
 *
 * @param {unknown} error - anything a promise can reject with
 * @returns {string}
 */
const failureText = (error) => {
    const message = /** @type {{ message?: unknown } | null | undefined} */ (error)?.message;
    return (message && String(message)) || String(error ?? '') || 'unknown error';
};

module.exports = { oneLine, failureText };
