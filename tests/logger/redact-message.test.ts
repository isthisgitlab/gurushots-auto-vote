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

    test('an identifier value ends at a semicolon, a closing bracket or the end of the line, not at a comma', () => {
        expect(redactMessage('user (username: alice b), retrying')).toBe('user (username: [REDACTED]), retrying');
        expect(redactMessage('phone: +371 20000000; email: a@b.c, ok')).toBe('phone: [REDACTED]; email: [REDACTED]');
        expect(redactMessage('email: Smith, John <a@b.c>')).toBe('email: [REDACTED]');
        expect(redactMessage('login: alice b\nnext line')).toBe('login: [REDACTED]\nnext line');
    });

    test.each([
        ['Authorization: Bearer abc123', 'Authorization: [REDACTED]'],
        ['authorization=Bearer xyz', 'authorization=[REDACTED]'],
        ['authorization: Basic dXNlcjpwYXNz', 'authorization: [REDACTED]'],
        ['authorization: Token abc123 sent', 'authorization: [REDACTED] sent'],
        ['authorization: bearer abc123', 'authorization: [REDACTED]'],
        ['authorization: "Bearer abc123"', 'authorization: [REDACTED]'],
        ['authorization: Bearer', 'authorization: [REDACTED]'],
    ])('redacts the credential itself, not just its auth scheme, in %s', (message, expected) => {
        const out = redactMessage(message);
        expect(out).toBe(expected);
        expect(out).not.toMatch(/abc123|xyz|dXNlcjpwYXNz/);
    });

    test.each([
        ['{"email":"a@b.c"}', '{"email":[REDACTED]}'],
        ['{"token": "abc123", "ok": true}', '{"token": [REDACTED], "ok": true}'],
        ['{"password":"p w","user":1}', '{"password":[REDACTED],"user":1}'],
        ["{'login':'alice b'}", "{'login':[REDACTED]}"],
        ['{"authorization":"Bearer abc123"}', '{"authorization":[REDACTED]}'],
        // An unquoted value runs to whitespace, so the rest of a compact JSON line goes with it: never a part left behind.
        ['{"token":12345,"ok":true}', '{"token":[REDACTED]'],
    ])('redacts a JSON-style quoted key in message text: %s', (message, expected) => {
        expect(redactMessage(message)).toBe(expected);
    });

    test.each([
        ['{"password":"a\\"b c"}', '{"password":[REDACTED]}'],
        ["{'secret':'it\\'s a b'}", "{'secret':[REDACTED]}"],
        ['{"login":"al\\"ice b","ok":true}', '{"login":[REDACTED],"ok":true}'],
        ['{"cookie":"a=\\"b\\"; c=d","ok":1}', '{"cookie":[REDACTED],"ok":1}'],
        ['password: "a\\\\" then more', 'password: [REDACTED] then more'],
    ])('a quoted value ends at its closing quote, an escaped quote inside it included: %s', (message, expected) => {
        const out = redactMessage(message);
        expect(out).toBe(expected);
        expect(out).not.toMatch(/b c|a b|ice b|c=d/);
    });

    test.each([
        ['cookie: sid=abc123; theme=dark; token=xyz', 'cookie: [REDACTED]'],
        ['Set-Cookie: sid=abc123; Path=/; HttpOnly  ', 'Set-Cookie: [REDACTED]  '],
        ['set_cookie=sid=abc123; Secure', 'set_cookie=[REDACTED]'],
        ['cookie: a=b\nnext line', 'cookie: [REDACTED]\nnext line'],
        ['sent cookie: sid=abc123 for alice', 'sent cookie: [REDACTED]'],
    ])('a cookie value runs to the end of the line: %s', (message, expected) => {
        const out = redactMessage(message);
        expect(out).toBe(expected);
        expect(out).not.toMatch(/abc123|theme|HttpOnly|xyz|alice/);
    });

    test('a banner line with a cookie word is left alone', () => {
        expect(redactMessage('=== Cookie ===')).toBe('=== Cookie ===');
        expect(redactMessage('cookies: 3')).toBe('cookies: 3');
    });

    test('a message that merely says a token is kept is not mangled', () => {
        const message = 'Kept the saved login token because a CLI session is running and may be using it';
        expect(redactMessage(message)).toBe(message);
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

    test.each([
        ['retrying with Bearer eyJhbGciOi.payload.sig', 'retrying with Bearer [REDACTED]'],
        ['sent bearer   a1B2c3D4e5F6g7H8 ok', 'sent bearer [REDACTED] ok'],
        ['header Basic dXNlcjpwYXNz', 'header Basic [REDACTED]'],
        ['BEARER abcdEFGHijkl0123456789==', 'BEARER [REDACTED]'],
    ])('redacts a bare auth scheme and its credential: %s', (message, expected) => {
        const out = redactMessage(message);
        expect(out).toBe(expected);
        expect(out).not.toMatch(/eyJ|a1B2|dXNl|abcdEFGH/);
    });

    test.each([
        'Basic Black and White',
        'Ring Bearer Portraits',
        'Joined Basic Photography (id 12)',
        'Basic Cinematography',
        'Basic Extraordinarily',
        'Bearer Extraordinarily Beautiful',
        'Bearer abc123',
        'basic abc',
        'the bearer',
        'basic   ',
    ])('a title or tag that merely says bearer or basic is left alone: %s', (message) => {
        expect(redactMessage(message)).toBe(message);
    });

    // The thresholds are a choice: a bearer token is 16 or more characters of its alphabet, Basic credentials are 12 or
    // more base64 characters (padding not counted), and either must hold more than letters (a capital after the first
    // character, a digit or a symbol), so an ordinary long word after the scheme is never taken for one.
    test.each([
        ['Bearer aB3dEf6hIj9lMno', 'Bearer aB3dEf6hIj9lMno'],
        ['Bearer aB3dEf6hIj9lMnop', 'Bearer [REDACTED]'],
        ['Bearer aB3dEf6hIj9lMno=', 'Bearer aB3dEf6hIj9lMno='],
        ['Bearer aB3dEf6hIj9lMnop==', 'Bearer [REDACTED]'],
        ['Bearer counterintuitively', 'Bearer counterintuitively'],
        ['Bearer Counterintuitively', 'Bearer Counterintuitively'],
        ['Bearer counter-intuitively', 'Bearer [REDACTED]'],
        ['Basic dXNlcjpwYXN', 'Basic dXNlcjpwYXN'],
        ['Basic dXNlcjpwYXN=', 'Basic dXNlcjpwYXN='],
        ['Basic dXNlcjpwYXNz', 'Basic [REDACTED]'],
        ['Basic dXNlcjpwYXNzd29yZA==', 'Basic [REDACTED]'],
        ['Basic Photographers', 'Basic Photographers'],
        ['Basic photographers', 'Basic photographers'],
    ])('the credential-shape thresholds: %s', (message, expected) => {
        expect(redactMessage(message)).toBe(expected);
    });

    test('a "Login: 3 joined, 2 failed" banner is redacted to the end of the field: a deliberate over-redaction', () => {
        expect(redactMessage('Login: 3 joined, 2 failed')).toBe('Login: [REDACTED]');
        expect(redactMessage('login: 3 joined; 2 failed')).toBe('login: [REDACTED]; 2 failed');
    });

    test('a long run of spaces after a key is redacted in linear time', () => {
        const spaces = ' '.repeat(8192);
        const started = Date.now();
        for (const key of ['email', 'login', 'cookie', 'password', 'bearer']) {
            expect(redactMessage(`${key}:${spaces}`)).toBe(`${key}:${spaces}`);
            expect(redactMessage(`${key}:${spaces}x`)).toBe(`${key}:${spaces}[REDACTED]`);
            expect(redactMessage(`${key}=a${spaces}`)).toBe(`${key}=[REDACTED]${spaces}`);
        }
        // The quadratic form needed about a second for each 8 KiB case; the linear one needs microseconds.
        expect(Date.now() - started).toBeLessThan(1000);
    });

    test.each([['bearer'], ['basic']])('a long run of spaces after %s is handled in linear time', (scheme) => {
        const started = Date.now();
        expect(redactMessage(`${scheme}${' '.repeat(50000)}`)).toBe(`${scheme}${' '.repeat(50000)}`);
        expect(Date.now() - started).toBeLessThan(1000);
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
