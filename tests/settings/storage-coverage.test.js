/**
 * Storage transport edge cases not exercised by storage.test.js /
 * createJsonStore.test.js:
 *   - settings-store Capacitor hydration (initializeAsync) incl. failure
 *   - createJsonStore hydration failure
 *   - fs transport creating the userData dir on first write
 *   - the one-shot legacy dev-dir notice (Electron + running from source)
 *   - environment info / mock default / autovote-running detection
 *
 * Module-level state (capacitorInitialized, legacyDevDirChecked, electronApp)
 * is captured at require time, so each case loads a fresh module graph via
 * jest.isolateModules and configures the mocks from THAT registry.
 */

const mockPrefSet = jest.fn(() => Promise.resolve());
const mockPrefGet = jest.fn(() => Promise.resolve({ value: null }));
jest.mock(
    '@capacitor/preferences',
    () => ({ Preferences: { set: (...a) => mockPrefSet(...a), get: (...a) => mockPrefGet(...a) } }),
    { virtual: true },
);

const USER_DATA = '/home/u/.config/gurushots-auto-vote-dev';

/**
 * Load a fresh storage module. `electronApp` (or null) becomes the module's
 * captured electron handle; `sourceCode` drives logger.isSourceCode.
 */
const loadStorage = ({ electronApp = null, sourceCode = true } = {}) => {
    let ctx;
    jest.isolateModules(() => {
        jest.doMock('electron', () => (electronApp ? { app: electronApp } : {}));
        const fs = require('node:fs');
        const path = require('node:path');
        const actualPath = jest.requireActual('node:path');
        path.dirname.mockImplementation(actualPath.dirname);
        path.join.mockImplementation(actualPath.join);
        const logger = require('../../src/js/logger');
        const categoryLogger = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warning: jest.fn() };
        logger.withCategory.mockReturnValue(categoryLogger);
        logger.isSourceCode.mockReturnValue(sourceCode);
        const runtime = require('../../src/js/runtime');
        jest.spyOn(runtime, 'getAppUserDataPath').mockReturnValue(USER_DATA);
        const mod = require('../../src/js/settings/storage');
        ctx = { mod, fs, categoryLogger, runtime };
    });
    return ctx;
};

