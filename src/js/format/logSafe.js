/**
 * Log-safety formatting for untrusted values.
 *
 * Lives here rather than on the logger so that consumers can reach it without
 * depending on the logger's shape — the logger is jest-mocked in much of the suite,
 * and a sanitizer that silently disappears under a mock is worse than no sanitizer
 * at all (the mocked run stops exercising the escaping path entirely).
 */

/**
 * Collapse CR/LF in a value before it is interpolated into a log message.
 *
 * Anything sourced from the GuruShots API — challenge id, challenge title — must go
 * through this. A newline inside one would otherwise start what looks like a new
 * log entry in the plain-text log file, letting a crafted value forge log lines
 * (log injection, CWE-117).
 *
 * @param {*} value
 * @returns {string}
 */
const oneLine = (value) => String(value).replace(/[\r\n]+/g, ' ');

module.exports = { oneLine };
