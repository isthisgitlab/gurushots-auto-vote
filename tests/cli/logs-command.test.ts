/**
 * Unit tests for the CLI `logs` command. It tails one of the on-disk log
 * files (paths owned by the logger) so CLI users get the after-the-fact log
 * access the Electron Logs page provides, and `--follow` keeps printing what
 * is appended to any of the category's files. fs and the logger are mocked.
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
import { StringDecoder } from 'node:string_decoder';
import { MAX_MESSAGE_LENGTH } from '../../src/ts/logger/write';
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

// The fs automock carries every call the follower reads with but readSync;
// fill that one gap before the command module is required — its `import * as
// fs` snapshots the mocked module, so the patch must land on it first.
const fsAuto = invalid<Record<string, unknown>>(fs);
if (fsAuto.readSync === undefined) {
    fsAuto.readSync = jest.fn<number, [number, Buffer, number, number, number | null]>();
}

const { FOLLOW_READ_CHUNK_BYTES, followLogs, followStep, latestLogFile, showLogs } =
    require('../../src/ts/cli/commands/logs') as typeof logsModule;

describe('CLI logs command', () => {
    beforeEach(() => jest.clearAllMocks());

    test('prints the last N lines of the app log by default', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('line1\nline2\nline3\nline4');

        showLogs({ lines: 2 });

        expect(logger.getLogFile).toHaveBeenCalled();
        // The tail prints one print call per line — one call is capped, so a
        // tail printed as one string would lose its newest lines.
        expect(logger.__printMock.mock.calls).toEqual([['line3'], ['line4']]);
        expect(logger.__infoMock.mock.calls.map((c) => c[0]).join('\n')).not.toContain('line3');
    });

    test('the piece after the final newline is not a line: --lines=N prints the last N real lines', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('l1\nl2\nl3\n');

        showLogs({ lines: 2 });

        expect(logger.__printMock.mock.calls).toEqual([['l2'], ['l3']]);
    });

    test('a blank line in the file prints as the empty line it is', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('l1\n\nl3\n');

        showLogs({ lines: 3 });

        expect(logger.__printMock.mock.calls).toEqual([['l1'], [''], ['l3']]);
    });

    test('a line longer than the print cap prints in pieces, in order, every character', () => {
        fs.existsSync.mockReturnValue(true);
        const long = 'x'.repeat(20000);
        fs.readFileSync.mockReturnValue(`before\n${long}\nafter`);

        showLogs({ lines: 10 });

        expect(logger.__printMock.mock.calls).toEqual([
            ['before'],
            [long.slice(0, MAX_MESSAGE_LENGTH)],
            [long.slice(MAX_MESSAGE_LENGTH)],
            ['after'],
        ]);
    });

    test('a cut landing inside a surrogate pair moves back one unit: every character prints, no U+FFFD', () => {
        fs.existsSync.mockReturnValue(true);
        // '😀' is astral: two UTF-16 code units placed so the plain by-unit
        // cut at the cap lands between them and would print U+FFFD twice.
        const emoji = '😀';
        const line = 'a'.repeat(MAX_MESSAGE_LENGTH - 1) + emoji + 'end';
        expect(line.length).toBe(MAX_MESSAGE_LENGTH + 4);
        fs.readFileSync.mockReturnValue(line);

        showLogs({ lines: 10 });

        const printed = logger.__printMock.mock.calls.map(([text]) => text);
        expect(printed.join('')).toBe(line);
        expect(printed.some((text) => text.includes('�'))).toBe(false);
    });

    test('terminal control sequences in the file never reach the terminal, line by line', () => {
        const ESC = String.fromCharCode(27);
        const BEL = String.fromCharCode(7);
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
            `ok line\nbad ${ESC}[31mred${ESC}[0m line\ntitle ${ESC}]0;pwned${BEL}set\nrtl ‮evil\nlast`,
        );
        showLogs({ lines: 10 });
        expect(logger.__printMock.mock.calls).toEqual([
            ['ok line'],
            ['bad red line'],
            ['title set'],
            ['rtl evil'],
            ['last'],
        ]);
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
const ERROR_FILE = '/logs/errors-2026-10-29.log';

/** Injected follower surroundings: an empty listing, the newest file, a recording printer and a controllable stop. */
const followDeps = (over: Partial<logsModule.FollowDeps> = {}): logsModule.FollowDeps => ({
    dir: '/logs',
    intervalMs: 0,
    list: jest.fn<string[] | null, [string, string]>().mockReturnValue([]),
    latest: jest
        .fn<logsModule.LatestLogFile | null, [string, string]>()
        .mockReturnValue({ path: OLD_FILE, mtimeMs: 1 }),
    print: jest.fn<void, [string]>(),
    sleep: jest.fn<Promise<void>, [number]>(async () => {
        process.emit('SIGINT');
    }),
    ...over,
});

