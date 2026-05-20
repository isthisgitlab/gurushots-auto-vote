/**
 * redactMessage scrubs sensitive `key: value` / `key=value` pairs out of a
 * free-form log *message* string before it reaches disk or the ring buffer.
 *
 * This closes the gap sanitizeForLog leaves: sanitizeForLog only redacts
 * keys of the structured `data` object, never the message string. Callers
 * that fold credentials into the message via positional args (the renderer
 * login shim was one) would otherwise leak plaintext to the log file.
 */

const { redactMessage, info, getRecentLogs } = jest.requireActual('../../src/js/logger.js');

describe('redactMessage', () => {
    test('returns benign messages unchanged', () => {
        expect(redactMessage('GET /challenges → 200')).toBe('GET /challenges → 200');
        expect(redactMessage('user alice logged in')).toBe('user alice logged in');
    });

    test('redacts a value following a sensitive key with = separator', () => {
        expect(redactMessage('auth token=abc123 done')).toBe('auth token=[REDACTED] done');
    });

    test('redacts a value following a sensitive key with : separator', () => {
        expect(redactMessage('password: hunter2')).toBe('password: [REDACTED]');
    });

    test('redacts quoted values, consuming the quotes', () => {
        expect(redactMessage('access_token = "xyz789"')).toBe('access_token = [REDACTED]');
    });

    test('redacts OAuth-style underscored token names', () => {
        expect(redactMessage('refresh_token=foo')).toBe('refresh_token=[REDACTED]');
    });

    test('is case-insensitive on the key', () => {
        expect(redactMessage('PASSWORD=s3cr3t')).toBe('PASSWORD=[REDACTED]');
    });

    test('does not redact keys that merely contain a sensitive substring', () => {
        expect(redactMessage('tokenizer: fast')).toBe('tokenizer: fast');
    });

    test('returns non-string input unchanged', () => {
        expect(redactMessage(null)).toBeNull();
        expect(redactMessage(42)).toBe(42);
    });
});

describe('writeLog applies redactMessage to the message string', () => {
    test('a credential folded into the message is redacted in the ring buffer', () => {
        info('login token=topsecret123 ok', null, 'authentication');
        const entries = getRecentLogs();
        const last = entries[entries.length - 1];
        expect(last.message).not.toContain('topsecret123');
        expect(last.message).toContain('[REDACTED]');
    });
});
