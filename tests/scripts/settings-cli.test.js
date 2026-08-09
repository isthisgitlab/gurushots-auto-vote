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

// The GUI-reload notice probes for a running Electron via pgrep — never
// spawn a real process from a unit test (it also outlives the test and
// trips "Cannot log after tests are done"). Close immediately with a
// non-zero code = "GUI not running".
jest.mock('node:child_process', () => ({
    spawn: jest.fn(() => ({
        kill: jest.fn(),
        on: (event, cb) => {
            if (event === 'close') cb(1);
        },
    })),
}));

jest.mock('../../src/js/cli/parseValue', () => ({ parseSettingValue: jest.fn((v) => v) }));
jest.mock('../../src/js/cli/commands/settings', () => ({
    dumpSchema: jest.fn(),
    listGlobalDefaults: jest.fn(),
    setSetting: jest.fn(() => true),
    setGlobalDefault: jest.fn(() => true),
    resetSetting: jest.fn(() => true),
    resetGlobalDefault: jest.fn(() => true),
    resetAllSettings: jest.fn(() => true),
}));

const sharedCommands = require('../../src/js/cli/commands/settings');

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
        return {
            output: logSpy.mock.calls.map((c) => c.join(' ')).join('\n'),
            exitCalls: exitSpy.mock.calls.map((c) => c[0]),
        };
    } finally {
        process.argv = originalArgv;
        logSpy.mockRestore();
        errorSpy.mockRestore();
        exitSpy.mockRestore();
    }
};

describe('settings-cli secret redaction', () => {
    test('get <sensitive key> prints [REDACTED], not the raw token', async () => {
        const { output } = await runScript('get', 'token');

        expect(output).toContain('[REDACTED]');
        expect(output).not.toContain('super-secret-token');
    });

    test('bare get (dump-all) redacts sensitive keys at every depth', async () => {
        const { output } = await runScript('get');

        expect(output).toContain('All Settings:');
        expect(output).toContain('[REDACTED]');
        expect(output).not.toContain('super-secret-token');
        expect(output).not.toContain('Bearer abc');
        // Non-sensitive values still print normally.
        expect(output).toContain('dark');
    });

    test('get token --reveal prints the raw value (explicit opt-out)', async () => {
        const { output } = await runScript('get', 'token', '--reveal');

        expect(output).toContain('super-secret-token');
        expect(output).not.toContain('[REDACTED]');
    });

    test('bare get --reveal dumps raw values', async () => {
        const { output } = await runScript('get', '--reveal');

        expect(output).toContain('super-secret-token');
        expect(output).toContain('Bearer abc');
    });

    test('non-sensitive keys are unaffected by redaction', async () => {
        const { output } = await runScript('get', 'theme');

        expect(output).toContain('dark');
        expect(output).not.toContain('[REDACTED]');
    });
});

// The wrapper delegates every mutating command to the shared CLI command
// module and turns its boolean result into an exit code — pin that plumbing
// at the script level (a mis-wired branch here would not be caught by the
// shared module's own unit tests).
describe('settings-cli delegation wiring', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('set <key> <value> delegates and exits cleanly on success', async () => {
        const { exitCalls } = await runScript('set', 'theme', 'dark');

        expect(sharedCommands.setSetting).toHaveBeenCalledWith('theme', 'dark');
        expect(exitCalls).not.toContain(1);
    });

    test('set failure exits 1', async () => {
        sharedCommands.setSetting.mockReturnValueOnce(false);

        const { exitCalls } = await runScript('set', 'theme', 'dark');

        expect(exitCalls).toContain(1);
    });

    test('set challengeSettings.globalDefaults.<key> routes to setGlobalDefault', async () => {
        await runScript('set', 'challengeSettings.globalDefaults.exposure', '80');

        expect(sharedCommands.setGlobalDefault).toHaveBeenCalledWith('exposure', '80');
        expect(sharedCommands.setSetting).not.toHaveBeenCalled();
    });

    test('reset delegates and honors the failure exit code', async () => {
        sharedCommands.resetSetting.mockReturnValueOnce(false);

        const { exitCalls } = await runScript('reset', 'theme');

        expect(sharedCommands.resetSetting).toHaveBeenCalledWith('theme');
        expect(exitCalls).toContain(1);
    });

    test('reset-global delegates to the shared resetGlobalDefault', async () => {
        const { exitCalls } = await runScript('reset-global', 'boostTime');

        expect(sharedCommands.resetGlobalDefault).toHaveBeenCalledWith('boostTime');
        expect(exitCalls).not.toContain(1);
    });

    test('reset-all without the yes confirmation cancels with exit 0 first', async () => {
        // process.exit is mocked (it cannot actually halt the script here),
        // so assert the ORDER: the cancel exit(0) is recorded before any
        // delegation could matter — in production the script stops there.
        const { exitCalls } = await runScript('reset-all');

        expect(exitCalls[0]).toBe(0);
    });

    test('reset-all yes delegates to the shared resetAllSettings', async () => {
        const { exitCalls } = await runScript('reset-all', 'yes');

        expect(sharedCommands.resetAllSettings).toHaveBeenCalledTimes(1);
        expect(exitCalls).not.toContain(1);
    });
});
