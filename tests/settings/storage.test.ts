/**
 * Tests for the storage transport's headless-service branch. In the
 * Android background WebView there is no fs and no @capacitor/preferences,
 * so reads and writes go through a native @JavascriptInterface
 * (AndroidHeadlessStore) backed by the same store the app uses, so
 * settings (incl. the token) stay in sync between app and background.
 */

import type * as storageModule from '../../src/js/settings/storage';
import type { GetOptions, GetResult, SetOptions } from '@capacitor/preferences';
import type { AndroidHeadlessStore } from '../../src/js/types/settings';

const g = globalThis as typeof globalThis & {
    Capacitor?: { isNativePlatform: () => boolean; getPlatform: () => string };
    __GS_HEADLESS__?: boolean;
    AndroidHeadlessStore?: AndroidHeadlessStore;
};

/** In-memory stand-in for the native headless bridge. */
type HeadlessStoreDouble = {
    value: string | null;
    read: jest.Mock<string | null, []>;
    write: jest.Mock<void, [string]>;
    readKey?: jest.Mock<string | null, [string]>;
    writeKey?: jest.Mock<void, [string, string]>;
};

const mockPrefSet = jest.fn<Promise<void>, [SetOptions]>(() => Promise.resolve());
const mockPrefGet = jest.fn<Promise<GetResult>, [GetOptions]>(() => Promise.resolve({ value: null }));
jest.mock(
    '@capacitor/preferences',
    () => ({
        Preferences: {
            set: (...a: Parameters<typeof mockPrefSet>) => mockPrefSet(...a),
            get: (...a: Parameters<typeof mockPrefGet>) => mockPrefGet(...a),
        },
    }),
    { virtual: true },
);

const { storage, createJsonStore } = require('../../src/js/settings/storage') as typeof storageModule;

describe('storage — headless service branch', () => {
    let store: HeadlessStoreDouble;

    beforeEach(() => {
        g.__GS_HEADLESS__ = true;
        store = {
            value: null,
            read: jest.fn(() => store.value),
            write: jest.fn((d) => {
                store.value = d;
            }),
        };
        g.AndroidHeadlessStore = store;
    });

    afterEach(() => {
        delete g.__GS_HEADLESS__;
        delete g.AndroidHeadlessStore;
    });

    test('readRaw returns the value from the native store', () => {
        store.value = '{"token":"abc"}';
        expect(storage.readRaw()).toBe('{"token":"abc"}');
    });

    test('readRaw returns null when the native store is empty', () => {
        expect(storage.readRaw()).toBeNull();
    });

    test('writeRaw persists through the native store and a later read sees it', () => {
        storage.writeRaw('{"token":"xyz"}');
        expect(store.write).toHaveBeenCalledWith('{"token":"xyz"}');
        expect(storage.readRaw()).toBe('{"token":"xyz"}');
    });

    test('writeRaw swallows a native store failure instead of propagating', () => {
        store.write.mockImplementation(() => {
            throw new Error('SharedPreferences unavailable');
        });
        // Must not throw — settings persistence is on a synchronous path.
        expect(() => storage.writeRaw('{"token":"x"}')).not.toThrow();
    });

    test('diagnostics JSON uses the keyed native preference bridge', () => {
        const preferences = new Map<string, string>();
        store.readKey = jest.fn<string | null, [string]>((key) => preferences.get(key) ?? null);
        store.writeKey = jest.fn<void, [string, string]>((key, value) => preferences.set(key, value));
        const diagnostics = createJsonStore({
            fileName: 'lexicon-diagnostics.json',
            prefKey: 'gs_lexicon_diagnostics',
        });
        diagnostics.writeRaw('{"challenges":1}');
        expect(store.writeKey).toHaveBeenCalledWith('gs_lexicon_diagnostics', '{"challenges":1}');
        expect(diagnostics.readRaw()).toBe('{"challenges":1}');
    });

    test('keyed native failures fall back to the in-memory diagnostics value', () => {
        store.readKey = jest.fn<string | null, [string]>(() => {
            throw new Error('read unavailable');
        });
        store.writeKey = jest.fn<void, [string, string]>(() => {
            throw new Error('write unavailable');
        });
        const diagnostics = createJsonStore({
            fileName: 'lexicon-diagnostics.json',
            prefKey: 'gs_lexicon_diagnostics',
        });

        expect(() => diagnostics.writeRaw('{"challenges":2}')).not.toThrow();
        expect(diagnostics.readRaw()).toBe('{"challenges":2}');
    });
});

describe('storage — capacitor write-behind', () => {
    let capStorage: typeof storageModule.storage;
    let flushPendingWrites: typeof storageModule.flushPendingWrites;

    beforeEach(() => {
        jest.resetModules();
        mockPrefSet.mockReset();
        mockPrefSet.mockResolvedValue(undefined);
        mockPrefGet.mockReset();
        mockPrefGet.mockResolvedValue({ value: null });
        // isCapacitor() keys off globalThis.Capacitor.isNativePlatform.
        g.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
        const mod = require('../../src/js/settings/storage') as typeof storageModule;
        capStorage = mod.storage;
        flushPendingWrites = mod.flushPendingWrites;
    });

    afterEach(() => {
        delete g.Capacitor;
    });

    test('the in-memory cache reflects the latest write synchronously', () => {
        capStorage.writeRaw('{"x":1}');
        expect(capStorage.readRaw()).toBe('{"x":1}');
    });

    test('writes are serialized in issue order — a later write never overtakes an earlier one', async () => {
        const persisted: string[] = [];
        let releaseFirst: (() => void) | undefined;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        // First Preferences.set hangs until released; the second must wait.
        mockPrefSet.mockImplementationOnce((arg) => {
            persisted.push(arg.value);
            return firstGate;
        });
        mockPrefSet.mockImplementation((arg) => {
            persisted.push(arg.value);
            return Promise.resolve();
        });

        capStorage.writeRaw('A');
        capStorage.writeRaw('B');

        // The second write is chained behind the first, which is still pending.
        await Promise.resolve();
        expect(persisted).toEqual(['A']);

        releaseFirst!();
        await flushPendingWrites();
        expect(persisted).toEqual(['A', 'B']);
    });

    test('flushPendingWrites resolves after the last write completes', async () => {
        capStorage.writeRaw('A');
        capStorage.writeRaw('B');

        await expect(flushPendingWrites()).resolves.toBeUndefined();
        expect(mockPrefSet).toHaveBeenLastCalledWith({ key: 'gurushots-settings', value: 'B' });
    });

    test('a failed write is swallowed and does not break the chain for the next write', async () => {
        mockPrefSet.mockRejectedValueOnce(new Error('quota exceeded'));
        capStorage.writeRaw('A');
        capStorage.writeRaw('B');

        await expect(flushPendingWrites()).resolves.toBeUndefined();
        expect(mockPrefSet).toHaveBeenLastCalledWith({ key: 'gurushots-settings', value: 'B' });
    });
});
