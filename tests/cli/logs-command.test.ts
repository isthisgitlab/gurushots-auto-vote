/**
 * Unit tests for the CLI `logs` command. It tails one of the on-disk log
 * files (paths owned by the logger) so CLI users get the after-the-fact log
 * access the Electron Logs page provides, and `--follow` keeps printing what
 * is appended. fs and the logger are mocked.
 */

jest.mock('fs');
jest.mock('../../src/ts/services/semantic/diagnostics', () => ({ diagnostics: { read: jest.fn() } }));

jest.mock('../../src/ts/logger', () => {
    const infoMock = jest.fn();
    const errorMock = jest.fn();
    const printMock = jest.fn();
    return {
        __infoMock: infoMock,
        __printMock: printMock,
        printLine: printMock,
        __errorMock: errorMock,
        withCategory: jest.fn(() => ({ info: infoMock, error: errorMock })),
        getLogFile: jest.fn(() => '/logs/app.log'),
        getErrorLogFile: jest.fn(() => '/logs/error.log'),
        getApiLogFile: jest.fn(() => '/logs/api.log'),
        getSettingsLogFile: jest.fn(() => '/logs/settings.log'),
        logsDir: '/logs',
    };
});

import { invalid } from '../helpers/invalid';
import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(
    invalid<typeof loggerModule & { __infoMock: jest.Mock<void, [string]>; __printMock: jest.Mock<void, [string]> }>(
        loggerModule,
    ),
);
import type * as diagnosticsModule from '../../src/ts/services/semantic/diagnostics';
import type * as logsModule from '../../src/ts/cli/commands/logs';
const { diagnostics } = jest.mocked(require('../../src/ts/services/semantic/diagnostics') as typeof diagnosticsModule);
const { followLogs, followStep, latestLogFile, showLogs } =
    require('../../src/ts/cli/commands/logs') as typeof logsModule;

describe('CLI logs command', () => {
    beforeEach(() => jest.clearAllMocks());

    test('prints the last N lines of the app log by default', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('line1\nline2\nline3\nline4');

        showLogs({ lines: 2 });

        expect(logger.getLogFile).toHaveBeenCalled();
        // The tail is printed whole, one line per log line, on the console only.
        expect(logger.__printMock.mock.calls).toEqual([['line3\nline4']]);
        expect(logger.__infoMock.mock.calls.map((c) => c[0]).join('\n')).not.toContain('line3');
    });

    test('terminal control sequences in the file never reach the terminal, line by line', () => {
        const ESC = String.fromCharCode(27);
        const BEL = String.fromCharCode(7);
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
            `ok line\nbad ${ESC}[31mred${ESC}[0m line\ntitle ${ESC}]0;pwned${BEL}set\nrtl \u202Eevil\nlast`,
        );
        showLogs({ lines: 10 });
        const [[printed]] = logger.__printMock.mock.calls;
        expect(printed).toBe('ok line\nbad red line\ntitle set\nrtl evil\nlast');
        // The line breaks between the log lines survive.
        expect(printed.split('\n')).toHaveLength(5);
    });

    test('reads the error log when category is error', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('err');

        showLogs({ category: 'error', lines: 10 });

        expect(logger.getErrorLogFile).toHaveBeenCalled();
        expect(fs.readFileSync).toHaveBeenCalledWith('/logs/error.log', 'utf8');
    });

    test('handles a missing log file without throwing or reading', () => {
        fs.existsSync.mockReturnValue(false);

        expect(() => showLogs({})).not.toThrow();
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    test('prints a ranked local lexicon report without reading a log file', () => {
        diagnostics.read.mockReturnValue(
            invalid({
                since: '2026-09-24',
                updatedAt: '2026-09-25',
                challenges: 2,
                noThemeVector: 1,
                noLabelVectors: 0,
                noOnThemeScore: 1,
                themeWords: { zebra: 1, apple: 2, blue: 1 },
                labelWords: { moss: 1 },
            }),
        );

        showLogs({ category: 'lexicon' });

        expect(fs.readFileSync).not.toHaveBeenCalled();
        const printed = logger.__infoMock.mock.calls.map(([line]) => line);
        expect(printed).toContain('Challenge observations: 2');
        expect(printed).toContain('No theme vector: 1');
        expect(printed).toContain('Missing challenge words: apple: 2, blue: 1, zebra: 1');
        expect(printed).toContain('Missing photo-label words: moss: 1');
    });

    test('reports empty counters and an unobserved timestamp', () => {
        diagnostics.read.mockReturnValue(
            invalid({
                since: '2026-09-24',
                updatedAt: null,
                challenges: 0,
                noThemeVector: 0,
                noLabelVectors: 0,
                noOnThemeScore: 0,
                themeWords: {},
                labelWords: {},
            }),
        );

        showLogs({ category: 'lexicon' });

        const printed = logger.__infoMock.mock.calls.map(([line]) => line);
        expect(printed[0]).toContain('last updated never');
        expect(printed).toContain('Missing challenge words: (none)');
        expect(printed).toContain('Missing photo-label words: (none)');
    });
});