const listOf = (...paths: string[]): jest.Mock<string[] | null, [string, string]> =>
    jest.fn<string[] | null, [string, string]>().mockReturnValue(paths);

const freshState = (): logsModule.FollowState => ({ files: new Map(), lastPrinted: null });

// The inode backFiles' statSync reports; a test that re-creates a file
// overrides it to a different value, like a new file under the same name.
const INODE = 101;

const fileState = (offset: number): logsModule.FileFollowState => ({
    offset,
    decoder: new StringDecoder('utf8'),
    pending: '',
    ino: INODE,
});

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');

/**
 * Backs the mocked fs with in-memory byte files: statSync serves byte sizes,
 * openSync/readSync serve byte spans, readFileSync serves whole-file text.
 * Appending between polls is replacing a record's Buffer.
 */
const backFiles = (files: Record<string, Buffer>): void => {
    fs.statSync.mockImplementation((p: fsModule.PathLike) => {
        const file = files[String(p)];
        if (file === undefined) throw new Error('ENOENT');
        return invalid<fsModule.Stats>({ size: file.length, mtimeMs: 1, ino: INODE });
    });
    let opened = '';
    let nextFd = 10;
    fs.openSync.mockImplementation((p: fsModule.PathLike) => {
        if (files[String(p)] === undefined) throw new Error('ENOENT');
        opened = String(p);
        const fd = nextFd;
        nextFd += 1;
        return fd;
    });
    // jest's mocked type carries the options overload of readSync; the
    // follower calls the positional one, so the span arguments ride in `rest`.
    fs.readSync.mockImplementation((_fd, buffer, ...rest): number => {
        const [offset, length, position] = invalid<[number, number, number | null]>(rest);
        const file = files[opened];
        if (file === undefined || position === null || position >= file.length) return 0;
        const end = Math.min(position + length, file.length);
        file.copy(invalid<Buffer>(buffer), offset, position, end);
        return end - position;
    });
    fs.closeSync.mockImplementation(() => undefined);
    // The tail reads bytes (no encoding), plain `logs` reads text ('utf8'):
    // the mocked read serves both forms off the same in-memory file.
    invalid<{
        mockImplementation: (impl: (p: fsModule.PathOrFileDescriptor, encoding?: string) => string | Buffer) => void;
    }>(fs.readFileSync).mockImplementation((p, encoding) => {
        const file = files[String(p)];
        if (file === undefined) throw new Error('ENOENT');
        return encoding === undefined ? file : file.toString('utf8');
    });
};

