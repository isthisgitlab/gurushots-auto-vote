/**
 * redactMessage scrubs sensitive `key: value` / `key=value` pairs out of a
 * free-form log *message* string before it reaches disk or the ring buffer.
 *
 * This closes the gap sanitizeForLog leaves: sanitizeForLog only redacts
 * keys of the structured `data` object, never the message string. Callers
 * that fold credentials into the message via positional args would otherwise
 * leak plaintext to the log file.
 */

import type * as LoggerModule from '../../src/ts/logger';

const { redactMessage, info, getRecentLogs }: typeof LoggerModule =
    jest.requireActual<typeof import('../../src/ts/logger')>('../../src/ts/logger');

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

    test.each([
        ['email=person@example.com', 'email=[REDACTED]'],
        ['login: person@example.com', 'login: [REDACTED]'],
        ['user_name = "alice b"', 'user_name = [REDACTED]'],
        ['username: alice b', 'username: [REDACTED]'],
        ['username=alice', 'username=[REDACTED]'],
        ['user-name: alice', 'user-name: [REDACTED]'],
        ['Phone: +371 20000000', 'Phone: [REDACTED]'],
        ['phone: +371 2000 0000 trailing  ', 'phone: [REDACTED]  '],
        ['phone="+371 20000000"', 'phone=[REDACTED]'],
    ])('redacts the account identifier in %s', (message, expected) => {
        expect(redactMessage(message)).toBe(expected);
    });

    test('an identifier value ends at a comma, a semicolon, a closing bracket or the end of the line', () => {
        expect(redactMessage('user (username: alice b), retrying')).toBe('user (username: [REDACTED]), retrying');
        expect(redactMessage('phone: +371 20000000; email: a@b.c, ok')).toBe(
            'phone: [REDACTED]; email: [REDACTED], ok',
        );
        expect(redactMessage('login: alice b\nnext line')).toBe('login: [REDACTED]\nnext line');
    });

    test('a credential value still ends at whitespace', () => {
        expect(redactMessage('password: hunter2 for alice')).toBe('password: [REDACTED] for alice');
    });

    test('does not redact words that merely start with an identifier key', () => {
        expect(redactMessage('emailed: yes')).toBe('emailed: yes');
        expect(redactMessage('login screen shown')).toBe('login screen shown');
    });

    test('leaves a banner line alone but still redacts a value that starts with =', () => {
        expect(redactMessage('=== Login ===')).toBe('=== Login ===');
        expect(redactMessage('token==abc')).toBe('token=[REDACTED]');
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
