/**
 * The headless family's storage member: the AndroidHeadlessStore bridge
 * transport its `jsonStore` and `settingsFile` builders give one store each —
 * the keyed reads and writes with the per-key memory cache, the
 * compare-and-write of a shared key, and the settings file through the
 * bridge's own read/write pair. The strict-write and failed-read semantics
 * are covered through the store factories (tests/settings/createJsonStore.test.ts,
 * tests/settings/storage.test.ts); these cover the family's own operation
 * surface.
 */

const error = jest.fn();

jest.mock('../../../src/ts/core/logger', () => ({
    __esModule: true,
    withCategory: jest.fn(() => ({ error, info: jest.fn(), warning: jest.fn(), debug: jest.fn(), success: jest.fn() })),
}));

import { createHeadlessStorage } from '../../../src/ts/platforms/headless/store';

import type { AndroidHeadlessStore } from '../../../src/ts/core/types/settings';
import type { SettingsFileWiring, SettingsStoreRef } from '../../../src/ts/core/platform/port';

const g = globalThis as typeof globalThis & { AndroidHeadlessStore?: AndroidHeadlessStore };

const ref = (prefKey: string, file = `/data/${prefKey}.json`): SettingsStoreRef => ({
    prefKey,
    filePath: () => file,
    sweep: 'none',
});
const FLAGS = { strict: false, shared: false };
const WIRING: SettingsFileWiring = {
    rebase: (_base: string | null, ours: string, _theirs: string | null) => ours,
    dedicatedBridge: true,
    droppedSaves: null,
};

afterEach(() => {
    delete g.AndroidHeadlessStore;
    jest.clearAllMocks();
});

describe('the jsonStore transport', () => {
    test('readRaw reads the key through the bridge, and null when it is not there', () => {
        g.AndroidHeadlessStore = { read: () => null, write: () => true, readKey: () => '{"a":1}' };
        const store = createHeadlessStorage().jsonStore(ref('gs_store'), FLAGS);
        expect(store.readRaw()).toBe('{"a":1}');
        g.AndroidHeadlessStore = { read: () => null, write: () => true, readKey: () => null };
        expect(store.readRaw()).toBeNull();
    });

    test('writeRaw persists through the bridge and is read back', () => {
        const writeKey = jest.fn(() => true);
        g.AndroidHeadlessStore = { read: () => null, write: () => true, readKey: () => null, writeKey };
        const store = createHeadlessStorage().jsonStore(ref('gs_store'), FLAGS);
        store.writeRaw('{"a":1}');
        expect(writeKey).toHaveBeenCalledWith('gs_store', '{"a":1}');
        expect(store.readRaw()).toBe('{"a":1}');
    });

    test('a strict write the bridge did not persist throws, and the cache keeps what it had', () => {
        const writeKey = jest.fn<boolean | void, [string, string]>().mockReturnValueOnce(true).mockReturnValue(false);
        g.AndroidHeadlessStore = { read: () => null, write: () => true, readKey: () => null, writeKey };
        const store = createHeadlessStorage().jsonStore(ref('gs_store'), { strict: true, shared: false });
        store.writeRaw('{"kept":1}');
        expect(() => store.writeRaw('{"a":1}')).toThrow('Headless gs_store was not persisted');
        expect(store.readRaw()).toBe('{"kept":1}');
    });

    test('a shared key is saved by the native compare-and-write, from what was read', () => {
        const compareAndWriteKey = jest.fn((_key: string, expected: string, data: string) => {
            expect(expected).toBe('{"a":1}');
            expect(data).toBe('{"a":1}!');
            return true;
        });
        g.AndroidHeadlessStore = { read: () => null, write: () => true, readKey: () => '{"a":1}', compareAndWriteKey };
        const store = createHeadlessStorage().jsonStore(ref('gs_shared'), { ...FLAGS, shared: true });
        expect(store.updateNow((current) => `${current}!`)).toBe('saved');
        expect(compareAndWriteKey).toHaveBeenCalledWith('gs_shared', '{"a":1}', '{"a":1}!');
    });

    test('a key that is not shared is written in one step over this transport, and updateThrough resolves it', async () => {
        const writeKey = jest.fn(() => true);
        g.AndroidHeadlessStore = { read: () => null, write: () => true, readKey: () => null, writeKey };
        const store = createHeadlessStorage().jsonStore(ref('gs_store'), FLAGS);
        expect(store.updateNow(() => '{"one":1}')).toBe('saved');
        expect(writeKey).toHaveBeenCalledWith('gs_store', '{"one":1}');
        void store.readRaw();
        await expect(store.updateThrough(() => '{"two":2}')).resolves.toBe('saved');
        expect(writeKey).toHaveBeenLastCalledWith('gs_store', '{"two":2}');
    });

    test('peekStored is the bridge read, hydrate and reread are no-ops, flush resolves, discard empties the cache', async () => {
        const writeKey = jest.fn(() => true);
        const readKey = jest.fn(() => '{"stored":2}');
        g.AndroidHeadlessStore = { read: () => null, write: () => true, readKey, writeKey };
        const store = createHeadlessStorage().jsonStore(ref('gs_store'), FLAGS);
        store.writeRaw('{"a":1}');
        await expect(store.peekStored()).resolves.toBe('{"stored":2}');
        await expect(store.hydrate()).resolves.toBeUndefined();
        await expect(store.reread()).resolves.toBe(true);
        await expect(store.flush()).resolves.toBeUndefined();
        store.discard();
        // The cache is forgotten: a read that fails now answers null, not the value the discarded write held.
        readKey.mockImplementation(() => {
            throw new Error('bridge down');
        });
        expect(store.readRaw()).toBeNull();
    });
});

