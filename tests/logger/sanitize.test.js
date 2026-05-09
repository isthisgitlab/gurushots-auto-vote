/**
 * sanitizeForLog covers the redaction contract that protects on-disk logs
 * from leaking auth tokens / passwords. Each test below maps to one
 * branch: leaf primitives, object key matching, deep recursion guard,
 * cycle guard, array handling, and case-insensitive matching.
 */

const { sanitizeForLog } = jest.requireActual('../../src/js/logger.js');

describe('sanitizeForLog', () => {
    test('returns primitives unchanged', () => {
        expect(sanitizeForLog(null)).toBeNull();
        expect(sanitizeForLog(undefined)).toBeUndefined();
        expect(sanitizeForLog(0)).toBe(0);
        expect(sanitizeForLog('hello')).toBe('hello');
        expect(sanitizeForLog(true)).toBe(true);
    });

    test('redacts top-level sensitive keys', () => {
        const input = { token: 'abc123', name: 'alice' };
        expect(sanitizeForLog(input)).toEqual({ token: '[REDACTED]', name: 'alice' });
    });

    test('redacts nested sensitive keys', () => {
        const input = { user: { name: 'bob', password: 'hunter2' } };
        expect(sanitizeForLog(input)).toEqual({
            user: { name: 'bob', password: '[REDACTED]' },
        });
    });

    test('redacts every documented sensitive key (case-insensitive)', () => {
        const input = {
            token: 't',
            authToken: 'a',
            password: 'p',
            apiKey: 'k',
            secret: 's',
            cookie: 'c',
            authorization: 'z',
            TOKEN: 't2',
            Password: 'p2',
        };
        const out = sanitizeForLog(input);
        for (const key of Object.keys(input)) {
            expect(out[key]).toBe('[REDACTED]');
        }
    });

    test('redacts OAuth-style underscored names returned by the GuruShots auth API', () => {
        // actions.handlers.js:90 logs the raw response which can carry
        // access_token / auth_token / refresh_token alongside `token`.
        // Cover the underscored, dashed, and case-varied shapes.
        const input = {
            access_token: 'a',
            auth_token: 'b',
            refresh_token: 'c',
            'access-token': 'd',
            ACCESS_TOKEN: 'e',
            bearer: 'f',
            api_key: 'g',
            'x-auth-token': 'h',
        };
        const out = sanitizeForLog(input);
        for (const key of Object.keys(input)) {
            expect(out[key]).toBe('[REDACTED]');
        }
    });

    test('does not redact keys that merely contain a sensitive substring', () => {
        const input = { tokenizer: 'safe', userPassword: 'hunter2', authTokenList: [] };
        const out = sanitizeForLog(input);
        expect(out.tokenizer).toBe('safe');
        expect(out.userPassword).toBe('hunter2');
        expect(out.authTokenList).toEqual([]);
    });

    test('redacts inside arrays of objects', () => {
        const input = [
            { name: 'a', token: 'x' },
            { name: 'b', token: 'y' },
        ];
        expect(sanitizeForLog(input)).toEqual([
            { name: 'a', token: '[REDACTED]' },
            { name: 'b', token: '[REDACTED]' },
        ]);
    });

    test('truncates beyond max depth (6) to avoid pathological inputs', () => {
        const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } };
        const out = sanitizeForLog(deep);
        // Depths 0..5 traverse; depth 6 returns the sentinel.
        expect(out.a.b.c.d.e.f).toBe('[Object]');
    });

    test('handles circular references without stack overflow', () => {
        const obj = { name: 'cycle', token: 'leak' };
        obj.self = obj;
        const out = sanitizeForLog(obj);
        expect(out.name).toBe('cycle');
        expect(out.token).toBe('[REDACTED]');
        expect(out.self).toBe('[Circular]');
    });

    test('does not mutate the input object', () => {
        const input = { token: 'plain', user: { password: 'hunter2' } };
        const snapshot = JSON.parse(JSON.stringify(input));
        sanitizeForLog(input);
        expect(input).toEqual(snapshot);
    });
});
