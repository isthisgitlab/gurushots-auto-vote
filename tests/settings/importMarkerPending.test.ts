/**
 * The import marker, against a real temp directory: when it says the import is done (including one that cannot be
 * read), and the changes of it that could not be made (another process held the settings lock for the whole wait, or
 * the write was refused) — they are made again with the next save or start while the app runs, once said in the log.
 */

jest.mock('node:fs', () => {
    const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
    return { __esModule: true, ...actual, default: actual };
});
jest.unmock('path');
jest.unmock('node:path');
jest.mock('../../src/ts/logger', () => {
    const cat = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        withCategory: jest.fn(() => cat),
        __cat: cat,
    };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as importMarkerModule from '../../src/ts/settings/importMarker';
import type * as loggerModule from '../../src/ts/logger';
import type * as runtimeModule from '../../src/ts/runtime';
import type { CategoryLogger } from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';
import { parseJsonObject } from '../helpers/parseJson';

type CatDouble = jest.Mocked<Pick<CategoryLogger, 'warning'>>;

describe('the import marker (real fs)', () => {
    let root: string;
    let markerFile: string;
    let marker: typeof importMarkerModule;
    let cat: CatDouble;
    const lock = { busy: false };

    const load = () => {
        jest.isolateModules(() => {
            const actualRuntime = jest.requireActual<typeof runtimeModule>('../../src/ts/runtime');
            jest.doMock('../../src/ts/runtime', () => ({
                __esModule: true,
                ...actualRuntime,
                getAppUserDataPath: () => root,
            }));
            const actualWait = jest.requireActual<typeof import('../../src/ts/lockWait')>('../../src/ts/lockWait');
            jest.doMock('../../src/ts/lockWait', () => ({
                acquireWithin: (...args: Parameters<typeof actualWait.acquireWithin>) =>
                    lock.busy ? 'busy' : actualWait.acquireWithin(...args),
            }));
            marker = require('../../src/ts/settings/importMarker') as typeof importMarkerModule;
            cat = invalid<typeof loggerModule & { __cat: CatDouble }>(
                require('../../src/ts/logger') as typeof loggerModule,
            ).__cat;
        });
    };
    const stored = () => parseJsonObject(fs.readFileSync(markerFile, 'utf8'));
    const write = (fields: Record<string, unknown>) => fs.writeFileSync(markerFile, JSON.stringify(fields));

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-marker-'));
        markerFile = path.join(root, 'v2-import.json');
        lock.busy = false;
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        jest.dontMock('../../src/ts/runtime');
        jest.dontMock('../../src/ts/lockWait');
        fs.rmSync(root, { recursive: true, force: true });
    });

    describe('when it says the import is done', () => {
        test.each([
            ['holds importedAt', '{"importedAt":"2026-10-01T00:00:00.000Z"}', true],
            ['holds mirrorStartedAt', '{"mirrorStartedAt":"2026-10-01T00:00:00.000Z"}', true],
            [
                'holds both',
                '{"importedAt":"2026-10-01T00:00:00.000Z","mirrorStartedAt":"2026-10-01T00:00:01.000Z"}',
                true,
            ],
            ['holds a field an older build wrote', '{"signOutScrubPending":"a-sign-out"}', false],
            ['is not a JSON object', '{garbage', true],
            ['is a JSON array', '[]', true],
            ['is empty', '{}', false],
        ])('%s', (_name, raw, done) => {
            fs.writeFileSync(markerFile, raw);
            load();

            expect(marker.isImportMarked()).toBe(done);
        });

        test('a marker that cannot be read counts as done, is said once, and said again after it reads and fails once more', () => {
            // A directory where the file should be: reading it throws.
            fs.mkdirSync(markerFile);
            load();

            expect(marker.isImportMarked()).toBe(true);
            expect(cat.warning).toHaveBeenCalledTimes(1);
            expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining('could not be read'));

            // Once it reads again, a later failure is said again.
            fs.rmSync(markerFile, { recursive: true });
            expect(marker.isImportMarked()).toBe(false);
            fs.mkdirSync(markerFile);
            expect(marker.isImportMarked()).toBe(true);
            expect(cat.warning).toHaveBeenCalledTimes(2);
            // A failure that follows without a read in between is not said again.
            expect(marker.isImportMarked()).toBe(true);
            expect(cat.warning).toHaveBeenCalledTimes(2);
        });

        test('a marker that cannot be read is said without the path the error names, which holds the user name', () => {
            write({ importedAt: '2026-10-01T00:00:00.000Z' });
            load();
            jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
                throw new Error("EACCES: permission denied, open '/Users/someone/data/v2-import.json'");
            });

            marker.isImportMarked();

            expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining("open 'v2-import.json'"));
            expect(JSON.stringify(cat.warning.mock.calls)).not.toContain('someone');
        });

        test('a marker whose read throws a value that carries no message is said without one', () => {
            write({ importedAt: '2026-10-01T00:00:00.000Z' });
            load();
            jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
                throw 'weird';
            });

            marker.isImportMarked();

            expect(cat.warning).toHaveBeenCalledWith(
                expect.stringContaining('could not be read, so it counts as missing: unknown error'),
            );
        });
    });

    describe('markImportDone', () => {
        test('writes the one fact, dropping what an older build kept there', () => {
            write({ signOutScrubPending: 'a-sign-out', signInPending: 'a-fingerprint' });
            load();

            marker.markImportDone();

            expect(stored()).toEqual({ importedAt: expect.any(String) });
        });

        test('a marker that already says so is left as it is', () => {
            write({ importedAt: '2026-01-01T00:00:00.000Z' });
            load();

            marker.markImportDone();

            expect(stored()).toEqual({ importedAt: '2026-01-01T00:00:00.000Z' });
        });
    });

    describe('a change that could not be made yet', () => {
        test('is said once, not at every replay, and made when the lock is free again', () => {
            write({});
            load();
            lock.busy = true;
            marker.markImportDone();
            expect(cat.warning).toHaveBeenCalledTimes(1);

            marker.flushPendingMarkerChanges();
            marker.flushPendingMarkerChanges();

            expect(cat.warning).toHaveBeenCalledTimes(1);
            expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining('while the app runs'));

            lock.busy = false;
            marker.flushPendingMarkerChanges();

            expect(stored()).toEqual({ importedAt: expect.any(String) });
        });

        test('a replay whose condition has gone writes nothing: what is done stays done', () => {
            write({ importedAt: '2026-01-01T00:00:00.000Z' });
            load();
            lock.busy = true;
            marker.markImportDone();
            lock.busy = false;

            marker.flushPendingMarkerChanges();

            expect(stored()).toEqual({ importedAt: '2026-01-01T00:00:00.000Z' });
        });

        test('a queued write that fails later is kept and made with the next flush', async () => {
            write({});
            load();
            const now = jest.spyOn(marker.importMarkerStore, 'updateNow').mockReturnValue(null);
            const through = jest.spyOn(marker.importMarkerStore, 'updateThrough').mockResolvedValue('failed');
            marker.markImportDone();
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(stored()).toEqual({});

            // The next flush (the next save or start) makes it.
            now.mockRestore();
            through.mockRestore();
            marker.flushPendingMarkerChanges();

            expect(stored()).toEqual({ importedAt: expect.any(String) });
        });
    });
});