describe('the settingsFile transport', () => {
    test('readRaw reads through the dedicated bridge, and the write persists as a change of it', () => {
        let stored: string | null = '{"cfg":1}';
        g.AndroidHeadlessStore = {
            read: () => stored,
            write: (data: string) => {
                stored = data;
                return true;
            },
        };
        const file = createHeadlessStorage().settingsFile(ref('gurushots-config'), WIRING);
        expect(file.readRaw()).toBe('{"cfg":1}');
        expect(file.write('{"cfg":2}')).toEqual({ ok: true });
        expect(stored).toBe('{"cfg":2}');
        // The next read is a change of what it wrote.
        expect(file.readRaw()).toBe('{"cfg":2}');
    });

    test('a write the bridge refuses is a failed write, said in the log', () => {
        g.AndroidHeadlessStore = {
            read: () => '{"cfg":1}',
            write: () => false,
            lastWriteRefusal: () => 'too-large',
        };
        const file = createHeadlessStorage().settingsFile(ref('gurushots-config'), WIRING);
        expect(file.write('{"cfg":2}')).toEqual({ ok: false });
        expect(error).toHaveBeenCalledWith('Headless store refused the settings write (too-large)', null);
    });

    test('writeIfAbsent saves when nothing is stored, and answers what the other context saved', () => {
        let stored: string | null = null;
        g.AndroidHeadlessStore = {
            read: () => stored,
            write: (data: string) => {
                if (stored !== null) return false;
                stored = data;
                return true;
            },
        };
        const file = createHeadlessStorage().settingsFile(ref('gurushots-config'), WIRING);
        expect(file.writeIfAbsent('{"import":1}')).toEqual({ outcome: 'saved' });
        // The app window saved first: this context answers its text and has nothing to write.
        stored = '{"window":2}';
        expect(file.writeIfAbsent('{"import":1}')).toEqual({ outcome: 'exists', current: '{"window":2}' });
        expect(file.readRaw()).toBe('{"window":2}');
    });

    test('the location is the preference key, the file reports loaded with a bridge and persisted throughout', () => {
        g.AndroidHeadlessStore = { read: () => null, write: () => true };
        const file = createHeadlessStorage().settingsFile(ref('gurushots-config'), WIRING);
        expect(file.location()).toBe('gurushots-config');
        expect(file.isLoaded()).toBe(true);
        expect(file.isPersisted()).toBe(true);
        expect(file.hasQuarantined()).toBe(false);
    });

    test('with no bridge there is nothing to read from, and the file reads as not loaded', () => {
        const file = createHeadlessStorage().settingsFile(ref('gurushots-config'), WIRING);
        expect(file.readRaw()).toBeNull();
        expect(file.isLoaded()).toBe(false);
    });

    test('the service cannot set an unusable value aside, so it reports a failure', () => {
        const file = createHeadlessStorage().settingsFile(ref('gurushots-config'), WIRING);
        expect(file.quarantineRaw('{broken')).toEqual({
            ok: false,
            error: 'the background service cannot set an unusable settings value aside',
        });
    });

    test('hydrate and flush are no-ops, and discard does nothing', async () => {
        const file = createHeadlessStorage().settingsFile(ref('gurushots-config'), WIRING);
        await expect(file.hydrate()).resolves.toBeUndefined();
        await expect(file.flush()).resolves.toBeUndefined();
        await expect(file.discard()).resolves.toBeUndefined();
    });
});

describe('the family answers', () => {
    test('a read that failed says the store is not loaded, once it was made', () => {
        const storage = createHeadlessStorage();
        expect(storage.loaded('gs_loaded')).toBe(true);
        g.AndroidHeadlessStore = { read: () => null, write: () => true, readKey: () => null };
        storage.jsonStore(ref('gs_loaded'), FLAGS).readRaw();
        expect(storage.loaded('gs_loaded')).toBe(true);
        g.AndroidHeadlessStore = {
            read: () => null,
            write: () => true,
            readKey: () => {
                throw new Error('bridge down');
            },
        };
        storage.jsonStore(ref('gs_loaded'), FLAGS).readRaw();
        expect(storage.loaded('gs_loaded')).toBe(false);
        expect(error).toHaveBeenCalledWith('Headless gs_loaded read failed:', expect.any(Error));
    });

    test('the native compare-and-write of each key decides, so the lock policy is none', () => {
        expect(createHeadlessStorage().lockPolicy).toBe('none');
    });
});
