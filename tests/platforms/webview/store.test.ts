/**
 * The webview family's storage member: the @capacitor/preferences transport
 * its `jsonStore` and `settingsFile` builders give one store each, with the
 * hydrate-once cache, the ordered write-behind, and the shell's
 * compare-and-write part for shared keys. The write-behind's ordering
 * discipline itself is covered through the store factories
 * (tests/settings/createJsonStore.test.ts); these cover the family's own
 * operation surface.
 */

const error = jest.fn();

jest.mock('../../../src/ts/core/logger', () => ({
    __esModule: true,
    withCategory: jest.fn(() => ({ error, info: jest.fn(), warning: jest.fn(), debug: jest.fn(), success: jest.fn() })),
}));

const mockPrefSet = jest.fn<Promise<void>, [{ key: string; value: string }]>(() => Promise.resolve());
const mockPrefGet = jest.fn<Promise<{ value: string | null }>, [{ key: string }]>(() =>
    Promise.resolve({ value: null }),
);
const mockPrefRemove = jest.fn<Promise<void>, [{ key: string }]>(() => Promise.resolve());
const mockPrefKeys = jest.fn<Promise<{ keys: string[] }>, []>(() => Promise.resolve({ keys: [] }));
jest.mock(
    '@capacitor/preferences',
    () => ({
        Preferences: {
            set: (...a: Parameters<typeof mockPrefSet>) => mockPrefSet(...a),
            get: (...a: Parameters<typeof mockPrefGet>) => mockPrefGet(...a),
            remove: (...a: Parameters<typeof mockPrefRemove>) => mockPrefRemove(...a),
            keys: () => mockPrefKeys(),
        },
    }),
    { virtual: true },
);

import { createWebviewStorage } from '../../../src/ts/platforms/webview/store';

import type { CasAnswer } from '../../../src/ts/core/types/stores';
import type { SettingsStoreRef, SettingsFileWiring } from '../../../src/ts/core/platform/port';

const ref = (prefKey: string, file = `/data/${prefKey}.json`): SettingsStoreRef => ({
    prefKey,
    filePath: () => file,
    sweep: 'none',
});
const FLAGS = { strict: false, shared: false };
const WIRING: SettingsFileWiring = {
    rebase: (_base: string | null, ours: string, _theirs: string | null) => ours,
    dedicatedBridge: false,
    droppedSaves: null,
};

afterEach(() => {
    jest.clearAllMocks();
    mockPrefGet.mockResolvedValue({ value: null });
    mockPrefSet.mockResolvedValue();
    mockPrefKeys.mockResolvedValue({ keys: [] });
});

