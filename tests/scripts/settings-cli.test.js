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
// trips "Cannot log after tests are done"). The fake child's behaviour is
// picked per test via mockChildBehavior:
//   'not-running' — closes with code 1 (default: GUI not running)
//   'running'     — closes with code 0 (GUI detected)
//   'error'       — emits 'error' (pgrep missing)
//   'hang'        — never closes (exercises the 2s timeout)
//   'throw'       — spawn itself throws synchronously
let mockChildBehavior = 'not-running';
let mockLastChild = null;
jest.mock('node:child_process', () => ({
    spawn: jest.fn(() => {
        if (mockChildBehavior === 'throw') throw new Error('spawn EACCES');
        const child = {
            kill: jest.fn(),
            on: (event, cb) => {
                if (event === 'close' && mockChildBehavior === 'not-running') cb(1);
                if (event === 'close' && mockChildBehavior === 'running') cb(0);
                if (event === 'error' && mockChildBehavior === 'error') cb(new Error('ENOENT'));
            },
        };
        mockLastChild = child;
        return child;
    }),
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
const settings = require('../../src/js/settings');
const { spawn } = require('node:child_process');

// Optional per-test hooks: `beforeRequire({ exitSpy })` can reshape the
// process.exit stub; `afterRequire()` runs between loading the script and
// flushing its async main() (used to advance fake timers).
let scriptHooks = {};

const runScript = async (...argv) => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const originalArgv = process.argv;
    process.argv = ['node', 'settings-cli.js', ...argv];
    try {
        scriptHooks.beforeRequire?.({ exitSpy });
        jest.isolateModules(() => {
            require('../../scripts/settings-cli.js');
        });
        await scriptHooks.afterRequire?.();
        // main() is async; flush its promise chain before asserting.
        await new Promise((resolve) => setImmediate(resolve));
        return {
            output: logSpy.mock.calls.map((c) => c.join(' ')).join('\n'),
            errors: errorSpy.mock.calls.map((c) => c.join(' ')).join('\n'),
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

describe('settings-cli get formatting and lookup', () => {
    test('dump-all formats every value shape', async () => {
        settings.loadSettings.mockReturnValueOnce({
            nothing: null,
            missing: undefined,
            empty: {},
            nested: { deep: { n: 1 } },
            none: [],
            list: [1, 'a'],
            flag: true,
            str: 'x',
        });

        const { output } = await runScript('get', '--reveal');

        expect(output).toContain('nothing: null');
        expect(output).toContain('missing: undefined');
        expect(output).toContain('empty: {}');
        expect(output).toContain('nested: {\n    deep: {\n      n: 1\n    }\n  }');
        expect(output).toContain('none: []');
        expect(output).toContain('list: [1, "a"]');
        expect(output).toContain('flag: true');
        expect(output).toContain('str: "x"');
    });

    test('get of a nested path prints the leaf value', async () => {
        const { output } = await runScript('get', 'apiHeaders.authorization');

        expect(output).toBe('apiHeaders.authorization: "[REDACTED]"');
    });

    test('an unknown key exits 1 with a not-found error', async () => {
        const { errors, exitCalls } = await runScript('get', 'nope');

        expect(errors).toContain("Setting 'nope' not found");
        expect(exitCalls[0]).toBe(1);
    });

    test('a path through a null value is reported as not found', async () => {
        settings.loadSettings.mockReturnValueOnce({ nothing: null });

        const { errors, exitCalls } = await runScript('get', 'nothing.child');

        expect(errors).toContain("Setting 'nothing.child' not found");
        expect(exitCalls[0]).toBe(1);
    });

    test('a thrown error is reported and exits 1', async () => {
        settings.loadSettings.mockImplementationOnce(() => {
            throw new Error('corrupt settings');
        });

        const { errors, exitCalls } = await runScript('get');

        expect(errors).toContain('❌ Error: corrupt settings');
        expect(exitCalls).toEqual([1, 0]);
    });

    test('an error escaping main() is reported as unhandled and exits 1', async () => {
        settings.loadSettings.mockImplementationOnce(() => {
            throw new Error('corrupt settings');
        });
        // The catch block's own process.exit throws once, so main() rejects.
        scriptHooks = {
            beforeRequire: ({ exitSpy }) =>
                exitSpy.mockImplementationOnce(() => {
                    throw new Error('exit threw');
                }),
        };
        try {
            const { errors, exitCalls } = await runScript('get');

            expect(errors).toContain('❌ Unhandled error: exit threw');
            expect(exitCalls).toEqual([1, 1]);
        } finally {
            scriptHooks = {};
        }
    });
});

describe('settings-cli command branches', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockChildBehavior = 'not-running';
    });

    test.each([
        [['set'], 'Usage: pnpm settings:set <key> <value>'],
        [['set', 'theme'], 'Usage: pnpm settings:set <key> <value>'],
        [['reset'], 'Usage: pnpm settings:reset <key>'],
        [['reset-global'], 'Usage: pnpm settings:reset-global <settingKey>'],
        [['set-global'], 'Usage: pnpm settings:set-global <settingKey> <value>'],
        [['set-global', 'exposure'], 'Usage: pnpm settings:set-global <settingKey> <value>'],
    ])('%j without required args prints usage and exits 1', async (argv, usage) => {
        const { errors, exitCalls } = await runScript(...argv);

        expect(errors).toContain(usage);
        expect(exitCalls[0]).toBe(1);
    });

    test('set rejects arbitrary nested keys', async () => {
        const { errors, exitCalls } = await runScript('set', 'foo.bar', '1');

        expect(errors).toContain("❌ Unsupported nested key 'foo.bar'");
        expect(sharedCommands.setSetting).not.toHaveBeenCalled();
        expect(exitCalls[0]).toBe(1);
    });

    test('set challengeSettings.globalDefaults.<key> failure exits 1', async () => {
        sharedCommands.setGlobalDefault.mockReturnValueOnce(false);

        const { exitCalls } = await runScript('set', 'challengeSettings.globalDefaults.exposure', 'x');

        expect(exitCalls[0]).toBe(1);
    });

    test('set of a non-UI key skips the GUI probe', async () => {
        const { exitCalls } = await runScript('set', 'stayLoggedIn', 'true');

        expect(sharedCommands.setSetting).toHaveBeenCalledWith('stayLoggedIn', 'true');
        expect(spawn).not.toHaveBeenCalled();
        expect(exitCalls).toEqual([0]);
    });

    test('set of a UI key announces a running GUI', async () => {
        mockChildBehavior = 'running';

        const { output } = await runScript('set', 'theme', 'dark');

        expect(spawn).toHaveBeenCalledWith('pgrep', ['-f', 'electron.*gurushots-auto-vote'], { stdio: 'pipe' });
        expect(output).toContain('🔄 GUI detected - changes will be applied automatically');
    });

    test('a pgrep spawn error is treated as "GUI not running"', async () => {
        mockChildBehavior = 'error';

        const { output, exitCalls } = await runScript('set-global', 'exposure', '80');

        expect(sharedCommands.setGlobalDefault).toHaveBeenCalledWith('exposure', '80');
        expect(output).not.toContain('GUI detected');
        expect(exitCalls).toEqual([0]);
    });

    test('a synchronous spawn failure is swallowed', async () => {
        mockChildBehavior = 'throw';

        const { output, exitCalls } = await runScript('reset-global', 'boostTime');

        expect(output).not.toContain('GUI detected');
        expect(exitCalls).toEqual([0]);
    });

    test('a hung pgrep is killed after the 2s timeout', async () => {
        mockChildBehavior = 'hang';
        jest.useFakeTimers({ doNotFake: ['setImmediate'] });
        scriptHooks = {
            afterRequire: async () => {
                await Promise.resolve();
                jest.advanceTimersByTime(2000);
            },
        };
        try {
            const { output, exitCalls } = await runScript('reset', 'theme');

            expect(mockLastChild.kill).toHaveBeenCalled();
            expect(output).not.toContain('GUI detected');
            expect(exitCalls).toEqual([0]);
        } finally {
            scriptHooks = {};
            jest.useRealTimers();
        }
    });

    test('reset of a non-UI key skips the GUI probe', async () => {
        const { exitCalls } = await runScript('reset', 'stayLoggedIn');

        expect(sharedCommands.resetSetting).toHaveBeenCalledWith('stayLoggedIn');
        expect(spawn).not.toHaveBeenCalled();
        expect(exitCalls).toEqual([0]);
    });

    test('reset-global failure exits 1', async () => {
        sharedCommands.resetGlobalDefault.mockReturnValueOnce(false);

        const { exitCalls } = await runScript('reset-global', 'boostTime');

        expect(exitCalls[0]).toBe(1);
    });

    test('set-global failure exits 1', async () => {
        sharedCommands.setGlobalDefault.mockReturnValueOnce(false);

        const { exitCalls } = await runScript('set-global', 'exposure', 'x');

        expect(exitCalls[0]).toBe(1);
    });

    test('reset-all yes failure exits 1', async () => {
        sharedCommands.resetAllSettings.mockReturnValueOnce(false);

        const { exitCalls } = await runScript('reset-all', 'yes');

        expect(exitCalls[0]).toBe(1);
    });

    test('schema and global-defaults delegate to the shared module', async () => {
        await runScript('schema');
        await runScript('global-defaults');

        expect(sharedCommands.dumpSchema).toHaveBeenCalledTimes(1);
        expect(sharedCommands.listGlobalDefaults).toHaveBeenCalledTimes(1);
    });

    test.each([[['help']], [['bogus']], [[]]])('%j prints the help text', async (argv) => {
        const { output, exitCalls } = await runScript(...argv);

        expect(output).toContain('Settings CLI Help');
        expect(output).toContain('pnpm settings:reset-all yes');
        expect(exitCalls).toEqual([0]);
    });
});
