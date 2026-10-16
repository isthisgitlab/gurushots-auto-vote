/**
 * The changes of the import marker that could not be made (another process held the settings lock for the whole wait, or
 * the write was refused), against a real temp directory: they are made again with the next save or start while the app
 * runs, each only while the condition it served still stands, once said in the log, and a change that is refused to its
 * caller is never made later.
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

describe('the pending changes of the import marker (real fs)', () => {
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
    const write = (fields: Record<string, unknown>) =>
        fs.writeFileSync(markerFile, JSON.stringify({ importedAt: '2026-10-01T00:00:00.000Z', ...fields }));

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

    test('forgetting a copy that is replayed after another was recorded leaves the newer one', () => {
        write({ unimportableCopy: 'settings.json.unimportable-1' });
        load();
        lock.busy = true;
        marker.forgetUnimportableCopy();
        expect(stored().unimportableCopy).toBe('settings.json.unimportable-1');

        lock.busy = false;
        marker.rememberUnimportableCopy('settings.json.unimportable-2');
        marker.flushPendingMarkerChanges();

        expect(stored().unimportableCopy).toBe('settings.json.unimportable-2');
    });

    test('forgetting a copy is made when the replay finds it still recorded', () => {
        write({ unimportableCopy: 'settings.json.unimportable-1' });
        load();
        lock.busy = true;
        marker.forgetUnimportableCopy();

        lock.busy = false;
        marker.flushPendingMarkerChanges();

        expect(stored()).not.toHaveProperty('unimportableCopy');
    });

    test('the set-aside a Start fresh owed is forgotten by the replay only while it is the same record', () => {
        write({ legacyAsideOwed: 'one' });
        load();
        lock.busy = true;
        marker.clearLegacyAsideOwed('one');
        lock.busy = false;
        marker.flushPendingMarkerChanges();
        expect(stored()).not.toHaveProperty('legacyAsideOwed');

        write({ legacyAsideOwed: 'one' });
        lock.busy = true;
        marker.clearLegacyAsideOwed('one');
        lock.busy = false;
        // Another Start fresh recorded a set-aside of its own meanwhile.
        write({ legacyAsideOwed: 'two' });
        marker.flushPendingMarkerChanges();

        expect(stored().legacyAsideOwed).toBe('two');
    });

    test('the time the copies were cleared is the time of the clearing, not of the replay', () => {
        write({});
        load();
        jest.useFakeTimers({ now: new Date('2026-10-10T10:00:00.000Z') });
        lock.busy = true;
        marker.noteCopiesScrubbed();

        jest.setSystemTime(new Date('2026-10-12T10:00:00.000Z'));
        lock.busy = false;
        marker.flushPendingMarkerChanges();

        expect(stored().copiesScrubbedAt).toBe('2026-10-10T10:00:00.000Z');
    });

    test('a change that could not be made is said once, not at every replay', () => {
        write({});
        load();
        lock.busy = true;
        marker.noteCopiesScrubbed();
        expect(cat.warning).toHaveBeenCalledTimes(1);

        marker.flushPendingMarkerChanges();
        marker.flushPendingMarkerChanges();

        expect(cat.warning).toHaveBeenCalledTimes(1);
        expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining('while the app runs'));
    });

    test('a sign-out owed that could not be recorded is refused, and not recorded later', () => {
        write({});
        load();
        lock.busy = true;
        expect(marker.markSignOutOwed(['a.b.c.d'])).toBeNull();

        lock.busy = false;
        marker.flushPendingMarkerChanges();

        expect(stored()).not.toHaveProperty('signOutOwed');
    });

    test('removing an owed sign-out that could not be removed is not replayed: the record stays, harmless', () => {
        write({});
        load();
        const record = marker.markSignOutOwed(['a.b.c.d']);
        if (record === null) throw new Error('expected a record');
        lock.busy = true;
        marker.clearSignOutOwed(record.id);

        lock.busy = false;
        marker.flushPendingMarkerChanges();

        expect(stored().signOutOwed).toMatchObject({ id: record.id, fingerprints: ['a.b.c.d'] });
        expect(marker.signOutOwedStored()).toEqual(record);
    });

    test('an owed sign-out is removed by its own id and no other', () => {
        write({});
        load();
        const first = marker.markSignOutOwed(['a.b.c.d']);
        const second = marker.markSignOutOwed(['e.f.g.h']);
        if (first === null || second === null) throw new Error('expected records');

        marker.clearSignOutOwed(first.id);

        expect(marker.signOutOwedStored()).toEqual(second);
        marker.clearSignOutOwed(second.id);
        expect(stored()).not.toHaveProperty('signOutOwed');
    });

    test('a record that is not a well-formed owed sign-out is none', () => {
        write({ signOutOwed: { id: 'x', at: 'now', fingerprints: [1] } });
        load();
        expect(marker.signOutOwedStored()).toBeNull();
        write({ signOutOwed: 'old' });
        expect(marker.signOutOwedStored()).toBeNull();
    });
});