describe('the jsonStore transport', () => {
    test('hydrate fills the cache from Preferences once; a second call does not read again', async () => {
        mockPrefGet.mockResolvedValue({ value: '{"persisted":true}' });
        const store = createWebviewStorage(null).jsonStore(ref('gs_store'), FLAGS);
        await store.hydrate();
        expect(mockPrefGet).toHaveBeenCalledWith({ key: 'gs_store' });
        expect(store.readRaw()).toBe('{"persisted":true}');
        await store.hydrate();
        expect(mockPrefGet).toHaveBeenCalledTimes(1);
    });

    test('a failed hydrate leaves the cache empty but initialized, and says so in the log', async () => {
        mockPrefGet.mockRejectedValueOnce(new Error('bridge down'));
        const store = createWebviewStorage(null).jsonStore(ref('gs_store'), FLAGS);
        await store.hydrate();
        expect(store.readRaw()).toBeNull();
        expect(error).toHaveBeenCalledWith('Capacitor gs_store read failed:', expect.any(Error));
    });

    test('writeRaw shows in the cache at once and write-behinds to Preferences', async () => {
        const store = createWebviewStorage(null).jsonStore(ref('gs_store'), FLAGS);
        store.writeRaw('{"x":1}');
        expect(store.readRaw()).toBe('{"x":1}');
        await store.flush();
        expect(mockPrefSet).toHaveBeenCalledWith({ key: 'gs_store', value: '{"x":1}' });
    });

    test('updateNow is null — the window writes are queued-only; updateThrough saves behind the queue', async () => {
        const store = createWebviewStorage(null).jsonStore(ref('gs_store'), FLAGS);
        expect(store.updateNow(() => '{"x":1}')).toBeNull();
        expect(mockPrefSet).not.toHaveBeenCalled();
        await expect(store.updateThrough(() => '{"x":1}')).resolves.toBe('saved');
        expect(mockPrefSet).toHaveBeenCalledWith({ key: 'gs_store', value: '{"x":1}' });
        expect(store.readRaw()).toBe('{"x":1}');
    });

    test('a shared key is saved through the compare-and-write the shell passes', async () => {
        const compareAndWrite = jest.fn<Promise<CasAnswer> | null, [string, string | null, string]>(
            (_key, expected, data) => Promise.resolve({ saved: true, current: data }),
        );
        const store = createWebviewStorage(compareAndWrite).jsonStore(ref('gs_shared'), {
            ...FLAGS,
            shared: true,
        });
        await expect(store.updateThrough(() => '{"a":1}')).resolves.toBe('saved');
        expect(compareAndWrite).toHaveBeenCalledWith('gs_shared', null, '{"a":1}');
        expect(mockPrefSet).not.toHaveBeenCalled();
        // A key that is not shared saves straight to Preferences.
        const plain = createWebviewStorage(compareAndWrite).jsonStore(ref('gs_plain'), FLAGS);
        await expect(plain.updateThrough(() => '{"a":1}')).resolves.toBe('saved');
        expect(mockPrefSet).toHaveBeenCalledWith({ key: 'gs_plain', value: '{"a":1}' });
    });

    test('reread drains the queue first and then reads what is stored; a failed read answers false', async () => {
        const store = createWebviewStorage(null).jsonStore(ref('gs_store'), FLAGS);
        store.writeRaw('{"mine":1}');
        mockPrefGet.mockResolvedValueOnce({ value: '{"stored":2}' });
        await expect(store.reread()).resolves.toBe(true);
        expect(mockPrefSet).toHaveBeenCalledWith({ key: 'gs_store', value: '{"mine":1}' });
        expect(store.readRaw()).toBe('{"stored":2}');
        mockPrefGet.mockRejectedValueOnce(new Error('bridge down'));
        await expect(store.reread()).resolves.toBe(false);
        expect(store.readRaw()).toBe('{"stored":2}');
    });

    test('peekStored reads what Preferences holds, the cache left as it is', async () => {
        const store = createWebviewStorage(null).jsonStore(ref('gs_store'), FLAGS);
        store.writeRaw('{"mine":1}');
        mockPrefGet.mockResolvedValueOnce({ value: '{"stored":2}' });
        await expect(store.peekStored()).resolves.toBe('{"stored":2}');
        expect(store.readRaw()).toBe('{"mine":1}');
    });

    test('the strict store flush rejects when the latest write did not persist', async () => {
        const store = createWebviewStorage(null).jsonStore(ref('gs_store'), { strict: true, shared: false });
        mockPrefSet.mockRejectedValueOnce(new Error('disk full'));
        store.writeRaw('{"x":1}');
        await expect(store.flush()).rejects.toThrow('gs_store was not persisted');
        // The cache keeps the value: it is the record of something done.
        expect(store.readRaw()).toBe('{"x":1}');
    });

    test('discard gives up the queued write, empties the cache, and the key is no longer known', async () => {
        const storage = createWebviewStorage(null);
        const store = storage.jsonStore(ref('gs_store'), FLAGS);
        expect(storage.loaded('gs_store')).toBe(false);
        store.writeRaw('{"x":1}');
        expect(storage.loaded('gs_store')).toBe(true);
        store.discard();
        expect(store.readRaw()).toBeNull();
        expect(storage.loaded('gs_store')).toBe(false);
        await store.flush();
        expect(mockPrefSet).not.toHaveBeenCalled();
    });
});

