/**
 * Behaviour of the REAL logger module (tests/setup.ts mocks it globally, so
 * every load here goes through jest.requireActual inside isolateModules).
 * Each load gets a fresh fs stub + runtime stub so module-load decisions
 * (logs dir creation, CLI/GUI context, periodic cleanup, debug gating) can
 * be pinned per scenario.
 */

import type * as LoggerModule from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';

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
    isSourceCode: jest.fn(() => true),
    getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
    getAppUserDataPath: jest.fn(() => '/ud'),
    isDevelopment: jest.fn(() => false),
    isTest: jest.fn(() => true),
    isElectron: jest.fn(() => false),
    ...overrides,
});

/**
 * Load a fresh copy of the real logger under a controlled environment.
 * Returns the module plus the stubs and the captured process 'exit' handler.
 */
const loadLogger = ({
    electron = false,
    argv1,
    fs = makeFs(),
    runtime = makeRuntime({ isElectron: jest.fn(() => electron) }),
}: {
    electron?: boolean;
    argv1?: string;
    fs?: ReturnType<typeof makeFs>;
    runtime?: ReturnType<typeof makeRuntime>;
} = {}) => {
    const origArgv = process.argv;
    const onSpy = jest.spyOn(process, 'on').mockImplementation(() => process);
    process.argv = [origArgv[0], invalid<string>(argv1)];
    let logger!: typeof LoggerModule;
    try {
        jest.isolateModules(() => {
            jest.doMock('fs', () => fs);
            jest.doMock('../../src/ts/runtime', () => runtime);
            logger = jest.requireActual<typeof import('../../src/ts/logger')>('../../src/ts/logger');
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
        const { fs } = loadLogger({ argv1: '/app/src/ts/cli/cli.ts' });
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
        expect(fs.appendFileSync.mock.calls[3][1]).toMatch(/\[INFO\] \[CLI\] \[general\] ℹ️ Plain\n={80}\n$/);
    });

    test('serialises sanitized object data and bare-string data into the file line', () => {
        const { logger, fs } = loadLogger();
        logger.info('obj', { token: 'secret', n: 1 });
        logger.info('str', 'detail');

        expect(fs.appendFileSync.mock.calls[0][1]).toContain(JSON.stringify({ token: '[REDACTED]', n: 1 }, null, 2));
        expect(fs.appendFileSync.mock.calls[1][1]).toContain('] ℹ️ Str\ndetail\n');
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

    test('leaves blank, indented and banner lines without an icon', () => {
        const { logger } = loadLogger();
        for (const message of ['', '  Status:  Default', '\nSettings:\nMore', '=== Login ===', '--- Cycle 1 ---']) {
            logger.info(message);
            expect(lastEntry(logger).message).toBe(message.replaceAll('\n', ' '));
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
        const { logger } = loadLogger({ runtime: makeRuntime({ isSourceCode: jest.fn(() => false) }) });
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

    test('re-exports runtime identity helpers', () => {
        const { logger, runtime } = loadLogger();
        expect(logger.isSourceCode).toBe(runtime.isSourceCode);
        expect(logger.getAppName).toBe(runtime.getAppName);
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
