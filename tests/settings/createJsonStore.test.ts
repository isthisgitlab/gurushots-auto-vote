/**
 * createJsonStore — the generic platform-aware JSON store metadata.ts rides
 * (same transport pattern as the settings store): fs on Electron/CLI,
 * hydrate-once cache + ordered write-behind on Capacitor, memory-only on the
 * Android headless service.
 */

import type { GetOptions, GetResult, SetOptions } from '@capacitor/preferences';

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

import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import type * as storageModule from '../../src/js/settings/storage';

const g = globalThis as typeof globalThis & {
    Capacitor?: { isNativePlatform: () => boolean; getPlatform: () => string };
    __GS_HEADLESS__?: boolean;
};

describe('createJsonStore', () => {
    // No jest.resetModules(): createJsonStore reads the runtime flags at
    // call time, so fresh store instances per test are enough — and a
    // registry reset would detach the file-top `fs` reference from the
    // instance the store binds to.
    afterEach(() => {
        delete g.Capacitor;
        delete g.__GS_HEADLESS__;
        jest.clearAllMocks();
    });

    describe('fs transport (Electron/CLI)', () => {
        let store: ReturnType<typeof storageModule.createJsonStore>;

        beforeEach(() => {
            const { createJsonStore }: typeof storageModule = require('../../src/js/settings/storage');
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
        let store: ReturnType<typeof storageModule.createJsonStore>;

        beforeEach(() => {
            g.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
            mockPrefGet.mockResolvedValue({ value: '{"persisted":true}' });
            const { createJsonStore }: typeof storageModule = require('../../src/js/settings/storage');
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
            const persisted: string[] = [];
            let releaseFirst;
            const firstGate = new Promise<void>((resolve) => {
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

            releaseFirst!();
            await store.flushPendingWrites();
            expect(persisted).toEqual(['A', 'B']);
        });

        test("refreshAsync re-reads Preferences after this context's queued writes drain", async () => {
            let release;
            mockPrefSet.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        release = resolve;
                    }),
            );
            store.writeRaw('{"mine":1}');
            mockPrefGet.mockResolvedValue({ value: '{"background":2}' });
            const refreshed = store.refreshAsync();
            await Promise.resolve();
            expect(mockPrefGet).not.toHaveBeenCalled();
            release!();
            await refreshed;
            expect(mockPrefGet).toHaveBeenCalledWith({ key: 'gurushots-metadata' });
            expect(store.readRaw()).toBe('{"background":2}');
        });

        test('a failed refresh keeps the cache', async () => {
            store.writeRaw('{"kept":1}');
            mockPrefGet.mockRejectedValueOnce(new Error('bridge down'));
            await expect(store.refreshAsync()).resolves.toBeUndefined();
            expect(store.readRaw()).toBe('{"kept":1}');
        });

        test('a failed Preferences write is absorbed and the cache keeps the latest value', async () => {
            mockPrefSet.mockRejectedValueOnce(new Error('quota'));
            store.writeRaw('{"y":2}');
            await expect(store.flushPendingWrites()).resolves.toBeUndefined();
            expect(store.readRaw()).toBe('{"y":2}');
        });
    });

    describe('headless service (memory-only)', () => {
        let store: ReturnType<typeof storageModule.createJsonStore>;

        beforeEach(() => {
            g.__GS_HEADLESS__ = true;
            const { createJsonStore }: typeof storageModule = require('../../src/js/settings/storage');
            store = createJsonStore({ fileName: 'metadata.json', prefKey: 'gurushots-metadata' });
        });

        test('round-trips in memory without touching fs or Preferences', async () => {
            expect(store.readRaw()).toBeNull();
            store.writeRaw('{"m":1}');
            expect(store.readRaw()).toBe('{"m":1}');
            await store.initializeAsync();
            await store.refreshAsync();
            expect(mockPrefGet).not.toHaveBeenCalled();
            expect(mockPrefSet).not.toHaveBeenCalled();
            expect(fs.writeFileSync).not.toHaveBeenCalled();
        });
    });
});
