/**
 * Tests for the storage transport's headless-service branch. In the
 * Android background WebView there is no fs and no @capacitor/preferences,
 * so reads and writes go through a native @JavascriptInterface
 * (AndroidHeadlessStore) backed by the same store the app uses, so
 * settings (incl. the token) stay in sync between app and background.
 */

const mockPrefSet = jest.fn(() => Promise.resolve());
const mockPrefGet = jest.fn(() => Promise.resolve({ value: null }));
jest.mock(
    '@capacitor/preferences',
    () => ({ Preferences: { set: (...a) => mockPrefSet(...a), get: (...a) => mockPrefGet(...a) } }),
    { virtual: true },
);

const { storage } = require('../../src/js/settings/storage');

describe('storage — headless service branch', () => {
    let store;

    beforeEach(() => {
        globalThis.__GS_HEADLESS__ = true;
        store = {
            value: null,
            read: jest.fn(() => store.value),
            write: jest.fn((d) => {
                store.value = d;
            }),
        };
        globalThis.AndroidHeadlessStore = store;
    });

    afterEach(() => {
        delete globalThis.__GS_HEADLESS__;
        delete globalThis.AndroidHeadlessStore;
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
});

describe('storage — capacitor write-behind', () => {
    let capStorage;
    let flushPendingWrites;

    beforeEach(() => {
        jest.resetModules();
        mockPrefSet.mockReset();
        mockPrefSet.mockResolvedValue(undefined);
        mockPrefGet.mockReset();
        mockPrefGet.mockResolvedValue({ value: null });
        // isCapacitor() keys off globalThis.Capacitor.isNativePlatform.
        globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
        const mod = require('../../src/js/settings/storage');
        capStorage = mod.storage;
        flushPendingWrites = mod.flushPendingWrites;
    });

    afterEach(() => {
        delete globalThis.Capacitor;
    });

    test('the in-memory cache reflects the latest write synchronously', () => {
        capStorage.writeRaw('{"x":1}');
        expect(capStorage.readRaw()).toBe('{"x":1}');
    });

    test('writes are serialized in issue order — a later write never overtakes an earlier one', async () => {
        const persisted = [];
        let releaseFirst;
        const firstGate = new Promise((resolve) => {
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

        releaseFirst();
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
