/**
 * createJsonStore — the generic platform-aware JSON store metadata.js rides
 * (same transport pattern as the settings store): fs on Electron/CLI,
 * hydrate-once cache + ordered write-behind on Capacitor, memory-only on the
 * Android headless service.
 */

const mockPrefSet = jest.fn(() => Promise.resolve());
const mockPrefGet = jest.fn(() => Promise.resolve({ value: null }));
jest.mock(
    '@capacitor/preferences',
    () => ({ Preferences: { set: (...a) => mockPrefSet(...a), get: (...a) => mockPrefGet(...a) } }),
    { virtual: true },
);

const fs = require('node:fs');

describe('createJsonStore', () => {
    // No jest.resetModules(): createJsonStore reads the runtime flags at
    // call time, so fresh store instances per test are enough — and a
    // registry reset would detach the file-top `fs` reference from the
    // instance the store binds to.
    afterEach(() => {
        delete globalThis.Capacitor;
        delete globalThis.__GS_HEADLESS__;
        jest.clearAllMocks();
    });

    describe('fs transport (Electron/CLI)', () => {
        let store;

        beforeEach(() => {
            const { createJsonStore } = require('../../src/js/settings/storage');
            store = createJsonStore({ fileName: 'metadata.json', prefKey: 'gurushots-metadata' });
        });

        test('readRaw returns null when the file does not exist', () => {
            fs.existsSync.mockReturnValue(false);
            expect(store.readRaw()).toBeNull();
        });

        test('readRaw returns the file contents', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue('{"a":1}');
            expect(store.readRaw()).toBe('{"a":1}');
        });

        test('writeRaw writes with owner-only mode', () => {
            fs.existsSync.mockReturnValue(true);
            store.writeRaw('{"a":2}');
            expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('metadata.json'), '{"a":2}', {
                encoding: 'utf8',
                mode: 0o600,
            });
        });

        test('the file lives next to settings.json under the userData dir', () => {
            expect(store.getFilePath().endsWith('metadata.json')).toBe(true);
        });
    });

    describe('capacitor transport', () => {
        let store;

        beforeEach(() => {
            globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
            mockPrefGet.mockResolvedValue({ value: '{"persisted":true}' });
            const { createJsonStore } = require('../../src/js/settings/storage');
            store = createJsonStore({ fileName: 'metadata.json', prefKey: 'gurushots-metadata' });
        });

        test('initializeAsync hydrates the cache from Preferences under its own key', async () => {
            await store.initializeAsync();
            expect(mockPrefGet).toHaveBeenCalledWith({ key: 'gurushots-metadata' });
            expect(store.readRaw()).toBe('{"persisted":true}');
        });

        test('writeRaw updates the cache synchronously and write-behinds to Preferences', async () => {
            store.writeRaw('{"x":1}');
            expect(store.readRaw()).toBe('{"x":1}');
            await store.flushPendingWrites();
            expect(mockPrefSet).toHaveBeenCalledWith({ key: 'gurushots-metadata', value: '{"x":1}' });
        });

        test('writes are serialized in issue order', async () => {
            const persisted = [];
            let releaseFirst;
            const firstGate = new Promise((resolve) => {
                releaseFirst = resolve;
            });
            mockPrefSet.mockImplementationOnce((arg) => {
                persisted.push(arg.value);
                return firstGate;
            });
            mockPrefSet.mockImplementation((arg) => {
                persisted.push(arg.value);
                return Promise.resolve();
            });

            store.writeRaw('A');
            store.writeRaw('B');
            await Promise.resolve();
            expect(persisted).toEqual(['A']);

            releaseFirst();
            await store.flushPendingWrites();
            expect(persisted).toEqual(['A', 'B']);
        });

        test('a failed Preferences write is absorbed and the cache keeps the latest value', async () => {
            mockPrefSet.mockRejectedValueOnce(new Error('quota'));
            store.writeRaw('{"y":2}');
            await expect(store.flushPendingWrites()).resolves.toBeUndefined();
            expect(store.readRaw()).toBe('{"y":2}');
        });
    });

    describe('headless service (memory-only)', () => {
        let store;

        beforeEach(() => {
            globalThis.__GS_HEADLESS__ = true;
            const { createJsonStore } = require('../../src/js/settings/storage');
            store = createJsonStore({ fileName: 'metadata.json', prefKey: 'gurushots-metadata' });
        });

        test('round-trips in memory without touching fs or Preferences', async () => {
            expect(store.readRaw()).toBeNull();
            store.writeRaw('{"m":1}');
            expect(store.readRaw()).toBe('{"m":1}');
            await store.initializeAsync();
            expect(mockPrefGet).not.toHaveBeenCalled();
            expect(mockPrefSet).not.toHaveBeenCalled();
            expect(fs.writeFileSync).not.toHaveBeenCalled();
        });
    });
});
