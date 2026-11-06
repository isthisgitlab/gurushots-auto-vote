/**
 * Behaviour of the REAL logger module (tests/setup.ts mocks it globally, so
 * every load here goes through jest.requireActual inside isolateModules).
 * Each load gets a fresh fs stub + runtime stub so module-load decisions
 * (logs dir creation, CLI/GUI context, periodic cleanup, debug gating) can
 * be pinned per scenario.
 */

import vm from 'node:vm';
import type * as LoggerModule from '../../src/ts/core/logger';
import { SHIM_BANNER } from '../../scripts/lib/browser-shims';
import { installTestPlatform } from '../helpers/platform';
import { invalid } from '../helpers/invalid';
import { parseJson } from '../helpers/parseJson';

const LOGS_DIR = '/ud/logs';

const g = globalThis as typeof globalThis & { sendLogToGUI?: unknown };

const makeFs = (overrides = {}) => ({
    existsSync: jest.fn(() => true),
    mkdirSync: jest.fn(),
    readdirSync: jest.fn(() => []),
    statSync: jest.fn(() => ({ size: 0, mtime: new Date() })),
    unlinkSync: jest.fn<void, [string]>(),
    appendFileSync: jest.fn<void, [string, string, { mode: number }]>(),
    chmodSync: jest.fn<void, [string, number]>(),
    ...overrides,
});

const makeRuntime = (overrides = {}) => ({
    isDevelopment: jest.fn(() => false),
    isTest: jest.fn(() => true),
    isGithubActions: jest.fn(() => false),
    isElectron: jest.fn(() => false),
    ...overrides,
});

/**
 * Load a fresh copy of the real logger under a controlled environment.
 * Returns the module plus the stubs and the captured process 'exit' handler.
 * The user-data directory and the source-detection answer are the platform's
 * (the logs dir sits under it; the debug/api gating reads isSourceCode), so
 * the install pins both per scenario.
 */
const loadLogger = ({
    electron = false,
    argv1,
    sourceCode = true,
    fs = makeFs(),
    runtime = makeRuntime({ isElectron: jest.fn(() => electron) }),
}: {
    electron?: boolean;
    argv1?: string;
    sourceCode?: boolean;
    fs?: ReturnType<typeof makeFs>;
    runtime?: ReturnType<typeof makeRuntime>;
} = {}) => {
    const origArgv = process.argv;
    const onSpy = jest.spyOn(process, 'on').mockImplementation(() => process);
    process.argv = [origArgv[0], invalid<string>(argv1)];
    // The context line and the cleanup arming are the platform's to answer at
    // load; the node family computes them from the real runtime, so the
    // Electron scenario installs them overridden, the same rule it applies.
    const cliArg = Boolean(argv1 && /cli\.[jt]s/.test(argv1));
    let logger!: typeof LoggerModule;
    try {
        jest.isolateModules(() => {
            jest.doMock('fs', () => fs);
            jest.doMock('../../src/ts/core/runtime', () => runtime);
            const family = jest.requireActual<typeof import('../../src/ts/platforms/node/paths')>(
                '../../src/ts/platforms/node/paths',
            );
            const paths = family.createNodePaths();
            paths.userData = () => '/ud';
            paths.isSourceCode = () => sourceCode;
            installTestPlatform({
                paths,
                capabilities: {
                    refreshMissionNeeds: false,
                    snapAllowed: true,
                    backgroundServiceOwnsScenarios: () => false,
                    recoveryWording: 'file',
                    logContext: () => (electron && !cliArg ? 'GUI' : 'CLI'),
                    logCleanup: electron || cliArg,
                },
            });
            logger = jest.requireActual<typeof import('../../src/ts/core/logger')>('../../src/ts/core/logger');
        });
    } finally {
        process.argv = origArgv;
    }
    const exitCall = onSpy.mock.calls.find(([event]) => event === 'exit');
    onSpy.mockRestore();
    return { logger, fs, runtime, onExit: exitCall && exitCall[1] };
};

let logSpy: jest.SpiedFunction<typeof console.log>;
let errorSpy: jest.SpiedFunction<typeof console.error>;
let debugSpy: jest.SpiedFunction<typeof console.debug>;

beforeEach(() => {
    // Electron/cli.js loads schedule a real hourly interval — keep it fake so
    // no handle outlives the test.
    jest.useFakeTimers();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
    delete g.sendLogToGUI;
    jest.clearAllTimers();
    jest.useRealTimers();
});

const lastEntry = (logger: typeof LoggerModule) => logger.getRecentLogs().at(-1)!;