describe('the settingsFile transport', () => {
    test('write stages the cache and queues the save; writeIfAbsent stages the import', async () => {
        const file = createWebviewStorage(null).settingsFile(ref('gurushots-config'), WIRING);
        const write = file.write('{"a":1}');
        expect(write.ok).toBe(true);
        expect(file.readRaw()).toBe('{"a":1}');
        await write.landed;
        expect(mockPrefSet).toHaveBeenCalledWith({ key: 'gurushots-config', value: '{"a":1}' });
        const import_ = file.writeIfAbsent('{"b":2}');
        expect(import_.outcome).toBe('saved');
        if (import_.outcome !== 'saved') throw new Error('the import did not save');
        await import_.landed;
        // The import's write declines on a stored value: what is stored stays.
        expect(mockPrefSet).toHaveBeenLastCalledWith({ key: 'gurushots-config', value: '{"a":1}' });
    });

    test('the queued write saves through the compare-and-write the shell passes', async () => {
        const compareAndWrite = jest.fn<Promise<CasAnswer> | null, [string, string | null, string]>(
            (_key, expected, data) => Promise.resolve({ saved: true, current: data }),
        );
        const file = createWebviewStorage(compareAndWrite).settingsFile(ref('gurushots-config'), WIRING);
        const write = file.write('{"a":1}');
        await write.landed;
        expect(compareAndWrite).toHaveBeenCalledWith('gurushots-config', null, '{"a":1}');
        expect(mockPrefSet).not.toHaveBeenCalled();
        expect(file.readRaw()).toBe('{"a":1}');
    });

    test('a compare-and-write that keeps refusing fails the queued write and puts the cache back to what is stored', async () => {
        error.mockClear();
        const compareAndWrite = jest.fn<Promise<CasAnswer> | null, [string, string | null, string]>(() =>
            Promise.resolve({ saved: false, current: null }),
        );
        const file = createWebviewStorage(compareAndWrite).settingsFile(ref('gurushots-config'), WIRING);
        const write = file.write('{"a":1}');
        await expect(write.landed).resolves.toBe('failed');
        expect(file.readRaw()).toBeNull();
        expect(file.isPersisted()).toBe(true);
        expect(error).toHaveBeenCalledWith('Capacitor preferences write failed:', expect.anything());
        expect(mockPrefSet).not.toHaveBeenCalled();
    });

    test('the location is the preference key', () => {
        expect(createWebviewStorage(null).settingsFile(ref('gurushots-config'), WIRING).location()).toBe(
            'gurushots-config',
        );
    });

    test('isLoaded is false until hydration filled the cache, and isPersisted follows the queue', async () => {
        const file = createWebviewStorage(null).settingsFile(ref('gurushots-config'), WIRING);
        expect(file.isLoaded()).toBe(false);
        mockPrefGet.mockResolvedValue({ value: '{"stored":1}' });
        await file.hydrate();
        expect(file.isLoaded()).toBe(true);
        expect(file.readRaw()).toBe('{"stored":1}');
        file.write('{"mine":2}');
        expect(file.isPersisted()).toBe(false);
        await file.flush();
        expect(file.isPersisted()).toBe(true);
    });

    test('a stored value found under a backup key at hydration is reported by hasQuarantined', async () => {
        mockPrefKeys.mockResolvedValue({ keys: ['gurushots-config_corrupt-2026-01-01T00-00-00-000Z'] });
        const file = createWebviewStorage(null).settingsFile(ref('gurushots-config'), WIRING);
        expect(file.hasQuarantined()).toBe(false);
        await file.hydrate();
        expect(file.hasQuarantined()).toBe(true);
    });

    test('quarantineRaw copies the value to a backup key of its own, removes it, and empties the cache', async () => {
        mockPrefGet.mockResolvedValue({ value: '{broken' });
        const file = createWebviewStorage(null).settingsFile(ref('gurushots-config'), WIRING);
        await file.hydrate();
        const result = file.quarantineRaw('{broken');
        expect(result).toEqual({
            ok: true,
            path: expect.stringMatching(/^gurushots-config_corrupt-\d{4}/),
            moved: expect.any(Promise),
        });
        if (!result.ok) throw new Error('the move was refused');
        await expect(result.moved).resolves.toBe(true);
        expect(file.readRaw()).toBeNull();
        expect(mockPrefSet).toHaveBeenCalledWith({ key: result.path, value: '{broken' });
        expect(mockPrefRemove).toHaveBeenCalledWith({ key: 'gurushots-config' });
        expect(mockPrefSet.mock.invocationCallOrder[0]).toBeLessThan(mockPrefRemove.mock.invocationCallOrder[0]);
    });

    test('a failed move logs, puts the cache back to what is stored, and answers false', async () => {
        mockPrefGet.mockResolvedValue({ value: '{broken' });
        mockPrefSet.mockRejectedValueOnce(new Error('disk full'));
        const file = createWebviewStorage(null).settingsFile(ref('gurushots-config'), WIRING);
        await file.hydrate();
        const result = file.quarantineRaw('{broken');
        if (!result.ok) throw new Error('the move was refused');
        await expect(result.moved).resolves.toBe(false);
        expect(file.readRaw()).toBe('{broken');
        expect(file.hasQuarantined()).toBe(false);
        expect(error).toHaveBeenCalledWith('Capacitor preferences backup write failed:', expect.any(Error));
        expect(mockPrefRemove).not.toHaveBeenCalled();
    });

    test('flush waits for the queue, and discard gives every queued write up', async () => {
        const file = createWebviewStorage(null).settingsFile(ref('gurushots-config'), WIRING);
        await expect(file.flush()).resolves.toBeUndefined();
        file.write('{"a":1}');
        await file.discard();
        expect(file.readRaw()).toBeNull();
        expect(mockPrefSet).not.toHaveBeenCalled();
    });
});

describe('the family answers', () => {
    test('the native compare-and-write of each key decides, so the lock policy is none', () => {
        expect(createWebviewStorage(null).lockPolicy).toBe('none');
    });
});
