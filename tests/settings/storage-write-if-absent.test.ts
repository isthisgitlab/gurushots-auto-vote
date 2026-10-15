/**
 * The write of an import (`writeIfAbsent`) and the keyed access to the 1.x settings blob, on the Android side: in the
 * background service (the native store's compare-and-write decides which context saved first) and in the app window
 * (the cache shows the import at once; the write-behind finds what the other context saved).
 */

// No test here may touch the real user-data folder: the path is a made-up one that does not exist.
jest.mock('../../src/ts/runtime', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/runtime')>('../../src/ts/runtime'),
    getAppUserDataPath: () => '/nonexistent/gurushots-auto-vote-test-user-data',
}));
jest.mock('../../src/ts/logger', () => {
    const cat = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        withCategory: jest.fn(() => cat),
        __cat: cat,
    };
});
const mockPreferences = {
    set: jest.fn<Promise<void>, [{ key: string; value: string }]>(() => Promise.resolve()),
    get: jest.fn<Promise<{ value: string | null }>, [{ key: string }]>(() => Promise.resolve({ value: null })),
    remove: jest.fn<Promise<void>, [{ key: string }]>(() => Promise.resolve()),
    keys: jest.fn<Promise<{ keys: string[] }>, []>(() => Promise.resolve({ keys: [] })),
};
jest.mock('@capacitor/preferences', () => ({ Preferences: mockPreferences }), { virtual: true });

import type * as storageModule from '../../src/ts/settings/storage';
import type * as jsonStoreModule from '../../src/ts/settings/jsonStore';
import loggerModule = require('../../src/ts/logger');
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import { invalid } from '../helpers/invalid';

const g = globalThis as typeof globalThis & {
    Capacitor?: { isNativePlatform: () => boolean; Plugins?: Record<string, unknown> };
};
const cat = invalid<{ __cat: { error: jest.Mock<void, [string, ...unknown[]]> } }>(loggerModule).__cat;

const loadStorage = () => {
    let mod: typeof storageModule | undefined;
    jest.isolateModules(() => {
        mod = require('../../src/ts/settings/storage') as typeof storageModule;
    });
    return mod!;
};

afterEach(() => {
    delete g.Capacitor;
    removeHeadlessStore();
    jest.clearAllMocks();
});

describe('writeIfAbsent in the Android background service', () => {
    test('saves when the native store holds nothing', () => {
        const store = installHeadlessStore();
        const { storage } = loadStorage();
        storage.readRaw();

        expect(storage.writeIfAbsent('{"v":1}')).toEqual({ outcome: 'saved' });
        expect(store.value).toBe('{"v":1}');
    });

    test('with no bridge there is nothing to refuse it', () => {
        (globalThis as { __GS_HEADLESS__?: boolean }).__GS_HEADLESS__ = true;
        const { storage } = loadStorage();

        expect(storage.writeIfAbsent('{"v":1}')).toEqual({ outcome: 'saved' });
    });

    test('loses to the app window that saved first, and answers what it saved', () => {
        const store = installHeadlessStore();
        const { storage } = loadStorage();
        storage.readRaw();
        store.value = '{"v":"window"}'; // the window's import lands after this context last read

        expect(storage.writeIfAbsent('{"v":"service"}')).toEqual({ outcome: 'exists', current: '{"v":"window"}' });
        expect(store.value).toBe('{"v":"window"}');
        // The next save builds on what the window saved.
        expect(storage.readRaw()).toBe('{"v":"window"}');
    });

    test('a refusal with nothing stored is a failure, said in the log', () => {
        const store = installHeadlessStore();
        store.write.mockReturnValue(false);
        const { storage } = loadStorage();

        expect(storage.writeIfAbsent('{"v":1}')).toEqual({ outcome: 'failed' });
        expect(cat.error).toHaveBeenCalledWith('Headless store refused the settings write (refused)', null);
    });

    test('a bridge that throws is a failure, said in the log', () => {
        const store = installHeadlessStore();
        store.write.mockImplementation(() => {
            throw new Error('commit failed');
        });
        const { storage } = loadStorage();

        expect(storage.writeIfAbsent('{"v":1}')).toEqual({ outcome: 'failed' });
        expect(cat.error).toHaveBeenCalledWith('Headless store write failed:', expect.any(Error));
    });
});

