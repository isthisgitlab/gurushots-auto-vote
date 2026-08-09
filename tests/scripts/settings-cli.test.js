/**
 * Regression tests for scripts/settings-cli.js secret redaction.
 *
 * `pnpm settings:get token` and the bare `pnpm settings:get` dump used to
 * print the raw auth token. Both branches must now redact sensitive keys
 * via logger.sanitizeForLog, with --reveal as the explicit opt-out.
 *
 * The script runs main() at require time and exits via process.exit, so
 * each case stubs process.argv/exit, requires the script in an isolated
 * module registry, and flushes the async main() before asserting.
 */

jest.mock('../../src/js/settings', () => ({
    loadSettings: jest.fn(() => ({
        token: 'super-secret-token',
        theme: 'dark',
        apiHeaders: { authorization: 'Bearer abc' },
    })),
    SETTINGS_SCHEMA: {},
}));

// Faithful stand-in for the logger's key-based deep redaction (the real
// implementation is exercised by the logger's own tests); everything else
// the script may touch is inert.
jest.mock('../../src/js/logger', () => {
    const SENSITIVE_KEY_RE = /^(token|auth[_-]?token|password|api[_-]?key|secret|cookie|authorization)$/i;
    const sanitizeForLog = (value) => {
        if (value === null || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map(sanitizeForLog);
        const out = {};
        for (const key of Object.keys(value)) {
            out[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : sanitizeForLog(value[key]);
        }
        return out;
    };
    return { sanitizeForLog };
});

jest.mock('../../src/js/cli/parseValue', () => ({ parseSettingValue: jest.fn((v) => v) }));
jest.mock('../../src/js/cli/commands/settings', () => ({
    dumpSchema: jest.fn(),
    listGlobalDefaults: jest.fn(),
}));

const runScript = async (...argv) => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const originalArgv = process.argv;
    process.argv = ['node', 'settings-cli.js', ...argv];
    try {
        jest.isolateModules(() => {
            require('../../scripts/settings-cli.js');
        });
        // main() is async; flush its promise chain before asserting.
        await new Promise((resolve) => setImmediate(resolve));
        return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    } finally {
        process.argv = originalArgv;
        logSpy.mockRestore();
        errorSpy.mockRestore();
        exitSpy.mockRestore();
    }
};

describe('settings-cli secret redaction', () => {
    test('get <sensitive key> prints [REDACTED], not the raw token', async () => {
        const output = await runScript('get', 'token');

        expect(output).toContain('[REDACTED]');
        expect(output).not.toContain('super-secret-token');
    });

    test('bare get (dump-all) redacts sensitive keys at every depth', async () => {
        const output = await runScript('get');

        expect(output).toContain('All Settings:');
        expect(output).toContain('[REDACTED]');
        expect(output).not.toContain('super-secret-token');
        expect(output).not.toContain('Bearer abc');
        // Non-sensitive values still print normally.
        expect(output).toContain('dark');
    });

    test('get token --reveal prints the raw value (explicit opt-out)', async () => {
        const output = await runScript('get', 'token', '--reveal');

        expect(output).toContain('super-secret-token');
        expect(output).not.toContain('[REDACTED]');
    });

    test('bare get --reveal dumps raw values', async () => {
        const output = await runScript('get', '--reveal');

        expect(output).toContain('super-secret-token');
        expect(output).toContain('Bearer abc');
    });

    test('non-sensitive keys are unaffected by redaction', async () => {
        const output = await runScript('get', 'theme');

        expect(output).toContain('dark');
        expect(output).not.toContain('[REDACTED]');
    });
});