describe('settings storage — edge cases', () => {
    beforeEach(() => {
        mockPrefGet.mockReset();
        mockPrefSet.mockReset();
        mockPrefSet.mockResolvedValue(undefined);
    });

    afterEach(() => {
        delete globalThis.Capacitor;
        delete globalThis.__GS_HEADLESS__;
        jest.dontMock('electron');
    });

    describe('initializeAsync (settings store)', () => {
        test('is a no-op outside Capacitor', async () => {
            const { mod } = loadStorage();
            await mod.initializeAsync();
            expect(mockPrefGet).not.toHaveBeenCalled();
        });

        test('hydrates the cache once from Preferences on Capacitor', async () => {
            globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
            mockPrefGet.mockResolvedValue({ value: '{"token":"t"}' });
            const { mod } = loadStorage();

            expect(mod.storage.readRaw()).toBeNull();
            await mod.initializeAsync();
            expect(mockPrefGet).toHaveBeenCalledWith({ key: 'gurushots-settings' });
            expect(mod.storage.readRaw()).toBe('{"token":"t"}');

            // Second call must not re-hydrate (and so must not clobber a newer write).
            mod.storage.writeRaw('{"token":"newer"}');
            await mod.initializeAsync();
            expect(mockPrefGet).toHaveBeenCalledTimes(1);
            expect(mod.storage.readRaw()).toBe('{"token":"newer"}');
        });

        test('a Preferences read failure is logged, leaves an empty cache and still marks initialized', async () => {
            globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
            mockPrefGet.mockRejectedValue(new Error('bridge down'));
            const { mod, categoryLogger } = loadStorage();

            await expect(mod.initializeAsync()).resolves.toBeUndefined();
            expect(categoryLogger.error).toHaveBeenCalledWith('Capacitor preferences read failed:', expect.any(Error));
            expect(mod.storage.readRaw()).toBeNull();

            await mod.initializeAsync();
            expect(mockPrefGet).toHaveBeenCalledTimes(1);
        });
    });

    describe('createJsonStore.initializeAsync', () => {
        test('a Preferences read failure is logged with the store key and yields null', async () => {
            globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
            mockPrefGet.mockRejectedValue(new Error('nope'));
            const { mod, categoryLogger } = loadStorage();
            const store = mod.createJsonStore({ fileName: 'x.json', prefKey: 'gurushots-x' });

            await store.initializeAsync();
            expect(categoryLogger.error).toHaveBeenCalledWith('Capacitor gurushots-x read failed:', expect.any(Error));
            expect(store.readRaw()).toBeNull();
            await store.initializeAsync();
            expect(mockPrefGet).toHaveBeenCalledTimes(1);
        });

        test('is a no-op on the headless service even when Capacitor is present', async () => {
            globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
            globalThis.__GS_HEADLESS__ = true;
            const { mod } = loadStorage();
            const store = mod.createJsonStore({ fileName: 'x.json', prefKey: 'gurushots-x' });
            await store.initializeAsync();
            expect(mockPrefGet).not.toHaveBeenCalled();
        });
    });

    describe('fs transport', () => {
        test('settings writeRaw creates the userData dir when missing', () => {
            const { mod, fs } = loadStorage();
            fs.existsSync.mockReturnValue(false);
            mod.storage.writeRaw('{}');
            expect(fs.mkdirSync).toHaveBeenCalledWith(USER_DATA, { recursive: true });
            expect(fs.writeFileSync).toHaveBeenCalledWith(`${USER_DATA}/settings.json`, '{}', {
                encoding: 'utf8',
                mode: 0o600,
            });
        });

        test('settings readRaw returns null when the file does not exist', () => {
            const { mod, fs } = loadStorage();
            fs.existsSync.mockReturnValue(false);
            expect(mod.storage.readRaw()).toBeNull();
            expect(fs.readFileSync).not.toHaveBeenCalled();
        });

        test('createJsonStore writeRaw creates the directory when missing', () => {
            const { mod, fs } = loadStorage();
            fs.existsSync.mockReturnValue(false);
            const store = mod.createJsonStore({ fileName: 'metadata.json', prefKey: 'k' });
            store.writeRaw('{"a":1}');
            expect(fs.mkdirSync).toHaveBeenCalledWith(USER_DATA, { recursive: true });
            expect(fs.writeFileSync).toHaveBeenCalledWith(`${USER_DATA}/metadata.json`, '{"a":1}', {
                encoding: 'utf8',
                mode: 0o600,
            });
        });
    });

    describe('legacy dev-dir notice', () => {
        const electronApp = { getPath: jest.fn(() => '/apps/Electron'), isPackaged: false };
        const LEGACY_FILE = '/apps/gurushots-auto-vote-dev/settings.json';

        test('warns once when a legacy dev settings.json exists elsewhere', () => {
            const { mod, fs, categoryLogger } = loadStorage({ electronApp });
            fs.existsSync.mockImplementation((p) => p === LEGACY_FILE);

            expect(mod.getSettingsPath()).toBe(`${USER_DATA}/settings.json`);
            expect(categoryLogger.warning).toHaveBeenCalledTimes(1);
            expect(categoryLogger.warning.mock.calls[0][0]).toContain('/apps/gurushots-auto-vote-dev');

            // One-shot: later resolutions never re-check or re-warn.
            fs.existsSync.mockClear();
            mod.getSettingsPath();
            expect(fs.existsSync).not.toHaveBeenCalled();
            expect(categoryLogger.warning).toHaveBeenCalledTimes(1);
        });

        test('stays silent when no legacy file exists', () => {
            const { mod, fs, categoryLogger } = loadStorage({ electronApp });
            fs.existsSync.mockReturnValue(false);
            mod.getSettingsPath();
            expect(fs.existsSync).toHaveBeenCalledWith(LEGACY_FILE);
            expect(categoryLogger.warning).not.toHaveBeenCalled();
        });

        test('stays silent when the legacy dir IS the current userData dir', () => {
            const sameApp = { getPath: () => '/home/u/.config/Electron', isPackaged: false };
            const { mod, fs, categoryLogger } = loadStorage({ electronApp: sameApp });
            fs.existsSync.mockReturnValue(true);
            mod.getSettingsPath();
            expect(categoryLogger.warning).not.toHaveBeenCalled();
        });

        test('swallows an fs error — settings path resolution never fails', () => {
            const { mod, fs, categoryLogger } = loadStorage({ electronApp });
            fs.existsSync.mockImplementation(() => {
                throw new Error('EACCES');
            });
            expect(mod.getSettingsPath()).toBe(`${USER_DATA}/settings.json`);
            expect(categoryLogger.warning).not.toHaveBeenCalled();
        });

        test('skips the check entirely for a built (non-source) app', () => {
            const { mod, fs } = loadStorage({ electronApp, sourceCode: false });
            fs.existsSync.mockReturnValue(true);
            mod.getSettingsPath();
            expect(fs.existsSync).not.toHaveBeenCalledWith(LEGACY_FILE);
        });
    });

    describe('environment helpers', () => {
        test('getEnvironmentInfo reports a packaged Electron app as built', () => {
            const { mod } = loadStorage({ electronApp: { getPath: () => USER_DATA, isPackaged: true } });
            const info = mod.getEnvironmentInfo();
            expect(info.isElectronPackaged).toBe(true);
            expect(info.isBuiltApp).toBe(true);
            expect(info.userDataPath).toBe(USER_DATA);
        });

        test('getEnvironmentInfo without Electron: built only when not running from source', () => {
            const fromSource = loadStorage().mod.getEnvironmentInfo();
            expect(fromSource.isElectronPackaged).toBe(false);
            expect(fromSource.isBuiltApp).toBe(false);

            const built = loadStorage({ sourceCode: false }).mod.getEnvironmentInfo();
            expect(built.isElectronPackaged).toBe(false);
            expect(built.isBuiltApp).toBe(true);
        });

        test('getDefaultMockSetting is true in development, false otherwise', () => {
            const { mod } = loadStorage();
            const saved = { NODE_ENV: process.env.NODE_ENV, DEV: process.env.DEV };
            try {
                process.env.DEV = 'true';
                expect(mod.getDefaultMockSetting()).toBe(true);
                delete process.env.DEV;
                process.env.NODE_ENV = 'test';
                expect(mod.getDefaultMockSetting()).toBe(false);
            } finally {
                process.env.NODE_ENV = saved.NODE_ENV;
                if (saved.DEV === undefined) delete process.env.DEV;
                else process.env.DEV = saved.DEV;
            }
        });
    });
});