const OLD_FILE = '/logs/app-2026-10-28.log';
const NEW_FILE = '/logs/app-2026-10-29.log';

/** Injected follower surroundings: a recording printer and a controllable stop. */
const followDeps = (over: Partial<logsModule.FollowDeps> = {}): logsModule.FollowDeps => ({
    dir: '/logs',
    intervalMs: 0,
    latest: jest
        .fn<logsModule.LatestLogFile | null, [string, string]>()
        .mockReturnValue({ path: OLD_FILE, mtimeMs: 1 }),
    print: jest.fn<void, [string]>(),
    sleep: jest.fn<Promise<void>, [number]>(async () => {
        process.emit('SIGINT');
    }),
    ...over,
});

const stat = (mtimeMs: number) => invalid<fsModule.Stats>({ mtimeMs });

// readdirSync's mocked type resolves to the Dirent overload; the follower
// reads names, so the string lists pass through as dirents.
const names = (list: string[]): ReturnType<typeof fs.readdirSync> => invalid(list);

describe('CLI logs follow — followStep', () => {
    beforeEach(() => jest.clearAllMocks());

    test('keeps tailing a file that still receives bytes after the date changes', () => {
        // A next-day file exists, but the old file was written most recently:
        // it is still the one to follow.
        const state: logsModule.FollowState = { filePath: OLD_FILE, offset: 4 };
        const latest = jest.fn<logsModule.LatestLogFile | null, [string, string]>().mockReturnValue({
            path: OLD_FILE,
            mtimeMs: 10,
        });
        fs.readFileSync.mockReturnValue('old\nnew line\n');
        const deps = followDeps({ latest });

        followStep(state, 'app', deps);

        expect(latest).toHaveBeenCalledWith('/logs', 'app');
        expect(jest.mocked(deps.print).mock.calls).toEqual([['new line\n']]);
        expect(state).toEqual({ filePath: OLD_FILE, offset: 'old\nnew line\n'.length });
        expect(jest.mocked(deps.print).mock.calls.join()).not.toContain('2026-10-29');
    });

    test('switches to a newer-modified file when one appears, reading it from the start', () => {
        const state: logsModule.FollowState = { filePath: OLD_FILE, offset: 4 };
        fs.statSync.mockReturnValue(stat(9)); // the followed file's mtime
        const latest = jest.fn<logsModule.LatestLogFile | null, [string, string]>().mockReturnValue({
            path: NEW_FILE,
            mtimeMs: 10,
        });
        fs.readFileSync.mockReturnValue('fresh day\n');
        const print = jest.fn<void, [string]>();

        followStep(state, 'app', followDeps({ latest, print }));

        expect(print.mock.calls).toEqual([['--- now following /logs/app-2026-10-29.log'], ['fresh day\n']]);
        expect(state).toEqual({ filePath: NEW_FILE, offset: 'fresh day\n'.length });
    });

    test('a newest file that merely ties the followed mtime does not switch', () => {
        const state: logsModule.FollowState = { filePath: OLD_FILE, offset: 4 };
        fs.statSync.mockReturnValue(stat(10));
        const latest = jest.fn<logsModule.LatestLogFile | null, [string, string]>().mockReturnValue({
            path: NEW_FILE,
            mtimeMs: 10,
        });
        fs.readFileSync.mockReturnValue('old\nmore\n');
        const print = jest.fn<void, [string]>();

        followStep(state, 'app', followDeps({ latest, print }));

        // No switch, and the old file's appended bytes still print.
        expect(print.mock.calls).toEqual([['more\n']]);
        expect(state.filePath).toBe(OLD_FILE);
    });

    test('a followed file deleted while a newer one exists switches to it from the start', () => {
        const state: logsModule.FollowState = { filePath: OLD_FILE, offset: 40 };
        fs.statSync.mockImplementation(() => {
            throw new Error('ENOENT'); // the followed file is gone
        });
        const latest = jest.fn<logsModule.LatestLogFile | null, [string, string]>().mockReturnValue({
            path: NEW_FILE,
            mtimeMs: 3,
        });
        fs.readFileSync.mockReturnValue('other file\n');
        const print = jest.fn<void, [string]>();

        followStep(state, 'app', followDeps({ latest, print }));

        expect(print.mock.calls).toEqual([['--- now following /logs/app-2026-10-29.log'], ['other file\n']]);
        expect(state).toEqual({ filePath: NEW_FILE, offset: 'other file\n'.length });
    });

    test('a shrunk file resets the offset and is re-read from the start', () => {
        const state: logsModule.FollowState = { filePath: OLD_FILE, offset: 10 };
        const latest = jest.fn<logsModule.LatestLogFile | null, [string, string]>().mockReturnValue({
            path: OLD_FILE,
            mtimeMs: 10,
        });
        fs.readFileSync.mockReturnValue('small\n');
        const print = jest.fn<void, [string]>();

        followStep(state, 'app', followDeps({ latest, print }));

        expect(print.mock.calls).toEqual([['small\n']]);
        expect(state.offset).toBe('small\n'.length);
    });

    test('a deleted file resets the offset; a recreated one is re-read from the start', () => {
        const state: logsModule.FollowState = { filePath: OLD_FILE, offset: 10 };
        const latest = jest.fn<logsModule.LatestLogFile | null, [string, string]>().mockReturnValue(null);
        fs.readFileSync.mockImplementation(() => {
            throw new Error('ENOENT');
        });
        const print = jest.fn<void, [string]>();
        const deps = followDeps({ latest, print });

        followStep(state, 'app', deps);

        expect(print.mock.calls).toEqual([]);
        expect(state.offset).toBe(0);

        fs.readFileSync.mockReturnValue('fresh\n');
        followStep(state, 'app', deps);

        expect(print.mock.calls).toEqual([['fresh\n']]);
        expect(state.offset).toBe('fresh\n'.length);
    });

    test('with no file adopted yet it prints nothing past the newest-file switch', () => {
        const state: logsModule.FollowState = { filePath: null, offset: 0 };
        const latest = jest.fn<logsModule.LatestLogFile | null, [string, string]>().mockReturnValue(null);
        const print = jest.fn<void, [string]>();

        followStep(state, 'app', followDeps({ latest, print }));

        expect(print.mock.calls).toEqual([]);
        expect(state).toEqual({ filePath: null, offset: 0 });
    });
});