describe('CLI logs follow — followStep', () => {
    beforeEach(() => jest.clearAllMocks());

    test('follows every file of the category at once: no line twice, every new line once', () => {
        const files = { [OLD_FILE]: bytes('a1\n'), [NEW_FILE]: bytes('b1\n') };
        backFiles(files);
        const state = freshState();
        state.files.set(OLD_FILE, fileState(3));
        state.files.set(NEW_FILE, fileState(3));
        const print = jest.fn<void, [string]>();
        const deps = followDeps({ list: listOf(OLD_FILE, NEW_FILE), print });

        followStep(state, 'app', deps);
        // Nothing appended since the start: nothing prints.
        expect(print.mock.calls).toEqual([]);

        files[OLD_FILE] = Buffer.concat([files[OLD_FILE], bytes('a2\n')]);
        followStep(state, 'app', deps);
        expect(print.mock.calls).toEqual([['--- ' + OLD_FILE], ['a2']]);

        files[NEW_FILE] = Buffer.concat([files[NEW_FILE], bytes('b2\n')]);
        followStep(state, 'app', deps);
        expect(print.mock.calls).toEqual([['--- ' + OLD_FILE], ['a2'], ['--- ' + NEW_FILE], ['b2']]);

        files[OLD_FILE] = Buffer.concat([files[OLD_FILE], bytes('a3\n')]);
        followStep(state, 'app', deps);
        // The source switched back to the first file, so it is named again;
        // the lines the files held at the start never replay.
        expect(print.mock.calls).toEqual([
            ['--- ' + OLD_FILE],
            ['a2'],
            ['--- ' + NEW_FILE],
            ['b2'],
            ['--- ' + OLD_FILE],
            ['a3'],
        ]);
        expect(state.files.get(OLD_FILE)?.offset).toBe(files[OLD_FILE].length);
    });

    test('a poll that appends more than one printLine cap prints every line', () => {
        const files = { [OLD_FILE]: bytes('seed\n') };
        backFiles(files);
        const state = freshState();
        state.files.set(OLD_FILE, fileState(5));
        const appended = Array.from({ length: 200 }, (_, i) => `l${i} ${'x'.repeat(100)}`);
        files[OLD_FILE] = Buffer.concat([files[OLD_FILE], bytes(appended.map((l) => `${l}\n`).join(''))]);
        expect(files[OLD_FILE].length).toBeGreaterThan(16384);
        const print = jest.fn<void, [string]>();

        followStep(state, 'app', followDeps({ list: listOf(OLD_FILE), print }));

        // One print call per line — a single call is capped at 16384
        // characters, which would lose the newest lines.
        expect(print.mock.calls).toEqual([['--- ' + OLD_FILE], ...appended.map((l) => [l])]);
        expect(state.files.get(OLD_FILE)?.offset).toBe(files[OLD_FILE].length);
    });

    test('an unread span larger than one chunk is read in bounded pieces', () => {
        const files = { [OLD_FILE]: bytes('seed\n') };
        backFiles(files);
        const state = freshState();
        state.files.set(OLD_FILE, fileState(5));
        const print = jest.fn<void, [string]>();
        // 150 lines of 10,000 characters: a span well over one read chunk.
        const line = 'y'.repeat(10000);
        const whole = Buffer.concat([files[OLD_FILE], bytes(Array.from({ length: 150 }, () => `${line}\n`).join(''))]);
        files[OLD_FILE] = whole;
        expect(whole.length).toBeGreaterThan(FOLLOW_READ_CHUNK_BYTES);
        // The mocked read serves at most 700,000 bytes per call, like a read
        // that returns short of the requested span.
        fs.readSync.mockImplementation((_fd, buffer, ...rest): number => {
            const [offset, length, position] = invalid<[number, number, number | null]>(rest);
            if (position === null || position >= whole.length) return 0;
            const end = Math.min(position + Math.min(length, 700000), whole.length);
            whole.copy(invalid<Buffer>(buffer), offset, position, end);
            return end - position;
        });

        followStep(state, 'app', followDeps({ list: listOf(OLD_FILE), print }));

        // Every line printed once, in order, across the bounded reads.
        expect(print.mock.calls).toEqual([['--- ' + OLD_FILE], ...Array.from({ length: 150 }, () => [line])]);
        expect(state.files.get(OLD_FILE)?.offset).toBe(whole.length);
        // No read asked for more than the chunk cap.
        const requested = fs.readSync.mock.calls.map((call) => invalid<Buffer>(call[1]).length);
        expect(requested.length).toBeGreaterThan(1);
        for (const size of requested) expect(size).toBeLessThanOrEqual(FOLLOW_READ_CHUNK_BYTES);
    });

    test('a line longer than the print cap prints in pieces, every character once', () => {
        const files = { [OLD_FILE]: bytes('seed\n') };
        backFiles(files);
        const state = freshState();
        state.files.set(OLD_FILE, fileState(5));
        const print = jest.fn<void, [string]>();
        const long = 'x'.repeat(20000);
        expect(long.length).toBeGreaterThan(MAX_MESSAGE_LENGTH);
        files[OLD_FILE] = Buffer.concat([files[OLD_FILE], bytes(`${long}\n`)]);

        followStep(state, 'app', followDeps({ list: listOf(OLD_FILE), print }));

        expect(print.mock.calls).toEqual([
            ['--- ' + OLD_FILE],
            [long.slice(0, MAX_MESSAGE_LENGTH)],
            [long.slice(MAX_MESSAGE_LENGTH)],
        ]);
        expect(state.files.get(OLD_FILE)?.offset).toBe(files[OLD_FILE].length);
    });

    test('a half-written last line is held until its newline arrives', () => {
        const files = { [OLD_FILE]: bytes('seed\nhel') };
        backFiles(files);
        const state = freshState();
        state.files.set(OLD_FILE, fileState(5));
        const print = jest.fn<void, [string]>();
        const deps = followDeps({ list: listOf(OLD_FILE), print });

        followStep(state, 'app', deps);
        expect(print.mock.calls).toEqual([]);
        expect(state.files.get(OLD_FILE)?.pending).toBe('hel');

        files[OLD_FILE] = Buffer.concat([files[OLD_FILE], bytes('lo\nmore\n')]);
        followStep(state, 'app', deps);
        expect(print.mock.calls).toEqual([['--- ' + OLD_FILE], ['hello'], ['more']]);
    });

    test('a multi-byte character split across two polls prints once and correctly', () => {
        const files = { [OLD_FILE]: bytes('seed\n') };
        backFiles(files);
        const state = freshState();
        state.files.set(OLD_FILE, fileState(5));
        const print = jest.fn<void, [string]>();
        const deps = followDeps({ list: listOf(OLD_FILE), print });

        // 'é' is two UTF-8 bytes; the first poll ends between them.
        files[OLD_FILE] = Buffer.concat([files[OLD_FILE], Buffer.from([0x68, 0xc3])]);
        followStep(state, 'app', deps);
        expect(print.mock.calls).toEqual([]);

        files[OLD_FILE] = Buffer.concat([files[OLD_FILE], Buffer.from([0xa9]), bytes('llo\n')]);
        followStep(state, 'app', deps);
        expect(print.mock.calls).toEqual([['--- ' + OLD_FILE], ['héllo']]);
        expect(state.files.get(OLD_FILE)?.offset).toBe(files[OLD_FILE].length);
    });

    test('a file re-created under the same name with a new inode restarts at byte 0, even when it is already longer', () => {
        const files = { [OLD_FILE]: bytes('a1\n') };
        backFiles(files);
        const state = freshState();
        state.files.set(OLD_FILE, fileState(3));
        const print = jest.fn<void, [string]>();
        const deps = followDeps({ list: listOf(OLD_FILE), print });

        // Deleted and written again between two polls, already longer than the
        // old offset (3), under a new inode. The inode, not the name, tells
        // the two files apart: the new content prints from its first line,
        // never from the deleted file's offset.
        files[OLD_FILE] = bytes('fresh\nmore\n');
        const realStat = fs.statSync.getMockImplementation() as (p: fsModule.PathLike) => fsModule.Stats;
        fs.statSync.mockImplementation((p: fsModule.PathLike) => {
            const st = realStat(p);
            return String(p) === OLD_FILE ? invalid<fsModule.Stats>({ ...st, ino: INODE + 1 }) : st;
        });
        followStep(state, 'app', deps);

        expect(print.mock.calls).toEqual([['--- ' + OLD_FILE], ['fresh'], ['more']]);
        expect(state.files.get(OLD_FILE)?.offset).toBe(files[OLD_FILE].length);
        expect(state.files.get(OLD_FILE)?.ino).toBe(INODE + 1);
    });

    test('a read-chunk boundary inside a multi-byte character prints it once and correctly', () => {
        const files = { [OLD_FILE]: bytes('seed\n') };
        backFiles(files);
        const state = freshState();
        state.files.set(OLD_FILE, fileState(5));
        const print = jest.fn<void, [string]>();
        // 'é' is two UTF-8 bytes and straddles the chunk boundary: the first
        // 1 MiB read ends between its two bytes.
        const line = 'a'.repeat(FOLLOW_READ_CHUNK_BYTES - 1) + 'é';
        files[OLD_FILE] = Buffer.concat([files[OLD_FILE], bytes(`${line}\n`)]);
        expect(files[OLD_FILE].length).toBeGreaterThan(FOLLOW_READ_CHUNK_BYTES);

        followStep(state, 'app', followDeps({ list: listOf(OLD_FILE), print }));

        // The line reassembles exactly from the printed pieces: the character
        // the chunk reads split printed once, not as U+FFFD.
        const pieces: string[] = [];
        for (let at = 0; at < line.length; at += MAX_MESSAGE_LENGTH) {
            pieces.push(line.slice(at, at + MAX_MESSAGE_LENGTH));
        }
        expect(print.mock.calls).toEqual([['--- ' + OLD_FILE], ...pieces.map((piece) => [piece])]);
        expect(state.files.get(OLD_FILE)?.offset).toBe(files[OLD_FILE].length);
    });

    test('a truncated file restarts from byte 0 with fresh decoder and line state', () => {
        const files = { [OLD_FILE]: bytes('a1\na2\na3\n') };
        backFiles(files);
        const state = freshState();
        const st = fileState(files[OLD_FILE].length);
        st.pending = 'part';
        state.files.set(OLD_FILE, st);
        const print = jest.fn<void, [string]>();
        const deps = followDeps({ list: listOf(OLD_FILE), print });

        files[OLD_FILE] = bytes('a1'); // truncated in place, then rewritten
        followStep(state, 'app', deps);

        expect(print.mock.calls).toEqual([]);
        expect(state.files.get(OLD_FILE)?.offset).toBe(2);
        expect(state.files.get(OLD_FILE)?.pending).toBe('a1'); // not 'parta1'

        files[OLD_FILE] = bytes('a1\nb1\n');
        followStep(state, 'app', deps);
        expect(print.mock.calls).toEqual([['--- ' + OLD_FILE], ['a1'], ['b1']]);
    });

    test('a deleted file is dropped though the listing no longer names it; a recreated one prints from its first line', () => {
        const files: Record<string, Buffer> = { [OLD_FILE]: bytes('a1\n') };
        backFiles(files);
        const state = freshState();
        state.files.set(OLD_FILE, fileState(3));
        let listed: string[] = [OLD_FILE];
        const list = jest.fn<string[], [string, string]>().mockImplementation(() => listed);
        const print = jest.fn<void, [string]>();
        const deps = followDeps({ list, print });

        // Deleted: the file is gone and the folder listing leaves it out, so
        // only the state prune can retire it.
        listed = [];
        delete files[OLD_FILE];
        followStep(state, 'app', deps);
        expect(print.mock.calls).toEqual([]);
        expect(state.files.has(OLD_FILE)).toBe(false);

        // The same name comes back, already longer than the old offset (3):
        // it is followed from its first line, never from the old offset.
        files[OLD_FILE] = bytes('fresh\nmore\n');
        listed = [OLD_FILE];
        followStep(state, 'app', deps);
        expect(print.mock.calls).toEqual([['--- ' + OLD_FILE], ['fresh'], ['more']]);
        expect(state.files.get(OLD_FILE)?.offset).toBe(files[OLD_FILE].length);
    });

    test('a failed folder listing skips the poll whole: no prune, no replay on the next good listing', () => {
        const files = { [OLD_FILE]: bytes('a1\n') };
        backFiles(files);
        const state = freshState();
        state.files.set(OLD_FILE, fileState(3));
        const print = jest.fn<void, [string]>();
        let listed: string[] | null = [OLD_FILE];
        const list = jest.fn<string[] | null, [string, string]>().mockImplementation(() => listed);
        const deps = followDeps({ list, print });

        // The append lands, then the folder read fails: the poll must neither
        // prune the follow state nor print, or the next good listing would
        // replay the file from byte 0.
        files[OLD_FILE] = Buffer.concat([files[OLD_FILE], bytes('a2\n')]);
        listed = null;
        followStep(state, 'app', deps);
        expect(print.mock.calls).toEqual([]);
        expect(state.files.has(OLD_FILE)).toBe(true);

        // The read works again: the appended line prints once, nothing replays.
        listed = [OLD_FILE];
        followStep(state, 'app', deps);
        expect(print.mock.calls).toEqual([['--- ' + OLD_FILE], ['a2']]);
        expect(state.files.get(OLD_FILE)?.offset).toBe(files[OLD_FILE].length);
    });

    test('a file created after the start is followed from its first line', () => {
        const files = { [OLD_FILE]: bytes('a1\n'), [NEW_FILE]: bytes('b1\n') };
        backFiles(files);
        const state = freshState();
        state.files.set(OLD_FILE, fileState(3));
        const print = jest.fn<void, [string]>();

        followStep(state, 'app', followDeps({ list: listOf(OLD_FILE, NEW_FILE), print }));

        expect(print.mock.calls).toEqual([['--- ' + NEW_FILE], ['b1']]);
        expect(state.files.get(NEW_FILE)?.offset).toBe(3);
    });

    test('a file that cannot be opened between the stat and the read is retried next poll', () => {
        const files = { [OLD_FILE]: bytes('a1\n') };
        backFiles(files);
        const state = freshState();
        state.files.set(OLD_FILE, fileState(0));
        const print = jest.fn<void, [string]>();
        const deps = followDeps({ list: listOf(OLD_FILE), print });
        fs.openSync.mockImplementation(() => {
            throw new Error('EACCES');
        });

        followStep(state, 'app', deps);

        expect(print.mock.calls).toEqual([]);
        expect(state.files.get(OLD_FILE)?.offset).toBe(0);
        expect(fs.closeSync).not.toHaveBeenCalled();

        backFiles(files); // the open works again
        followStep(state, 'app', deps);
        expect(print.mock.calls).toEqual([['--- ' + OLD_FILE], ['a1']]);
        expect(fs.closeSync).toHaveBeenCalled();
    });

    test('a file that ends right after the stat prints nothing and keeps its offset', () => {
        const files = { [OLD_FILE]: bytes('a1\n') };
        backFiles(files);
        const state = freshState();
        state.files.set(OLD_FILE, fileState(1));
        const print = jest.fn<void, [string]>();
        fs.readSync.mockReturnValue(0);

        followStep(state, 'app', followDeps({ list: listOf(OLD_FILE), print }));

        expect(print.mock.calls).toEqual([]);
        expect(state.files.get(OLD_FILE)?.offset).toBe(1);
        expect(fs.closeSync).toHaveBeenCalled();
    });
});