describe('writeIfAbsent in the Android app window', () => {
    beforeEach(() => {
        g.Capacitor = { isNativePlatform: () => true };
    });

    test('shows the import at once and saves it when Preferences holds nothing', async () => {
        const { storage, initializeAsync, flushPendingWrites } = loadStorage();
        await initializeAsync();

        const written = storage.writeIfAbsent('{"v":1}');
        expect(written).toEqual({ outcome: 'saved', landed: expect.any(Promise) });
        expect(storage.readRaw()).toBe('{"v":1}');
        await flushPendingWrites();
        await expect(written.outcome === 'saved' ? written.landed : undefined).resolves.toBe('written');

        expect(mockPreferences.set).toHaveBeenCalledWith({ key: 'gurushots-config', value: '{"v":1}' });
    });

    test('does not write over what the service saved first, and shows what it saved', async () => {
        let native: string | null = '{"v":"service"}';
        const compareAndWrite = jest.fn(
            async ({ expected }: { key: string; expected: string | null; value: string }) =>
                (native ?? '') === (expected ?? '')
                    ? { saved: true, current: null }
                    : { saved: false, current: native },
        );
        g.Capacitor = { isNativePlatform: () => true, Plugins: { AutoVoteBackground: { compareAndWrite } } };
        mockPreferences.get.mockImplementation(({ key }) =>
            Promise.resolve({ value: key === 'gurushots-config' ? native : null }),
        );
        const { storage, flushPendingWrites } = loadStorage();

        const written = storage.writeIfAbsent('{"v":"window"}');
        await flushPendingWrites();
        // The window's text was shown at once; the compare-and-write found the service's and the cache took that.
        await expect(written.outcome === 'saved' ? written.landed : undefined).resolves.toBe('declined');

        expect(mockPreferences.set).not.toHaveBeenCalledWith({ key: 'gurushots-config', value: '{"v":"window"}' });
        expect(storage.readRaw()).toBe('{"v":"service"}');
        native = null;
    });
});

describe('the 1.x settings blob in the Android background service (keyed access)', () => {
    test('is read and written key by key, a write saving only while the key holds what the last read answered', () => {
        const store = installHeadlessStore({ legacy: '{"theme":"dark"}' });
        const { legacyStorage } = loadStorage();

        expect(legacyStorage.readRaw()).toBe('{"theme":"dark"}');
        expect(legacyStorage.writeRaw('{"theme":"light"}')).toBe(true);
        expect(store.legacy).toBe('{"theme":"light"}');
    });

    test('a blob the other writer changed since the read is read again and the change made on it', () => {
        const store = installHeadlessStore({ legacy: '{"theme":"dark","language":"en"}' });
        const { legacyStorage } = loadStorage();
        legacyStorage.readRaw();
        store.legacy = '{"theme":"dark","language":"lv"}';

        expect(legacyStorage.writeRaw('{"theme":"light","language":"en"}')).toBe(true);
        expect(JSON.parse(store.legacy ?? 'null')).toEqual({ theme: 'light', language: 'lv' });
    });

    test('a write the store keeps declining is a failed write, said in the log', () => {
        const store = installHeadlessStore({ legacy: '{"theme":"dark"}' });
        const { legacyStorage } = loadStorage();
        legacyStorage.readRaw();
        store.compareAndWriteKey = () => false;

        expect(legacyStorage.writeRaw('{"theme":"light"}')).toBe(false);
        expect(cat.error).toHaveBeenCalledWith('Headless store refused the settings write', null);
    });

    test('a blob that was not there when read is written as a change of nothing', () => {
        const store = installHeadlessStore();
        const { legacyStorage } = loadStorage();
        expect(legacyStorage.readRaw()).toBeNull();

        expect(legacyStorage.writeRaw('{"a":1}')).toBe(true);
        expect(store.legacy).toBe('{"a":1}');
    });

    test('a bridge without keyed calls cannot be read through', () => {
        const store = installHeadlessStore();
        delete store.readKey;
        delete store.compareAndWriteKey;
        const { legacyStorage } = loadStorage();

        expect(() => legacyStorage.readRaw()).toThrow('no bridge to read the settings through');
    });
});

