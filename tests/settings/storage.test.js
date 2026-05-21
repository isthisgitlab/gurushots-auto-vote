/**
 * Tests for the storage transport's headless-service branch. In the
 * Android background WebView there is no fs and no @capacitor/preferences,
 * so reads and writes go through a native @JavascriptInterface
 * (AndroidHeadlessStore) backed by the same store the app uses, so
 * settings (incl. the token) stay in sync between app and background.
 */

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