describe('CLI logs follow — followLogs', () => {
    beforeEach(() => jest.clearAllMocks());

    test('prints the last --lines of the newest file first, one call per line', async () => {
        const files = { [OLD_FILE]: bytes('l1\nl2\nl3\n') };
        backFiles(files);
        const latest = jest
            .fn<logsModule.LatestLogFile | null, [string, string]>()
            .mockReturnValue({ path: OLD_FILE, mtimeMs: 5 });
        const print = jest.fn<void, [string]>();

        const code = await followLogs({
            category: 'app',
            lines: 2,
            deps: followDeps({ list: listOf(OLD_FILE), latest, print }),
        });

        expect(code).toBe(0);
        // The separator names the file the tail came from; the piece after the
        // file's final newline is not a line and prints nothing; then the stop
        // hint, and the poll finds nothing appended.
        expect(print.mock.calls).toEqual([
            ['--- ' + OLD_FILE],
            ['l2'],
            ['l3'],
            ['Following app logs (Ctrl+C to stop)'],
            ['Stopped following the log.'],
        ]);
    });

    test('an initial tail longer than one printLine cap still prints its newest lines', async () => {
        const tail = Array.from({ length: 200 }, (_, i) => `t${i} ${'y'.repeat(100)}`);
        const content = `old line\n${tail.map((l) => `${l}\n`).join('')}`;
        expect(content.length).toBeGreaterThan(16384);
        backFiles({ [OLD_FILE]: bytes(content) });
        const latest = jest
            .fn<logsModule.LatestLogFile | null, [string, string]>()
            .mockReturnValue({ path: OLD_FILE, mtimeMs: 1 });
        const print = jest.fn<void, [string]>();

        await followLogs({
            category: 'app',
            lines: 200,
            deps: followDeps({ list: listOf(OLD_FILE), latest, print }),
        });

        const printed = print.mock.calls.map(([line]) => line);
        expect(printed[0]).toBe('--- ' + OLD_FILE);
        // The window holds the 200 newest full lines (the piece after the
        // file's final newline is not a line), and every line prints whole —
        // printed as one string they would have been cut at the cap.
        expect(printed.slice(1, -2)).toEqual(tail);
        expect(printed.at(-2)).toBe('Following app logs (Ctrl+C to stop)');
        expect(printed.at(-1)).toBe('Stopped following the log.');
    });

    test('the tail seeds the followed offset from the bytes the tail read, not the earlier stat', async () => {
        const files = { [OLD_FILE]: bytes('a1\na2\n') };
        backFiles(files);
        // The start-up stat that seeds the state runs before an append lands:
        // it reports 3 bytes; the tail's own read then sees all 6.
        const realStat = fs.statSync.getMockImplementation() as (p: fsModule.PathLike) => fsModule.Stats;
        let seeded = false;
        fs.statSync.mockImplementation((p: fsModule.PathLike) => {
            if (!seeded && String(p) === OLD_FILE) {
                seeded = true;
                return invalid<fsModule.Stats>({ size: 3, mtimeMs: 1 });
            }
            return realStat(p);
        });
        const latest = jest
            .fn<logsModule.LatestLogFile | null, [string, string]>()
            .mockReturnValue({ path: OLD_FILE, mtimeMs: 5 });
        const print = jest.fn<void, [string]>();

        await followLogs({
            category: 'app',
            lines: 2,
            deps: followDeps({ list: listOf(OLD_FILE), latest, print }),
        });

        // The tail printed the last two lines, and the first poll — size 6,
        // offset 6 — found nothing appended: the bytes between the stale stat
        // and the tail read did not print twice.
        expect(print.mock.calls).toEqual([
            ['--- ' + OLD_FILE],
            ['a1'],
            ['a2'],
            ['Following app logs (Ctrl+C to stop)'],
            ['Stopped following the log.'],
        ]);
    });

    test("the tail's last line without its newline is held, and prints once when it is complete", async () => {
        const files = { [OLD_FILE]: bytes('l1\nl2\npar') };
        backFiles(files);
        const latest = jest
            .fn<logsModule.LatestLogFile | null, [string, string]>()
            .mockReturnValue({ path: OLD_FILE, mtimeMs: 1 });
        let polls = 0;
        const sleep = jest.fn<Promise<void>, [number]>(async () => {
            polls += 1;
            if (polls === 1) files[OLD_FILE] = Buffer.concat([files[OLD_FILE], bytes('tial\n')]);
            if (polls >= 2) process.emit('SIGINT');
        });
        const print = jest.fn<void, [string]>();

        await followLogs({
            category: 'app',
            lines: 2,
            deps: followDeps({ list: listOf(OLD_FILE), latest, print, sleep }),
        });

        // The tail printed its two real lines and held 'par'; the poll that
        // completed the line printed it once, whole.
        expect(print.mock.calls).toEqual([
            ['--- ' + OLD_FILE],
            ['l1'],
            ['l2'],
            ['Following app logs (Ctrl+C to stop)'],
            ['partial'],
            ['Stopped following the log.'],
        ]);
    });

    test('with no log file yet it waits, then follows one from its first line when it appears', async () => {
        const files: Record<string, Buffer> = {};
        backFiles(files);
        const latest = jest
            .fn<logsModule.LatestLogFile | null, [string, string]>()
            .mockReturnValueOnce(null)
            .mockReturnValue({ path: ERROR_FILE, mtimeMs: 1 });
        let polls = 0;
        const sleep = jest.fn<Promise<void>, [number]>(async () => {
            polls += 1;
            if (polls === 1) files[ERROR_FILE] = bytes('whole file\n');
            if (polls >= 2) process.emit('SIGINT');
        });
        const print = jest.fn<void, [string]>();

        const code = await followLogs({
            category: 'error',
            lines: 5,
            deps: followDeps({ list: listOf(ERROR_FILE), latest, print, sleep }),
        });

        expect(code).toBe(0);
        // The category's prefix decides what is followed.
        expect(latest).toHaveBeenCalledWith('/logs', 'errors');
        // The file appears between the polls, so the poll reads it from its
        // first byte; the text after its final newline is held, not printed.
        expect(print.mock.calls).toEqual([
            ['No error log file to follow yet; waiting for one to appear.'],
            ['Following error logs (Ctrl+C to stop)'],
            ['--- ' + ERROR_FILE],
            ['whole file'],
            ['Stopped following the log.'],
        ]);
    });

    test('a failed listing at the start seeds nothing, and the polls still follow', async () => {
        const files = { [OLD_FILE]: bytes('a1\n') };
        backFiles(files);
        const latest = jest
            .fn<logsModule.LatestLogFile | null, [string, string]>()
            .mockReturnValue({ path: OLD_FILE, mtimeMs: 1 });
        let listed: string[] | null = null; // the first read of the folder fails
        const list = jest.fn<string[] | null, [string, string]>().mockImplementation(() => listed);
        let polls = 0;
        const sleep = jest.fn<Promise<void>, [number]>(async () => {
            polls += 1;
            if (polls === 1) listed = [OLD_FILE];
            if (polls >= 2) process.emit('SIGINT');
        });
        const print = jest.fn<void, [string]>();

        const code = await followLogs({
            category: 'app',
            lines: 2,
            deps: followDeps({ list, latest, print, sleep }),
        });

        // The failed seed listing seeded nothing (the tail re-seeds the file
        // from its own read anyway), no poll pruned or replayed, and the run
        // ended 0.
        expect(code).toBe(0);
        expect(print.mock.calls).toEqual([
            ['--- ' + OLD_FILE],
            ['a1'],
            ['Following app logs (Ctrl+C to stop)'],
            ['Stopped following the log.'],
        ]);
    });

    test('a newest file that vanishes before the tail leaves the poll to re-resolve', async () => {
        backFiles({}); // nothing on disk
        const latest = jest
            .fn<logsModule.LatestLogFile | null, [string, string]>()
            .mockReturnValue({ path: OLD_FILE, mtimeMs: 1 });
        const print = jest.fn<void, [string]>();

        const code = await followLogs({
            category: 'app',
            lines: 5,
            deps: followDeps({ list: listOf(OLD_FILE), latest, print }),
        });

        expect(code).toBe(0);
        expect(print.mock.calls).toEqual([['Following app logs (Ctrl+C to stop)'], ['Stopped following the log.']]);
    });

    test('SIGINT stops the follower with exit 0 and removes its listener', async () => {
        const before = process.listenerCount('SIGINT');
        backFiles({ [OLD_FILE]: bytes('x\n') });
        const print = jest.fn<void, [string]>();

        const code = await followLogs({
            category: 'app',
            lines: 1,
            deps: followDeps({ list: listOf(OLD_FILE), print }),
        });

        expect(code).toBe(0);
        expect(print.mock.calls.at(-1)).toEqual(['Stopped following the log.']);
        expect(process.listenerCount('SIGINT')).toBe(before);
    });

    test('defaults to the app category and the last 100 lines', async () => {
        const content = `${Array.from({ length: 101 }, (_, i) => `l${i + 1}`).join('\n')}\n`;
        backFiles({ [OLD_FILE]: bytes(content) });
        const list = listOf(OLD_FILE);
        const latest = jest
            .fn<logsModule.LatestLogFile | null, [string, string]>()
            .mockReturnValue({ path: OLD_FILE, mtimeMs: 1 });
        const print = jest.fn<void, [string]>();

        const code = await followLogs({ deps: followDeps({ list, latest, print }) });

        expect(code).toBe(0);
        expect(list).toHaveBeenCalledWith('/logs', 'app');
        expect(latest).toHaveBeenCalledWith('/logs', 'app');
        const lines = print.mock.calls.map(([line]) => line);
        expect(lines[0]).toBe('--- ' + OLD_FILE);
        expect(lines[1]).toBe('l2');
        expect(lines[100]).toBe('l101');
        expect(lines[101]).toBe('Following app logs (Ctrl+C to stop)');
        expect(lines.at(-1)).toBe('Stopped following the log.');
    });

    test('never writes into the file it reads', async () => {
        const files = { [OLD_FILE]: bytes('seed\n') };
        backFiles(files);
        const latest = jest
            .fn<logsModule.LatestLogFile | null, [string, string]>()
            .mockReturnValue({ path: OLD_FILE, mtimeMs: 1 });
        let polls = 0;
        const sleep = jest.fn<Promise<void>, [number]>(async () => {
            polls += 1;
            if (polls === 1) files[OLD_FILE] = Buffer.concat([files[OLD_FILE], bytes('appended\n')]);
            if (polls >= 2) process.emit('SIGINT');
        });
        const print = jest.fn<void, [string]>();

        await followLogs({
            category: 'app',
            lines: 1,
            deps: followDeps({ list: listOf(OLD_FILE), latest, print, sleep }),
        });

        // The tail was read from the file (as bytes, so the offset it seeds is
        // a byte count), and nothing wrote anywhere: an info() would append to
        // the followed app log. The text after the appended line's newline is
        // held as pending, not printed.
        expect(fs.readFileSync).toHaveBeenCalledWith(OLD_FILE);
        expect(fs.appendFileSync).not.toHaveBeenCalled();
        expect(fs.writeFileSync).not.toHaveBeenCalled();
        expect(print.mock.calls).toEqual([
            ['--- ' + OLD_FILE],
            ['seed'],
            ['Following app logs (Ctrl+C to stop)'],
            ['appended'],
            ['Stopped following the log.'],
        ]);
    });

    test('follows with the default poll interval until SIGINT, printing to the console only', async () => {
        jest.useFakeTimers();
        try {
            const ESC = String.fromCharCode(27);
            const files = { [OLD_FILE]: bytes('a\n') };
            backFiles(files);
            // readdirSync lists names; the real listLogFiles and latestLogFile
            // join and pick from them.
            fs.readdirSync.mockReturnValue(names(['app-2026-10-28.log']));
            // The bare call takes the defaults: the app category, 100 lines,
            // the real deps.
            const pending = followLogs();

            files[OLD_FILE] = Buffer.concat([files[OLD_FILE], bytes(`bad ${ESC}[31mred${ESC}[0m line\n`)]);
            // One poll at the default 1s interval.
            await jest.advanceTimersByTimeAsync(1000);
            expect(logger.__printMock.mock.calls).toEqual([
                ['--- ' + OLD_FILE],
                ['a'],
                ['Following app logs (Ctrl+C to stop)'],
                ['bad red line'],
            ]);

            process.emit('SIGINT');
            await jest.advanceTimersByTimeAsync(1000);
            await expect(pending).resolves.toBe(0);
            expect(logger.__printMock.mock.calls.at(-1)).toEqual(['Stopped following the log.']);
            // Following a log must never write into the files it reads: an
            // info() would append to the followed app log.
            expect(logger.__infoMock).not.toHaveBeenCalled();
            expect(fs.appendFileSync).not.toHaveBeenCalled();
            expect(fs.writeFileSync).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });
});

const stat = (mtimeMs: number) => invalid<fsModule.Stats>({ mtimeMs });

// readdirSync's mocked type resolves to the Dirent overload; the listing
// reads names, so the string lists pass through as dirents.
const names = (list: string[]): ReturnType<typeof fs.readdirSync> => invalid(list);

describe('CLI logs follow — latestLogFile', () => {
    beforeEach(() => jest.clearAllMocks());

    test('picks the most recently modified file of the prefix, skipping other names', () => {
        fs.readdirSync.mockReturnValue(
            names([
                'api-debug-x',
                'app-not-a-date.log',
                'errors-2026-10-29.log',
                'app-2026-10-27.log',
                'app-2026-10-28.log',
                'app-2026-10-29.log',
            ]),
        );
        // An earlier day's file written most recently is the newest; a later
        // day's stale file loses.
        fs.statSync.mockImplementation((p: fsModule.PathLike) =>
            stat(String(p).endsWith('28.log') ? 11 : String(p).endsWith('27.log') ? 9 : 7),
        );

        expect(latestLogFile('/logs', 'app')).toEqual({ path: '/logs/app-2026-10-28.log', mtimeMs: 11 });
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