describe('a Preferences write that fails in the Android app window', () => {
    beforeEach(() => {
        g.Capacitor = { isNativePlatform: () => true };
    });

    test('shows the text of the latest write, whether or not an earlier queued one failed', async () => {
        mockPreferences.set.mockRejectedValueOnce(new Error('disk full'));
        const { storage, flushPendingWrites } = loadStorage();

        storage.writeRaw('{"n":1}');
        storage.writeRaw('{"n":2}');
        await flushPendingWrites();

        expect(cat.error).toHaveBeenCalledWith('Capacitor preferences write failed:', expect.any(Error));
        expect(JSON.parse(storage.readRaw() ?? 'null')).toEqual({ n: 2 });
    });
});

describe('an import the Android app window could not store', () => {
    beforeEach(() => {
        g.Capacitor = { isNativePlatform: () => true };
    });

    test('says it failed, and the cache shows what is stored (nothing) again', async () => {
        mockPreferences.set.mockRejectedValueOnce(new Error('disk full'));
        const { storage, flushPendingWrites } = loadStorage();

        const written = storage.writeIfAbsent('{"v":1}');
        expect(storage.readRaw()).toBe('{"v":1}');
        await flushPendingWrites();

        await expect(written.outcome === 'saved' ? written.landed : undefined).resolves.toBe('failed');
        expect(storage.readRaw()).toBeNull();
    });

    test('says it failed when the native store refuses a blob past its size', async () => {
        const tooLarge = Object.assign(new Error('too large'), { code: 'too-large' });
        g.Capacitor = {
            isNativePlatform: () => true,
            Plugins: { AutoVoteBackground: { compareAndWrite: jest.fn(() => Promise.reject(tooLarge)) } },
        };
        const { storage } = loadStorage();

        const written = storage.writeIfAbsent('{"v":1}');

        await expect(written.outcome === 'saved' ? written.landed : undefined).resolves.toBe('failed');
        expect(storage.readRaw()).toBeNull();
    });

    test('says it failed when the stores were discarded before the write was due (a wipe)', async () => {
        const { storage, discardPendingWrites } = loadStorage();

        const written = storage.writeIfAbsent('{"v":1}');
        await discardPendingWrites();

        await expect(written.outcome === 'saved' ? written.landed : undefined).resolves.toBe('failed');
        expect(mockPreferences.set).not.toHaveBeenCalledWith({ key: 'gurushots-config', value: '{"v":1}' });
    });
});

describe('a Preferences write of the 1.x settings blob that fails', () => {
    test('is logged and not reported to the window, which only watches the configuration', async () => {
        g.Capacitor = { isNativePlatform: () => true };
        mockPreferences.set.mockRejectedValueOnce(new Error('disk full'));
        const { legacyStorage, flushPendingWrites } = loadStorage();

        legacyStorage.writeRaw('{"a":1}');
        await flushPendingWrites();

        expect(cat.error).toHaveBeenCalledWith('Capacitor preferences write failed:', expect.any(Error));
    });
});

describe('writes the storage refuses (a wipe in progress)', () => {
    test('an import is not written either', () => {
        let storage: typeof storageModule.storage | undefined;
        let jsonStore: typeof jsonStoreModule | undefined;
        jest.isolateModules(() => {
            ({ storage } = require('../../src/ts/settings/storage') as typeof storageModule);
            jsonStore = require('../../src/ts/settings/jsonStore') as typeof jsonStoreModule;
        });
        const { refuseWrites, resumeWrites } = jsonStore!;

        refuseWrites();
        try {
            expect(storage!.writeIfAbsent('{"v":1}')).toEqual({ outcome: 'failed' });
        } finally {
            resumeWrites();
        }
    });
});