describe('module load: logs directory', () => {
    test('creates the logs dir under the resolved user-data path when missing', () => {
        jest.setSystemTime(new Date('2026-01-02T12:00:00Z'));
        const fs = makeFs({ existsSync: jest.fn(() => false) });
        const { logger } = loadLogger({ fs });

        expect(fs.mkdirSync).toHaveBeenCalledWith(LOGS_DIR, { recursive: true, mode: 0o700 });
        expect({
            error: logger.getErrorLogFile(),
            app: logger.getLogFile(),
            api: logger.getApiLogFile(),
            settings: logger.getSettingsLogFile(),
        }).toEqual({
            error: `${LOGS_DIR}/errors-2026-01-02.log`,
            app: `${LOGS_DIR}/app-2026-01-02.log`,
            api: `${LOGS_DIR}/api-2026-01-02.log`,
            settings: `${LOGS_DIR}/settings-2026-01-02.log`,
        });
    });

    test('does not recreate an existing logs dir', () => {
        const { fs } = loadLogger();
        expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    test('restricts the logs dir to 0o700 and every existing file in it to 0o600 once at load', () => {
        const fs = makeFs({ readdirSync: jest.fn(() => ['app-2026-01-02.log', 'errors-2026-01-02.log']) });
        loadLogger({ fs });

        expect(fs.chmodSync.mock.calls).toEqual([
            [LOGS_DIR, 0o700],
            [`${LOGS_DIR}/app-2026-01-02.log`, 0o600],
            [`${LOGS_DIR}/errors-2026-01-02.log`, 0o600],
        ]);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    test('reports a refused chmod on the console only and keeps going', () => {
        const fs = makeFs({
            readdirSync: jest.fn(() => ['a.log', 'b.log']),
            chmodSync: jest.fn((target: string) => {
                if (target === LOGS_DIR || target.endsWith('a.log')) throw new Error('EPERM');
            }),
        });
        const { logger } = loadLogger({ fs });

        expect(errorSpy).toHaveBeenCalledWith(`[logger] could not restrict ${LOGS_DIR} to owner-only:`, 'EPERM');
        expect(errorSpy).toHaveBeenCalledWith(`[logger] could not restrict ${LOGS_DIR}/a.log to owner-only:`, 'EPERM');
        expect(fs.chmodSync).toHaveBeenCalledWith(`${LOGS_DIR}/b.log`, 0o600);
        expect(logger.getRecentLogs()).toEqual([]);
    });

    test('printLine keeps line breaks, which writeLog flattens to one line', () => {
        const { logger } = loadLogger();
        logger.printLine('first\nsecond\n  third');
        expect(logSpy).toHaveBeenCalledWith('first\nsecond\n  third');
        // The protection of the log entry itself is unchanged.
        logger.info('first\nsecond');
        expect(lastEntry(logger).message).toBe('ℹ️ First second');
    });

    test('printLine strips terminal control but keeps line breaks and tabs', () => {
        const { logger } = loadLogger();
        const ESC = String.fromCharCode(27);
        logger.printLine(`a${ESC}[31mred${ESC}[0m\tb\u202Ec\r\nd`);
        expect(logSpy).toHaveBeenCalledWith('ared\tbc\nd');
    });

    test('printLine and printStderr cut a text past the length cap before redacting it', () => {
        const { logger } = loadLogger();
        logger.printLine(`password: hunter2 ${'x'.repeat(40000)}`);
        const printed = String(logSpy.mock.calls.at(-1)?.[0]);
        expect(printed).not.toContain('hunter2');
        expect(printed.length).toBeLessThan(16500);
        expect(printed.endsWith('…')).toBe(true);
        logger.printStderr(`token=abc ${'y'.repeat(40000)}`);
        const warned = String(errorSpy.mock.calls.at(-1)?.[0]);
        expect(warned.length).toBeLessThan(16500);
        expect(warned).not.toContain('abc');
    });

    test('a message past the length cap is cut before it is redacted and written', () => {
        const { logger } = loadLogger();
        logger.info(`password: hunter2 ${'x'.repeat(40000)}`);
        const message = lastEntry(logger).message;
        expect(message).not.toContain('hunter2');
        expect(message.length).toBeLessThan(16500);
        expect(message.endsWith('…')).toBe(true);
    });

    test('printDocument keeps the text as it is, with its layout, but strips control characters', () => {
        const { logger, fs } = loadLogger();
        const sink = jest.fn();
        g.sendLogToGUI = sink;
        const ESC = String.fromCharCode(27);
        // Credential-looking text is NOT redacted (that would corrupt a JSON document).
        logger.printDocument(`{\n\t"a": "token: x"\r\n}${ESC}[31m\u0007 \u202Eend`);
        expect(logSpy).toHaveBeenCalledWith('{\n\t"a": "token: x"\n} end');
        expect(fs.appendFileSync).not.toHaveBeenCalled();
        expect(sink).not.toHaveBeenCalled();
        expect(logger.getRecentLogs()).toEqual([]);
    });

    test('printStderr writes to the error stream only, redacted', () => {
        const { logger, fs } = loadLogger();
        logger.printStderr('note: password=hunter2');
        expect(errorSpy).toHaveBeenCalledWith('note: password=[REDACTED]');
        expect(logSpy).not.toHaveBeenCalled();
        expect(fs.appendFileSync).not.toHaveBeenCalled();
    });

    test('printLine redacts credentials folded into the text', () => {
        const { logger } = loadLogger();
        logger.printLine('auth token=abc123 password: hunter2');
        expect(logSpy).toHaveBeenCalledWith('auth token=[REDACTED] password: [REDACTED]');
    });

    test('reports an unreadable logs dir on the console only', () => {
        const fs = makeFs({
            readdirSync: jest.fn(() => {
                throw new Error('EACCES');
            }),
        });
        loadLogger({ fs });

        expect(errorSpy).toHaveBeenCalledWith(`[logger] could not list ${LOGS_DIR} to restrict its files:`, 'EACCES');
    });

    test('falls back to console-only logging when fs is unavailable', () => {
        const fs = makeFs({
            existsSync: jest.fn(() => {
                throw new Error('fs shim');
            }),
        });
        const { logger } = loadLogger({ fs });

        expect(debugSpy).toHaveBeenCalledWith('[logger] fs not available; skipping file-based logging:', 'fs shim');
        logger.info('hello');
        expect(fs.appendFileSync).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Hello'));
        // cleanup is a no-op without a logs dir
        fs.readdirSync.mockClear();
        logger.cleanup();
        expect(fs.readdirSync).not.toHaveBeenCalled();
    });

    test('treats the renderer bundle fs shim (no chmodSync) as no fs: no dir, no chmod, no error', () => {
        const shim = { ...makeFs(), chmodSync: undefined };
        const { logger } = loadLogger({ fs: invalid<ReturnType<typeof makeFs>>(shim) });

        expect(debugSpy).toHaveBeenCalledWith(
            '[logger] fs not available; skipping file-based logging:',
            'fs is the bundler shim',
        );
        expect(shim.mkdirSync).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
        logger.info('hello');
        expect(shim.appendFileSync).not.toHaveBeenCalled();
    });

    test('the real renderer bundle fs shim has no chmodSync, which files.ts relies on to detect it', () => {
        // What a bundle's `require('node:fs')` returns once the banner has run.
        const shim = vm.runInNewContext(`${SHIM_BANNER};require('node:fs')`) as Record<string, unknown>;

        expect(typeof shim.existsSync).toBe('function');
        expect(typeof shim.mkdirSync).toBe('function');
        expect(shim.chmodSync).toBeUndefined();
    });
});

describe('cleanupOldLogs', () => {
    const today = new Date().toISOString().split('T')[0];
    const MB = 1024 * 1024;

    test('deletes files past their retention age or size cap and keeps the rest', () => {
        const files = {
            'errors-2000-01-01.log': { size: 1, mtime: new Date() }, // too old (30d)
            [`app-${today}.log`]: { size: 60 * MB, mtime: new Date() }, // too big (50MB)
            [`api-${today}.log`]: { size: 1, mtime: new Date() }, // fresh + small: keep
            'foo-settings-2000-01-01.log': { size: 1, mtime: new Date() }, // date but no known prefix: keep
            'api-debug-old.log': { size: 2 * MB, mtime: new Date(Date.now() - 8 * 24 * 3600 * 1000) }, // stale debug
            'api-debug-new.log': { size: 1, mtime: new Date() }, // fresh debug: keep
            'notes.txt': { size: 1, mtime: new Date(0) }, // unrelated: keep
        };
        const fs = makeFs({
            readdirSync: jest.fn(() => Object.keys(files)),
            statSync: jest.fn((p: string) => files[p.split('/').pop()!]),
        });
        loadLogger({ fs });

        const deleted = fs.unlinkSync.mock.calls.map(([p]) => p.split('/').pop());
        expect(deleted.sort()).toEqual(['api-debug-old.log', `app-${today}.log`, 'errors-2000-01-01.log'].sort());
        expect(logSpy).toHaveBeenCalledWith('Cleaned up old log file: errors-2000-01-01.log (age, 0.00 MB)');
        expect(logSpy).toHaveBeenCalledWith(`Cleaned up old log file: app-${today}.log (size, 60.00 MB)`);
        expect(logSpy).toHaveBeenCalledWith('Cleaned up old log file: api-debug-old.log (age, 2.00 MB)');
    });

    test('returns early when the logs dir disappeared after load', () => {
        const { logger, fs } = loadLogger();
        fs.existsSync.mockReturnValue(false);
        fs.readdirSync.mockClear();

        logger.cleanup();

        expect(fs.readdirSync).not.toHaveBeenCalled();
    });

    test('swallows cleanup errors silently under test, reports them otherwise', () => {
        const boom = new Error('EACCES');
        const fs = makeFs({
            readdirSync: jest
                .fn<string[], []>(() => {
                    throw boom;
                })
                // the first listing is the load-time permission sweep
                .mockReturnValueOnce([]),
        });
        const runtime = makeRuntime();
        const { logger } = loadLogger({ fs, runtime });
        expect(errorSpy).not.toHaveBeenCalled();

        runtime.isTest.mockReturnValue(false);
        logger.cleanup();
        expect(errorSpy).toHaveBeenCalledWith('Error during log cleanup:', boom);
    });
});

describe('context detection', () => {
    test('pure Node (not Electron) is CLI mode', () => {
        const { logger } = loadLogger({ electron: false, argv1: '/x/jest' });
        expect(logger.getContext()).toBe('CLI');
        expect(logger.isCliMode()).toBe(true);
    });

    test('Electron main started via cli.js is CLI mode', () => {
        const { logger } = loadLogger({ electron: true, argv1: '/app/cli.js' });
        expect(logger.getContext()).toBe('CLI');
        expect(logger.isCliMode()).toBe(true);
    });

    test('Electron renderer/main without a cli.js entry is GUI mode', () => {
        const main = loadLogger({ electron: true, argv1: undefined }).logger;
        expect(main.getContext()).toBe('GUI');
        expect(main.isCliMode()).toBe(false);
        const { logger } = loadLogger({ electron: true, argv1: '/app/index.js' });
        expect(logger.getContext()).toBe('GUI');
        expect(logger.isCliMode()).toBe(false);
    });

    test('an explicit override wins until cleared', () => {
        const { logger } = loadLogger({ electron: true, argv1: '/app/index.js' });
        logger.setContext('IPC');
        expect(logger.getContext()).toBe('IPC');
        logger.info('tagged');
        expect(lastEntry(logger).context).toBe('IPC');
        logger.clearContext();
        expect(logger.getContext()).toBe('GUI');
    });

    test('isDevMode reflects runtime.isDevelopment at load', () => {
        const { logger } = loadLogger({ runtime: makeRuntime({ isDevelopment: jest.fn(() => true) }) });
        expect(logger.isDevMode()).toBe(true);
    });
});

describe('periodic cleanup interval', () => {
    test('Electron app schedules hourly cleanup and clears it on process exit', () => {
        const { fs, onExit } = loadLogger({ electron: true, argv1: '/app/index.js' });
        fs.readdirSync.mockClear();

        jest.advanceTimersByTime(60 * 60 * 1000);
        expect(fs.readdirSync).toHaveBeenCalledTimes(1);

        onExit!();
        jest.advanceTimersByTime(60 * 60 * 1000);
        expect(fs.readdirSync).toHaveBeenCalledTimes(1);
    });

    test('a plain CLI run via cli.js also schedules cleanup', () => {
        const { fs } = loadLogger({ argv1: '/app/cli.js' });
        fs.readdirSync.mockClear();
        jest.advanceTimersByTime(60 * 60 * 1000);
        expect(fs.readdirSync).toHaveBeenCalledTimes(1);
    });

    test('the tsx source run via cli.ts is a CLI run too', () => {
        const { fs } = loadLogger({ argv1: '/app/src/ts/shells/cli/cli.ts' });
        fs.readdirSync.mockClear();
        jest.advanceTimersByTime(60 * 60 * 1000);
        expect(fs.readdirSync).toHaveBeenCalledTimes(1);
    });

    test('other Node contexts (tests, scripts) schedule nothing; exit handler is a no-op', () => {
        const { onExit } = loadLogger({ argv1: '/x/jest' });
        expect(jest.getTimerCount()).toBe(0);
        expect(() => onExit!()).not.toThrow();
    });
});

describe('writeLog routing and fan-out', () => {
    test('routes errors, api, settings and everything else to their own files', () => {
        const { logger, fs } = loadLogger();
        logger.error('bad', null, 'api');
        logger.info('call', null, 'api');
        logger.info('saved', null, 'settings');
        logger.info('plain');

        const targets = fs.appendFileSync.mock.calls.map(([file]) => file);
        expect(targets).toEqual([
            logger.getErrorLogFile(),
            logger.getApiLogFile(),
            logger.getSettingsLogFile(),
            logger.getLogFile(),
        ]);
        expect(fs.appendFileSync.mock.calls.map(([, , options]) => options)).toEqual(Array(4).fill({ mode: 0o600 }));
        expect(fs.appendFileSync.mock.calls[3][1]).toMatch(/\] ℹ️ \[INFO\] \[CLI\] \[general\] Plain\n={80}\n$/);
    });

    test('serialises sanitized object data and bare-string data into the file line', () => {
        const { logger, fs } = loadLogger();
        logger.info('obj', { token: 'secret', n: 1 });
        logger.info('str', 'detail');

        expect(fs.appendFileSync.mock.calls[0][1]).toContain(JSON.stringify({ token: '[REDACTED]', n: 1 }, null, 2));
        expect(fs.appendFileSync.mock.calls[1][1]).toContain('] ℹ️ [INFO] [CLI] [general] Str\ndetail\n');
    });

    test('printLine writes the console only: no file, no ring buffer, no GUI feed', () => {
        const { logger, fs } = loadLogger();
        const sink = jest.fn();
        g.sendLogToGUI = sink;
        logger.printLine('  \u2022 p1');
        expect(logSpy).toHaveBeenCalledWith('  \u2022 p1');
        expect(fs.appendFileSync).not.toHaveBeenCalled();
        expect(sink).not.toHaveBeenCalled();
        expect(logger.getRecentLogs()).toEqual([]);
    });

    test('a failing disk write never throws out of the logger', () => {
        const fs = makeFs({
            appendFileSync: jest.fn(() => {
                throw new Error('ENOSPC');
            }),
        });
        const { logger } = loadLogger({ fs });

        expect(() => logger.info('still fine')).not.toThrow();
        expect(lastEntry(logger).message).toBe('ℹ️ Still fine');
    });

    test('colors the console line per level (unknown levels render white)', () => {
        const { logger } = loadLogger();
        logger.warning('careful');
        expect(logSpy).toHaveBeenLastCalledWith(expect.stringContaining('\x1b[33m[WARN]\x1b[0m'));
        logger.startOperation('op-x', 'custom', invalid('TRACE'));
        expect(logSpy).toHaveBeenLastCalledWith(expect.stringContaining('\x1b[37m[TRACE]\x1b[0m'));
    });

    test('puts the icon right after the timestamp on the console line', () => {
        const { logger } = loadLogger();
        logger.warning('careful', null, 'voting');
        const line = String(logSpy.mock.lastCall?.[0]);
        expect(line).toContain('\x1b[0m ⚠️ \x1b[33m[WARN]\x1b[0m');
        expect(line.endsWith('[voting]\x1b[0m Careful')).toBe(true);
    });

    test('keeps an indented row indented in the text column, after its own icon', () => {
        const { logger } = loadLogger();
        logger.info('  • app.x: 1 → 2', null, 'settings');
        const line = String(logSpy.mock.lastCall?.[0]);
        expect(line).toContain('\x1b[0m ℹ️ \x1b[34m[INFO]\x1b[0m');
        expect(line.endsWith('[settings]\x1b[0m   • app.x: 1 → 2')).toBe(true);
    });

    test('fans entries out to the GUI sink with seq + plain message', () => {
        const { logger } = loadLogger();
        const sink = jest.fn();
        g.sendLogToGUI = sink;

        logger.info('to gui', null, 'voting');

        expect(sink).toHaveBeenCalledWith(
            expect.objectContaining({
                seq: lastEntry(logger).seq,
                level: 'INFO',
                context: 'CLI',
                category: 'voting',
                message: 'ℹ️ To gui',
            }),
        );
    });

    test('leads every message with one icon: its own, else the level default', () => {
        const { logger } = loadLogger();
        const messageOf = (log: () => void) => {
            log();
            return lastEntry(logger).message;
        };

        expect(messageOf(() => logger.error('boom'))).toBe('❌ Boom');
        expect(messageOf(() => logger.info('🔄 Starting'))).toBe('🔄 Starting');
        expect(messageOf(() => logger.info('⚠ bare pictograph'))).toBe('⚠ Bare pictograph');
        expect(messageOf(() => logger.success('🎁 Claimed'))).toBe('🎁 Claimed');
        expect(messageOf(() => logger.warning('🔒 locked'))).toBe('🔒 Locked');
        expect(messageOf(() => logger.info('[Challenge 1: x] voted'))).toBe('ℹ️ [Challenge 1: x] Voted');
    });

    test('gives blank, indented and banner lines the level icon, keeping their text as written', () => {
        const { logger } = loadLogger();
        for (const [message, expected] of [
            ['', 'ℹ️ '],
            ['  Status:  Default', 'ℹ️   Status:  Default'],
            ['  list-photos --challenge=<id>', 'ℹ️   list-photos --challenge=<id>'],
            ['\nSettings:\nMore', 'ℹ️  Settings: More'],
            ['=== Login ===', 'ℹ️ === Login ==='],
            ['--- Cycle 1 ---', 'ℹ️ --- Cycle 1 ---'],
        ]) {
            logger.info(message);
            expect(lastEntry(logger).message).toBe(expected);
        }
    });

    test('keeps non-string messages untouched', () => {
        const { logger } = loadLogger();
        logger.info(invalid(42));
        expect(lastEntry(logger).message).toBe(42);
    });

    test('ring buffer holds the most recent 1000 entries', () => {
        const { logger } = loadLogger();
        for (let i = 0; i < 1001; i++) logger.info(`m${i}`);
        const logs = logger.getRecentLogs();
        expect(logs).toHaveLength(1000);
        expect(logs[0].message).toBe('ℹ️ M1');
        expect(logs.at(-1)!.message).toBe('ℹ️ M1000');
    });

    test('an unexpected failure while writing is reported, not thrown', () => {
        const { logger } = loadLogger();
        const boom = new Error('console broken');
        logSpy.mockImplementationOnce(() => {
            throw boom;
        });

        expect(() => logger.info('x')).not.toThrow();
        expect(errorSpy).toHaveBeenCalledWith('Error writing log entry:', boom);
    });
});

describe('top-level sugar methods', () => {
    test('success/warning/progress format their messages', () => {
        const { logger } = loadLogger();
        logger.success('done');
        expect(lastEntry(logger).message).toBe('✅ Done');
        logger.success('timed', { a: 1 }, 12, 'voting');
        expect(lastEntry(logger)).toMatchObject({ message: '✅ Timed (12ms)', category: 'voting', data: { a: 1 } });
        logger.warning('hmm');
        expect(lastEntry(logger)).toMatchObject({ level: 'WARN', message: '⚠️ Hmm' });
        logger.progress('just text');
        expect(lastEntry(logger).message).toBe('ℹ️ Just text');
        logger.progress('half', 5);
        expect(lastEntry(logger).message).toBe('ℹ️ Half');
        logger.progress('half', 5, 10);
        expect(lastEntry(logger).message).toBe(`ℹ️ Half [${'█'.repeat(10)}${'░'.repeat(10)}] 50% (5/10)`);
    });

    test('debug/api/apiRequest/apiResponse emit in source builds', () => {
        const { logger } = loadLogger();
        logger.debug('dbg');
        expect(lastEntry(logger)).toMatchObject({ level: 'DEBUG', message: '🔍 Dbg' });
        logger.api('api msg');
        expect(lastEntry(logger)).toMatchObject({ level: 'INFO', category: 'api' });
        logger.api('api custom', null, 'boost');
        expect(lastEntry(logger).category).toBe('boost');
        logger.apiRequest('GET', '/a');
        expect(lastEntry(logger).message).toBe('🌐 REQUEST: GET /a');
        logger.apiRequest('GET', '/a', 5);
        expect(lastEntry(logger).message).toBe('🌐 REQUEST: GET /a (5ms)');
        logger.apiResponse('POST', '/b', 200);
        expect(lastEntry(logger).message).toBe('✅ RESPONSE: POST /b → 200');
        logger.apiResponse('POST', '/b', 500, 7);
        expect(lastEntry(logger).message).toBe('❌ RESPONSE: POST /b → 500 (7ms)');
        logger.apiResponse('POST', '/b', 199);
        expect(lastEntry(logger).message).toBe('❌ RESPONSE: POST /b → 199');
    });

    test('packaged builds suppress debug and api channels', () => {
        const { logger } = loadLogger({ sourceCode: false });
        logger.debug('d');
        logger.api('a');
        logger.apiRequest('GET', '/a');
        logger.apiResponse('GET', '/a', 200);
        const scoped = logger.withCategory('x');
        scoped.debug('d');
        scoped.api('a');
        scoped.apiRequest('GET', '/a');
        scoped.apiResponse('GET', '/a', 200);
        expect(logger.getRecentLogs()).toEqual([]);
    });

    test('re-exports the identity helpers the platform answers', () => {
        const { logger } = loadLogger();
        expect(logger.isSourceCode()).toBe(true);
        expect(logger.getAppName()).toBe('gurushots-auto-vote-dev');
        const packaged = loadLogger({ sourceCode: false });
        expect(packaged.logger.isSourceCode()).toBe(false);
        expect(packaged.logger.getAppName()).toBe('gurushots-auto-vote');
        expect(logger.CATEGORIES.GENERAL).toBe('general');
    });

    test('sanitizeLogString bounds and single-lines untrusted strings', () => {
        const { logger } = loadLogger();
        expect(logger.sanitizeLogString('a\r\nb\tc')).toBe('a  b c');
        expect(logger.sanitizeLogString(null)).toBe('');
        expect(logger.sanitizeLogString('abcdef', 3)).toBe('abc');
        expect(logger.sanitizeLogString('x'.repeat(300))).toHaveLength(200);
    });
});

describe('withCategory', () => {
    test('every method writes under the bound category', () => {
        const { logger } = loadLogger();
        const log = logger.withCategory('voting');
        const expectLast = (fields: Partial<LoggerModule.LogEntry>) =>
            expect(lastEntry(logger)).toMatchObject({ category: 'voting', ...fields });

        log.info('i', { a: 1 });
        expectLast({ level: 'INFO', message: 'ℹ️ I', data: { a: 1 } });
        log.error('e');
        expectLast({ level: 'ERROR', message: '❌ E' });
        log.debug('d');
        expectLast({ level: 'DEBUG', message: '🔍 D' });
        log.api('a');
        expectLast({ level: 'INFO', message: 'ℹ️ A' });
        log.apiRequest('GET', '/u');
        expectLast({ message: '🌐 REQUEST: GET /u' });
        log.apiRequest('GET', '/u', 3);
        expectLast({ message: '🌐 REQUEST: GET /u (3ms)' });
        log.apiResponse('GET', '/u', 204);
        expectLast({ message: '✅ RESPONSE: GET /u → 204' });
        log.apiResponse('GET', '/u', 404, 9);
        expectLast({ message: '❌ RESPONSE: GET /u → 404 (9ms)' });
        log.success('ok');
        expectLast({ message: '✅ Ok' });
        log.success('ok', null, null);
        expectLast({ message: '✅ Ok' });
        log.success('ok', null, 4);
        expectLast({ message: '✅ Ok (4ms)' });
        log.warning('w');
        expectLast({ level: 'WARN', message: '⚠️ W' });
        log.progress('p');
        expectLast({ message: 'ℹ️ P' });
        log.progress('p', 1, 4);
        expectLast({ message: invalid(expect.stringContaining('25% (1/4)')) });
    });

    test('the T-methods render the catalog English and attach the template', () => {
        const { logger } = loadLogger();
        const log = logger.withCategory('voting');
        const expectLast = (fields: Partial<LoggerModule.LogEntry>) =>
            expect(lastEntry(logger)).toMatchObject({ category: 'voting', ...fields });

        // The rendered line is byte-identical to the plain call the emitter replaced.
        log.info('[Challenge 42: Sunset] Submitting votes for 3 images', null);
        const plain = lastEntry(logger).message;
        log.infoT('mc0e03d96165c', ['[Challenge 42: Sunset]', 3], null);
        expect(lastEntry(logger).message).toBe(plain);
        expectLast({
            level: 'INFO',
            message: 'ℹ️ [Challenge 42: Sunset] Submitting votes for 3 images',
            template: { key: 'mc0e03d96165c', params: ['[Challenge 42: Sunset]', 3] },
        });

        log.warningT('m8dc9275e52f1', ['[Challenge 42: Sunset]']);
        expectLast({ level: 'WARN', message: '⚠️ [Challenge 42: Sunset] No vote images available — skipping' });
        log.errorT('m01a2b02c3145', [], { challengeId: '42' });
        expectLast({ level: 'ERROR', message: '❌ Selected boost entry has no id', data: { challengeId: '42' } });
    });

    test('a T-entry carries its template to the GUI fan-out; a plain entry carries none', () => {
        const { logger } = loadLogger();
        const sink = jest.fn<void, [LoggerModule.GuiLogEntry]>();
        g.sendLogToGUI = sink;
        logger.withCategory('voting').infoT('mf275019cebb9', ['[Challenge 1: X]'], null);
        logger.info('plain');
        expect(sink.mock.calls[0][0]).toMatchObject({
            template: { key: 'mf275019cebb9', params: ['[Challenge 1: X]'] },
        });
        expect(sink.mock.lastCall?.[0]).not.toHaveProperty('template');
    });

    test('operations started on a scoped logger end at the start level and category', () => {
        const { logger } = loadLogger();
        const log = logger.withCategory('api');
        log.startOperation('op1', 'Fetching', 'DEBUG');
        expect(lastEntry(logger)).toMatchObject({ level: 'DEBUG', category: 'api', message: '🔄 Fetching...' });
        log.endOperation('op1');
        expect(lastEntry(logger)).toMatchObject({ level: 'DEBUG', category: 'api' });
        expect(lastEntry(logger).message).toMatch(/^✅ Fetching completed \(\d+ms\)$/);

        log.startOperation('op2', 'Default level');
        expect(lastEntry(logger).level).toBe('INFO');
    });
});

describe('operation tracking', () => {
    test('endOperation reports custom success, failure at ERROR, and ignores unknown ids', () => {
        const { logger } = loadLogger();
        const start = logger.startOperation('a', 'Voting');
        expect(typeof start).toBe('number');
        expect(lastEntry(logger)).toMatchObject({ level: 'INFO', category: 'general', message: '🔄 Voting...' });

        expect(logger.endOperation('a', 'All votes cast')).toEqual(expect.any(Number));
        expect(lastEntry(logger).message).toMatch(/^✅ All votes cast \(\d+ms\)$/);

        logger.startOperation('b', 'Boost', 'DEBUG', 'boost');
        logger.endOperation('b', null, 'timeout');
        expect(lastEntry(logger)).toMatchObject({
            level: 'ERROR',
            category: 'boost',
            message: '❌ Boost failed: timeout',
        });

        const before = logger.getRecentLogs().length;
        expect(logger.endOperation('missing')).toBeUndefined();
        expect(logger.getRecentLogs()).toHaveLength(before);
    });
});

describe('challengeTag', () => {
    test('formats id/title pairs and fills missing parts with unknown', () => {
        const { logger } = loadLogger();
        expect(logger.challengeTag({ id: 7, title: 'Sky' })).toBe('[Challenge 7: Sky]');
        expect(logger.challengeTag({})).toBe('[Challenge unknown: unknown]');
        expect(logger.challengeTag(3, 'T')).toBe('[Challenge 3: T]');
        expect(invalid<() => string>(logger.challengeTag)()).toBe('[Challenge unknown: unknown]');
    });
});

describe('debug log (dirty builds)', () => {
    const DAY = '2026-01-02';
    const DEBUG_FILE = `${LOGS_DIR}/debug-${DAY}.log`;
    const MB = 1024 * 1024;

    beforeEach(() => {
        jest.setSystemTime(new Date(`${DAY}T12:00:00Z`));
        Object.assign(g, { __GS_DIRTY__: true });
    });
    afterEach(() => {
        Reflect.deleteProperty(g, '__GS_DIRTY__');
    });

    const debugWrites = (fs: ReturnType<typeof makeFs>) =>
        fs.appendFileSync.mock.calls.filter(([file]) => file.includes('/debug-'));
    const debugText = (fs: ReturnType<typeof makeFs>) => debugWrites(fs).map(([, text]) => text);

    test('copies every entry as it was passed in, unredacted, to debug-<date>.log (owner-only)', () => {
        const { logger, fs } = loadLogger();
        logger.info('plain message', { token: 'secret-token', n: 1 }, 'voting');

        expect(debugWrites(fs)).toEqual([[DEBUG_FILE, expect.any(String), { mode: 0o600 }]]);
        expect(debugText(fs)[0]).toBe(
            `[${DAY}T12:00:00.000Z] [log:INFO:voting] [CLI] plain message\n{"token":"secret-token","n":1}\n`,
        );
        // The normal sinks keep redacting and sentence-casing.
        const normal = fs.appendFileSync.mock.calls.find(([file]) => file === logger.getLogFile())![1];
        expect(normal).toContain('Plain message');
        expect(normal).not.toContain('secret-token');
    });

    test('keeps a message past the length cap whole, and names the GUI context', () => {
        const { logger, fs } = loadLogger({ electron: true });
        const long = 'x'.repeat(20000);
        logger.warning(long);
        expect(debugText(fs)[0]).toBe(`[${DAY}T12:00:00.000Z] [log:WARN:general] [GUI] ${long}\n`);
    });

    test('a clean build writes no debug file', () => {
        Object.assign(g, { __GS_DIRTY__: false });
        const { logger, fs } = loadLogger();
        logger.info('x');
        logger.error('y');
        expect(debugWrites(fs)).toEqual([]);
        expect(fs.appendFileSync).toHaveBeenCalledTimes(2);
    });

    test('with no logs directory (the renderer fs shim) nothing is written', () => {
        const shim = { ...makeFs(), chmodSync: undefined };
        const { logger } = loadLogger({ fs: invalid<ReturnType<typeof makeFs>>(shim) });
        logger.info('x');
        expect(logger.debugLogEnabled()).toBe(false);
        expect(shim.appendFileSync).not.toHaveBeenCalled();
    });

    test.each([
        ['neither GitHub Actions nor the test runner made it', false, false, true],
        ['GitHub Actions made it', false, true, false],
        ['the test runner made it', true, false, false],
    ])('without a baked-in flag the environment decides: %s', (_name, isTest, isGithubActions, dirty) => {
        Reflect.deleteProperty(g, '__GS_DIRTY__');
        const runtime = makeRuntime({ isTest: jest.fn(() => isTest), isGithubActions: jest.fn(() => isGithubActions) });
        const { logger, fs } = loadLogger({ runtime });
        logger.info('x');
        expect(logger.debugLogEnabled()).toBe(dirty);
        expect(debugWrites(fs)).toHaveLength(dirty ? 1 : 0);
    });

    test('writes a record without data as one line, and a non-JSON value as its text', () => {
        const { logger, fs } = loadLogger();
        logger.writeDebug('custom', 'no data');
        logger.writeDebug('custom', 'null data', null);
        logger.writeDebug('custom', 'symbol data', Symbol('marker'));
        expect(debugText(fs).map((text) => text.replace(/^\[[^\]]+\] /, ''))).toEqual([
            '[custom] [CLI] no data\n',
            '[custom] [CLI] null data\n',
            '[custom] [CLI] symbol data\nSymbol(marker)\n',
        ]);
    });

    test('writes an Error, a BigInt and a cycle readably, and a shared (not cyclic) object twice', () => {
        const { logger, fs } = loadLogger();
        const cyclic: { name: string; self?: unknown } = { name: 'loop' };
        cyclic.self = cyclic;
        const shared = { a: 1 };
        const error = new Error('boom');
        logger.writeDebug('custom', 'shapes', { error, big: 10n, cyclic, first: shared, second: shared });

        const body = parseJson(debugText(fs)[0].split('\n')[1]);
        expect(body).toEqual({
            error: { name: 'Error', message: 'boom', stack: error.stack },
            big: '10',
            cyclic: { name: 'loop', self: '[Circular]' },
            first: { a: 1 },
            second: { a: 1 },
        });
    });

    test('a value that cannot be written is one console report per process; the normal log is unaffected', () => {
        const { logger, fs } = loadLogger();
        const unwritable = {
            toJSON: () => {
                throw new Error('toJSON failed');
            },
        };
        logger.writeDebug('custom', 'first', unwritable);
        logger.writeDebug('custom', 'second', unwritable);
        logger.info('after');

        expect(errorSpy.mock.calls.filter(([text]) => String(text).includes('debug log'))).toEqual([
            ['[logger] could not write the debug log:', 'toJSON failed'],
        ]);
        expect(lastEntry(logger).message).toBe('ℹ️ After');
        expect(fs.appendFileSync.mock.calls.some(([file]) => file === logger.getLogFile())).toBe(true);
    });

    test('a failing append is reported once on the console and never goes through the logger', () => {
        const fs = makeFs({
            appendFileSync: jest.fn((file: string) => {
                if (file.includes('/debug-')) throw new Error('ENOSPC');
            }),
        });
        const { logger } = loadLogger({ fs });
        logger.info('one');
        logger.info('two');

        expect(errorSpy.mock.calls.filter(([text]) => String(text).includes('debug log'))).toEqual([
            ['[logger] could not write the debug log:', 'ENOSPC'],
        ]);
        // Only the two entries themselves: the failure report added none.
        expect(logger.getRecentLogs().map((entry) => entry.message)).toEqual(['ℹ️ One', 'ℹ️ Two']);
    });

    test('a throwing GUI sink does not skip the copy, and a throwing debug write does not skip the sinks', () => {
        const { logger, fs } = loadLogger();
        g.sendLogToGUI = () => {
            throw new Error('sink broke');
        };
        logger.info('mirrored anyway');
        expect(debugText(fs)[0]).toContain('[log:INFO:general] [CLI] mirrored anyway');
        expect(errorSpy).toHaveBeenCalledWith('Error writing log entry:', expect.any(Error));

        const sink = jest.fn();
        g.sendLogToGUI = sink;
        fs.appendFileSync.mockImplementation((file) => {
            if (file.includes('/debug-')) throw new Error('ENOSPC');
        });
        logger.info('sinks still run');
        expect(sink).toHaveBeenCalledTimes(1);
    });

    test('strips terminal control from the message and string data, and escapes it inside JSON strings', () => {
        const { logger, fs } = loadLogger();
        logger.writeDebug('custom', '\u001b[31mred\u001b[0m\nforged\u202e', 'text\u0007\r\nmore');
        logger.writeDebug('custom', 'nested', {
            title: 'a\u202eb\u0085c\u2028d\u200be\u001b[2Jf',
            emoji: 'ok 👍\u200d',
        });

        const [first, second] = debugText(fs);
        expect(first.replace(/^\[[^\]]+\] /, '')).toBe('[custom] [CLI] red forged\ntext more\n');
        const body = second.split('\n')[1];
        // JSON itself escapes ESC; the characters it leaves raw (C1, bidi, zero-width, line separator) are escaped here.
        expect(body).toBe('{"title":"a\\u202eb\\u0085c\\u2028d\\u200be\\u001b[2Jf","emoji":"ok 👍\u200d"}');
    });

    test("rolls over to the next day's file without a restart", () => {
        const { logger, fs } = loadLogger();
        jest.setSystemTime(new Date(`${DAY}T23:59:59Z`));
        logger.info('late');
        jest.setSystemTime(new Date('2026-01-03T00:00:01Z'));
        logger.info('early');
        expect(debugWrites(fs).map(([file]) => file)).toEqual([
            `${LOGS_DIR}/debug-${DAY}.log`,
            `${LOGS_DIR}/debug-2026-01-03.log`,
        ]);
    });

    test('a packaged dirty build copies the gated debug and api calls, and only there', () => {
        const { logger, fs } = loadLogger({ sourceCode: false });
        const sink = jest.fn();
        g.sendLogToGUI = sink;
        logger.debug('d', { a: 1 });
        logger.api('a');
        logger.api('b', null, 'boost');
        const scoped = logger.withCategory('x');
        scoped.debug('sd');
        scoped.api('sa');
        logger.apiRequest('GET', '/a');
        logger.apiResponse('GET', '/a', 200);
        scoped.apiRequest('GET', '/a');
        scoped.apiResponse('GET', '/a', 200);

        expect(debugText(fs).map((text) => /\[(log:[^\]]+)\]/.exec(text)![1])).toEqual([
            'log:DEBUG:general',
            'log:INFO:api',
            'log:INFO:boost',
            'log:DEBUG:x',
            'log:INFO:x',
        ]);
        expect(debugText(fs)[0]).toContain('\n{"a":1}\n');
        expect(logger.getRecentLogs()).toEqual([]);
        expect(sink).not.toHaveBeenCalled();
        expect(fs.appendFileSync).toHaveBeenCalledTimes(5);
        expect(logSpy).not.toHaveBeenCalled();
    });

    test('a source build writes a gated call to the debug log once, through the entry itself', () => {
        const { logger, fs } = loadLogger({ sourceCode: true });
        logger.debug('d');
        logger.withCategory('x').api('a');
        expect(debugText(fs)).toHaveLength(2);
        expect(logger.getRecentLogs()).toHaveLength(2);
    });

    test('a clean packaged build drops the gated calls entirely', () => {
        Object.assign(g, { __GS_DIRTY__: false });
        const { logger, fs } = loadLogger({ sourceCode: false });
        logger.debug('d');
        logger.api('a');
        expect(fs.appendFileSync).not.toHaveBeenCalled();
    });

    test('the CLI uncaught-exception details land in debug.log with the stack, before the process exits', () => {
        const { logger, fs } = loadLogger({ sourceCode: false });
        const crash = new Error('kaboom');
        logger.withCategory('api').error('Uncaught Exception');
        logger.withCategory('api').debug('Uncaught Exception details:', crash);

        const [message, details] = debugText(fs);
        expect(message).toContain('[log:ERROR:api] [CLI] Uncaught Exception\n');
        expect(details).toContain('[log:DEBUG:api] [CLI] Uncaught Exception details:\n');
        expect(details).toContain(JSON.stringify(crash.stack));
    });

    describe('retention', () => {
        const today = new Date().toISOString().split('T')[0];
        const loadWith = (files: Record<string, { size: number; mtime: Date }>) => {
            const fs = makeFs({
                readdirSync: jest.fn(() => Object.keys(files)),
                statSync: jest.fn((p: string) => files[p.split('/').pop()!]),
            });
            loadLogger({ fs });
            return fs.unlinkSync.mock.calls.map(([p]) => p.split('/').pop()).sort();
        };

        test("keeps a debug file by age only: today's is never deleted for its size, one 3+ days old is", () => {
            const deleted = loadWith({
                [`debug-${today}.log`]: { size: 500 * MB, mtime: new Date() },
                'debug-2000-01-01.log': { size: 1, mtime: new Date() },
                [`app-${today}.log`]: { size: 60 * MB, mtime: new Date() },
            });
            expect(deleted).toEqual([`app-${today}.log`, 'debug-2000-01-01.log'].sort());
            expect(logSpy).toHaveBeenCalledWith('Cleaned up old log file: debug-2000-01-01.log (age, 0.00 MB)');
        });

        test('an api-debug file is judged by its modification time, not by a date in its name', () => {
            const deleted = loadWith({
                'api-debug-2000-01-01.log': { size: 1, mtime: new Date() },
                'api-debug-2026-01-01.log': { size: 1, mtime: new Date(Date.now() - 8 * 24 * 3600 * 1000) },
            });
            expect(deleted).toEqual(['api-debug-2026-01-01.log']);
        });
    });
});