describe('CLI logs follow — followLogs', () => {
    beforeEach(() => jest.clearAllMocks());

    test('prints the last --lines of the newest file first, then only what is appended', async () => {
        fs.readdirSync.mockReturnValue(names([OLD_FILE]));
        fs.statSync.mockReturnValue(stat(5));
        // The tail slices the file's lines the way showLogs does: 'l3' plus the
        // empty piece after the final newline.
        fs.readFileSync.mockReturnValue('l1\nl2\nl3\n');
        const latest = jest.fn<logsModule.LatestLogFile | null, [string, string]>().mockReturnValue({
            path: OLD_FILE,
            mtimeMs: 5,
        });
        const print = jest.fn<void, [string]>();

        const code = await followLogs({ category: 'app', lines: 2, deps: followDeps({ latest, print }) });

        expect(code).toBe(0);
        expect(print.mock.calls).toEqual([
            ['--- following /logs/app-2026-10-28.log (Ctrl+C to stop)'],
            ['l3\n'],
            ['Stopped following the log.'],
        ]);
    });

    test('with no log file yet it waits, then adopts one whole when it appears', async () => {
        const latest = jest
            .fn<logsModule.LatestLogFile | null, [string, string]>()
            .mockReturnValueOnce(null)
            .mockReturnValue({ path: NEW_FILE, mtimeMs: 1 });
        fs.readFileSync.mockReturnValue('whole file\n');
        let polls = 0;
        const sleep = jest.fn<Promise<void>, [number]>(async () => {
            polls += 1;
            if (polls >= 2) process.emit('SIGINT');
        });
        const print = jest.fn<void, [string]>();

        const code = await followLogs({ category: 'error', lines: 5, deps: followDeps({ latest, print, sleep }) });

        expect(code).toBe(0);
        // The errors prefix, not today's name, decides what is followed.
        expect(latest).toHaveBeenCalledWith('/logs', 'errors');
        expect(print.mock.calls).toEqual([
            ['No error log file to follow yet; waiting for one to appear.'],
            ['--- now following /logs/app-2026-10-29.log'],
            ['whole file\n'],
            ['Stopped following the log.'],
        ]);
    });

    test('a first file that vanishes before the tail leaves the poll to re-resolve', async () => {
        const latest = jest
            .fn<logsModule.LatestLogFile | null, [string, string]>()
            .mockReturnValueOnce({ path: OLD_FILE, mtimeMs: 1 })
            .mockReturnValue(null);
        fs.readFileSync.mockImplementation(() => {
            throw new Error('ENOENT');
        });
        const print = jest.fn<void, [string]>();

        const code = await followLogs({ category: 'app', lines: 5, deps: followDeps({ latest, print }) });

        expect(code).toBe(0);
        expect(print.mock.calls).toEqual([
            ['--- following /logs/app-2026-10-28.log (Ctrl+C to stop)'],
            ['Stopped following the log.'],
        ]);
    });

    test('SIGINT stops the follower with exit 0 and removes its listener', async () => {
        const before = process.listenerCount('SIGINT');
        fs.readdirSync.mockReturnValue(names([OLD_FILE]));
        fs.statSync.mockReturnValue(stat(1));
        fs.readFileSync.mockReturnValue('x\n');
        const print = jest.fn<void, [string]>();

        const code = await followLogs({ category: 'app', lines: 1, deps: followDeps({ print }) });

        expect(code).toBe(0);
        expect(print.mock.calls.at(-1)).toEqual(['Stopped following the log.']);
        expect(process.listenerCount('SIGINT')).toBe(before);
    });

    test('never writes into the file it reads', async () => {
        const latest = jest.fn<logsModule.LatestLogFile | null, [string, string]>().mockReturnValue({
            path: OLD_FILE,
            mtimeMs: 1,
        });
        fs.readFileSync.mockReturnValue('seed');
        let polls = 0;
        const sleep = jest.fn<Promise<void>, [number]>(async () => {
            polls += 1;
            if (polls >= 2) process.emit('SIGINT');
        });
        const print = jest.fn<void, [string]>();

        await followLogs({ category: 'app', lines: 1, deps: followDeps({ latest, print, sleep }) });

        // The read content is echoed unchanged, and nothing wrote anywhere.
        expect(fs.readFileSync).toHaveBeenCalledWith(OLD_FILE, 'utf8');
        expect(fs.appendFileSync).not.toHaveBeenCalled();
        expect(fs.writeFileSync).not.toHaveBeenCalled();
        expect(print.mock.calls).toEqual([
            ['--- following /logs/app-2026-10-28.log (Ctrl+C to stop)'],
            ['seed'],
            ['Stopped following the log.'],
        ]);
    });

    test('defaults to the app category and the last 100 lines', async () => {
        const content = Array.from({ length: 101 }, (_, i) => `l${i + 1}`).join('\n');
        const latest = jest.fn<logsModule.LatestLogFile | null, [string, string]>().mockReturnValue({
            path: OLD_FILE,
            mtimeMs: 1,
        });
        fs.readFileSync.mockReturnValue(content);
        const print = jest.fn<void, [string]>();

        const code = await followLogs({ deps: followDeps({ latest, print }) });

        expect(code).toBe(0);
        expect(latest).toHaveBeenCalledWith('/logs', 'app');
        const tail = print.mock.calls[1][0];
        expect(tail.split('\n')[0]).toBe('l2');
        expect(tail.split('\n').at(-1)).toBe('l101');
    });

    test('follows with the default poll interval until SIGINT, printing to the console only', async () => {
        jest.useFakeTimers();
        try {
            const ESC = String.fromCharCode(27);
            // readdirSync lists names; latestLogFile joins them onto the dir.
            fs.readdirSync.mockReturnValue(names(['app-2026-10-28.log']));
            fs.statSync.mockReturnValue(stat(1));
            // The first read seeds the offset; the poll then prints what was
            // appended — stripped of terminal control, on the console only.
            // The bare call takes the defaults: the app category, 100 lines.
            fs.readFileSync.mockReturnValueOnce('a\n').mockReturnValue(`a\nbad ${ESC}[31mred${ESC}[0m line\n`);
            const pending = followLogs();

            // One poll at the default 1s interval.
            await jest.advanceTimersByTimeAsync(1000);
            expect(logger.__printMock.mock.calls).toEqual([
                ['--- following /logs/app-2026-10-28.log (Ctrl+C to stop)'],
                ['a\n'],
                ['bad red line\n'],
            ]);

            process.emit('SIGINT');
            await jest.advanceTimersByTimeAsync(1000);
            await expect(pending).resolves.toBe(0);
            expect(logger.__printMock.mock.calls.at(-1)).toEqual(['Stopped following the log.']);
            // Following a log must never write into the file it reads: an
            // info() would append to the followed app log.
            expect(logger.__infoMock).not.toHaveBeenCalled();
            expect(fs.appendFileSync).not.toHaveBeenCalled();
            expect(fs.writeFileSync).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('CLI logs follow — latestLogFile', () => {
    beforeEach(() => jest.clearAllMocks());

    test('picks the most recently modified file of the prefix, skipping other names', () => {
        fs.readdirSync.mockReturnValue(
            names([
                'api-debug-x',
                'app-not-a-date.log',
                'errors-2026-10-29.log',
                'app-2026-10-27.log',
                'app-2026-10-29.log',
            ]),
        );
        fs.statSync.mockImplementation((p: fsModule.PathLike) => stat(String(p).endsWith('27.log') ? 1 : 7));

        expect(latestLogFile('/logs', 'app')).toEqual({ path: '/logs/app-2026-10-29.log', mtimeMs: 7 });
    });

    test('a tie goes to the lexicographically greater path, whatever the list order', () => {
        fs.readdirSync.mockReturnValue(names(['app-2026-10-28.log', 'app-2026-10-29.log', 'app-2026-10-27.log']));
        fs.statSync.mockReturnValue(stat(4));

        expect(latestLogFile('/logs', 'app')?.path).toBe('/logs/app-2026-10-29.log');
    });

    test('a file deleted between the listing and the stat is skipped', () => {
        fs.readdirSync.mockReturnValue(names(['app-2026-10-28.log', 'app-2026-10-29.log']));
        fs.statSync.mockImplementation((p: fsModule.PathLike) => {
            if (String(p).endsWith('28.log')) throw new Error('ENOENT');
            return stat(2);
        });

        expect(latestLogFile('/logs', 'app')?.path).toBe('/logs/app-2026-10-29.log');
    });

    test('a directory that cannot be read, or an empty one, has no newest file', () => {
        fs.readdirSync.mockImplementation(() => {
            throw new Error('ENOENT');
        });
        expect(latestLogFile('/logs', 'app')).toBeNull();

        fs.readdirSync.mockReturnValue(names([]));
        expect(latestLogFile('/logs', 'app')).toBeNull();
    });
});
