/**
 * Storage transport edge cases not exercised by storage.test.ts /
 * createJsonStore.test.ts:
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

import type * as node_fsModule from 'node:fs';
import type * as node_pathModule from 'node:path';
import type * as loggerModule from '../../src/ts/logger';
import type * as runtimeModule from '../../src/ts/runtime';
import type * as storageModule from '../../src/ts/settings/storage';
import type { GetOptions, GetResult, SetOptions } from '@capacitor/preferences';
import type { App } from 'electron';
import { invalid } from '../helpers/invalid';

const g = globalThis as typeof globalThis & {
    Capacitor?: { isNativePlatform: () => boolean; getPlatform: () => string };
    __GS_HEADLESS__?: boolean;
};

type ElectronAppDouble = Pick<App, 'getPath' | 'isPackaged'>;

/** What loadStorage hands back from its isolated module registry. */
type StorageCtx = {
    mod: typeof storageModule;
    fs: jest.MockedObject<typeof node_fsModule>;
    categoryLogger: {
        info: jest.Mock<void, Parameters<loggerModule.CategoryLogger['info']>>;
        error: jest.Mock<void, Parameters<loggerModule.CategoryLogger['error']>>;
        debug: jest.Mock<void, Parameters<loggerModule.CategoryLogger['debug']>>;
        warning: jest.Mock<void, Parameters<loggerModule.CategoryLogger['warning']>>;
    };
    runtime: typeof runtimeModule;
    /** The `electron` module factory of this registry; the no-Electron test asserts it is never called. */
    electronFactory: jest.MockedFunction<() => unknown>;
};

const mockPrefSet = jest.fn<Promise<void>, [SetOptions]>(() => Promise.resolve());
const mockPrefGet = jest.fn<Promise<GetResult>, [GetOptions]>(() => Promise.resolve({ value: null }));
const mockPrefKeys = jest.fn<Promise<{ keys: string[] }>, []>(() => Promise.resolve({ keys: [] }));
jest.mock('../../src/ts/runtime', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/runtime')>('../../src/ts/runtime'),
}));
jest.mock(
    '@capacitor/preferences',
    () => ({
        Preferences: {
            set: (...a: Parameters<typeof mockPrefSet>) => mockPrefSet(...a),
            get: (...a: Parameters<typeof mockPrefGet>) => mockPrefGet(...a),
            keys: () => mockPrefKeys(),
        },
    }),
    { virtual: true },
);

const USER_DATA = '/home/u/.config/gurushots-auto-vote-dev';

/**
 * Load a fresh storage module. `electronApp` (or null) becomes the module's
 * captured electron handle (runtime.isElectron is mocked to match);
 * `sourceCode` drives logger.isSourceCode. `noElectron` makes the electron
 * mock throw; the no-Electron test asserts the factory is never invoked.
 */
const loadStorage = ({
    electronApp = null,
    sourceCode = true,
    noElectron = false,
}: { electronApp?: ElectronAppDouble | null; sourceCode?: boolean; noElectron?: boolean } = {}): StorageCtx => {
    let ctx: StorageCtx | undefined;
    jest.isolateModules(() => {
        const electronFactory = jest.fn((): unknown => {
            if (noElectron) throw new Error('electron must not be loaded outside Electron');
            return electronApp ? { app: electronApp } : {};
        });
        jest.doMock('electron', electronFactory);
        const fs = jest.mocked(require('node:fs') as typeof node_fsModule);
        const path = jest.mocked(require('node:path') as typeof node_pathModule);
        const actualPath = jest.requireActual<typeof node_pathModule>('node:path');
        path.dirname.mockImplementation(actualPath.dirname);
        path.join.mockImplementation(actualPath.join);
        const logger = jest.mocked(require('../../src/ts/logger') as typeof loggerModule);
        const categoryLogger = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warning: jest.fn() };
        logger.withCategory.mockReturnValue(invalid(categoryLogger));
        logger.isSourceCode.mockReturnValue(sourceCode);
        const runtime = require('../../src/ts/runtime') as typeof runtimeModule;
        jest.spyOn(runtime, 'getAppUserDataPath').mockReturnValue(USER_DATA);
        jest.spyOn(runtime, 'isElectron').mockReturnValue(electronApp !== null);
        const mod = require('../../src/ts/settings/storage') as typeof storageModule;
        ctx = { mod, fs, categoryLogger, runtime, electronFactory };
    });
    return ctx!;
};

describe('settings storage — edge cases', () => {
    beforeEach(() => {
        mockPrefGet.mockReset();
        mockPrefKeys.mockClear();
        mockPrefSet.mockReset();
        mockPrefSet.mockResolvedValue(undefined);
    });

    afterEach(() => {
        delete g.Capacitor;
        delete g.__GS_HEADLESS__;
        jest.dontMock('electron');
    });

    test('outside Electron the electron package is never loaded (its npm package downloads the binary)', () => {
        // The factory-never-called assertion catches a regression that puts
        // back an unconditional require wrapped in a swallowing try/catch.
        const { mod, electronFactory } = loadStorage({ noElectron: true });
        expect(electronFactory).not.toHaveBeenCalled();
        expect(mod.electronApp).toBeNull();
    });

    describe('initializeAsync (settings store)', () => {
        test('is a no-op outside Capacitor', async () => {
            const { mod } = loadStorage();
            await mod.initializeAsync();
            expect(mockPrefGet).not.toHaveBeenCalled();
        });

        test('hydrates the cache once from Preferences on Capacitor', async () => {
            g.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
            mockPrefGet.mockImplementation(({ key }) =>
                Promise.resolve({ value: key === 'gurushots-config' ? '{"token":"t"}' : null }),
            );
            const { mod } = loadStorage();

            expect(mod.storage.readRaw()).toBeNull();
            await mod.initializeAsync();
            // The configuration and the 1.x settings file; the copies set aside are found among the keys.
            expect(mockPrefGet.mock.calls.map(([call]) => call.key).sort()).toEqual([
                'gurushots-config',
                'gurushots-settings',
            ]);
            expect(mockPrefKeys).toHaveBeenCalledTimes(2);
            expect(mod.storage.readRaw()).toBe('{"token":"t"}');
            expect(mod.legacyStorage.readRaw()).toBeNull();

            // Second call must not re-hydrate (and so must not clobber a newer write).
            mod.storage.writeRaw('{"token":"newer"}');
            await mod.initializeAsync();
            expect(mockPrefGet).toHaveBeenCalledTimes(2);
            expect(mod.storage.readRaw()).toBe('{"token":"newer"}');
        });

        test('a Preferences read failure is logged, leaves an empty cache and still marks initialized', async () => {
            g.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
            mockPrefGet.mockRejectedValue(new Error('bridge down'));
            const { mod, categoryLogger } = loadStorage();

            await expect(mod.initializeAsync()).resolves.toBeUndefined();
            expect(categoryLogger.error).toHaveBeenCalledWith('Capacitor preferences read failed:', expect.any(Error));
            expect(mod.storage.readRaw()).toBeNull();

            await mod.initializeAsync();
            // Each file's first read failed; neither is read again.
            expect(mockPrefGet).toHaveBeenCalledTimes(2);
        });
    });

    describe('createJsonStore.initializeAsync', () => {
        test('a Preferences read failure is logged with the store key and yields null', async () => {
            g.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
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
            g.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
            g.__GS_HEADLESS__ = true;
            const { mod } = loadStorage();
            const store = mod.createJsonStore({ fileName: 'x.json', prefKey: 'gurushots-x' });
            await store.initializeAsync();
            expect(mockPrefGet).not.toHaveBeenCalled();
        });
    });

    describe('fs transport', () => {
        // The chmod-then-write path of the stores that are not atomic (the settings file is written atomically).
        const plainStore = (mod: typeof storageModule) =>
            mod.createJsonStore({ fileName: 'metadata.json', prefKey: 'k' });

        test('a plain store writeRaw creates the userData dir when missing', () => {
            const { mod, fs } = loadStorage();
            fs.existsSync.mockReturnValue(false);
            plainStore(mod).writeRaw('{}');
            expect(fs.mkdirSync).toHaveBeenCalledWith(USER_DATA, { recursive: true, mode: 0o700 });
            expect(fs.writeFileSync).toHaveBeenCalledWith(`${USER_DATA}/metadata.json`, '{}', {
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

        test('a plain store writeRaw chmods the file to 0o600 before writing into it', () => {
            const { mod, fs, categoryLogger } = loadStorage();
            plainStore(mod).writeRaw('{}');
            expect(categoryLogger.info).not.toHaveBeenCalled();
            expect(categoryLogger.warning).not.toHaveBeenCalled();
            expect(fs.chmodSync).toHaveBeenCalledWith(`${USER_DATA}/metadata.json`, 0o600);
            expect(fs.chmodSync.mock.invocationCallOrder[0]).toBeLessThan(fs.writeFileSync.mock.invocationCallOrder[0]);
        });

        test('a plain store writeRaw skips a chmod that finds no file (ENOENT) silently and still creates it', () => {
            const { mod, fs, categoryLogger } = loadStorage();
            fs.chmodSync.mockImplementationOnce(() => {
                throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
            });
            plainStore(mod).writeRaw('{}');
            expect(categoryLogger.warning).not.toHaveBeenCalled();
            expect(categoryLogger.info).not.toHaveBeenCalled();
            expect(fs.writeFileSync).toHaveBeenCalledWith(`${USER_DATA}/metadata.json`, '{}', {
                encoding: 'utf8',
                mode: 0o600,
            });
        });

        test('a chmod that cannot search the path (EACCES) is skipped silently and the write is still attempted', () => {
            const { mod, fs, categoryLogger } = loadStorage();
            fs.chmodSync.mockImplementationOnce(() => {
                throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            });
            plainStore(mod).writeRaw('{}');
            expect(categoryLogger.warning).not.toHaveBeenCalled();
            expect(categoryLogger.info).not.toHaveBeenCalled();
            expect(fs.writeFileSync).toHaveBeenCalledWith(`${USER_DATA}/metadata.json`, '{}', {
                encoding: 'utf8',
                mode: 0o600,
            });
        });

        test('an ENOENT chmod leaves an open failure episode alone, so the next refusal still does not re-warn', () => {
            const { mod, fs, categoryLogger } = loadStorage();
            const refuse = () => {
                throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
            };
            const missing = () => {
                throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
            };
            fs.chmodSync.mockImplementationOnce(refuse).mockImplementationOnce(missing).mockImplementationOnce(refuse);
            plainStore(mod).writeRaw('{}');
            plainStore(mod).writeRaw('{}');
            plainStore(mod).writeRaw('{}');
            expect(fs.writeFileSync).toHaveBeenCalledTimes(3);
            expect(categoryLogger.warning).toHaveBeenCalledTimes(1);
            expect(categoryLogger.info).not.toHaveBeenCalled();
        });

        test('a refused chmod (EPERM) is logged with what to check and the data is still written', () => {
            const { mod, fs, categoryLogger } = loadStorage();
            fs.chmodSync.mockImplementationOnce(() => {
                throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
            });

            expect(() => plainStore(mod).writeRaw('{"token":"t"}')).not.toThrow();

            expect(fs.writeFileSync).toHaveBeenCalledWith(`${USER_DATA}/metadata.json`, '{"token":"t"}', {
                encoding: 'utf8',
                mode: 0o600,
            });
            expect(categoryLogger.warning).toHaveBeenCalledTimes(1);
            expect(categoryLogger.warning).toHaveBeenCalledWith(
                `Could not restrict ${USER_DATA}/metadata.json to owner-only (EPERM); other local users may be able to read it. It must be a regular file owned by the account this app runs as, on a filesystem that supports permissions (not FAT, SMB or FUSE); once it is, the next save restricts it automatically.`,
            );
        });

        test('repeated refused chmods on the same path warn once but every write still lands', () => {
            const { mod, fs, categoryLogger } = loadStorage();
            fs.chmodSync.mockImplementation(() => {
                throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
            });

            plainStore(mod).writeRaw('{"n":1}');
            plainStore(mod).writeRaw('{"n":2}');

            expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
            expect(categoryLogger.warning).toHaveBeenCalledTimes(1);
        });

        test('a path warns again after a chmod on it succeeds, once per failure episode', () => {
            const { mod, fs, categoryLogger } = loadStorage();
            const refuse = () => {
                throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
            };
            fs.chmodSync
                .mockImplementationOnce(refuse)
                .mockImplementationOnce(refuse)
                .mockImplementationOnce(() => {})
                .mockImplementationOnce(refuse)
                .mockImplementationOnce(refuse);

            const logsAfterEachWrite = [0, 1, 2, 3, 4].map((i) => {
                plainStore(mod).writeRaw(`{"n":${i}}`);
                return [categoryLogger.warning.mock.calls.length, categoryLogger.info.mock.calls.length];
            });

            expect(fs.chmodSync).toHaveBeenCalledTimes(5);
            expect(fs.writeFileSync).toHaveBeenCalledTimes(5);
            expect(logsAfterEachWrite).toEqual([
                [1, 0],
                [1, 0],
                [1, 1],
                [2, 1],
                [2, 1],
            ]);
            expect(categoryLogger.info).toHaveBeenCalledWith(`Restricted ${USER_DATA}/metadata.json to owner-only`);
        });

        test('refused chmods on two different paths warn once each', () => {
            const { mod, fs, categoryLogger } = loadStorage();
            const store = mod.createJsonStore({ fileName: 'metadata.json', prefKey: 'k' });
            const other = mod.createJsonStore({ fileName: 'other.json', prefKey: 'o' });
            fs.chmodSync.mockImplementation(() => {
                throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
            });

            other.writeRaw('{}');
            store.writeRaw('{}');
            other.writeRaw('{}');
            store.writeRaw('{}');

            expect(categoryLogger.warning).toHaveBeenCalledTimes(2);
            expect(categoryLogger.warning).toHaveBeenNthCalledWith(1, expect.stringContaining('/other.json'));
            expect(categoryLogger.warning).toHaveBeenNthCalledWith(2, expect.stringContaining('/metadata.json'));
        });

        test('a refused chmod whose error has no usable string code reports its message, then a generic reason', () => {
            const { mod, fs, categoryLogger } = loadStorage();
            const store = mod.createJsonStore({ fileName: 'metadata.json', prefKey: 'k' });
            const other = mod.createJsonStore({ fileName: 'other.json', prefKey: 'o' });
            const third = mod.createJsonStore({ fileName: 'third.json', prefKey: 't' });
            const fourth = mod.createJsonStore({ fileName: 'fourth.json', prefKey: 'f' });
            fs.chmodSync
                .mockImplementationOnce(() => {
                    throw new Error('read-only mount');
                })
                .mockImplementationOnce(() => {
                    throw Object.assign(new Error('code is undefined'), { code: undefined });
                })
                .mockImplementationOnce(() => {
                    throw invalid<Error>({ message: 'not an Error instance' });
                })
                .mockImplementationOnce(() => {
                    throw invalid<Error>({});
                });

            store.writeRaw('{}');
            other.writeRaw('{}');
            third.writeRaw('{}');
            fourth.writeRaw('{}');

            expect(fs.writeFileSync).toHaveBeenCalledTimes(4);
            expect(categoryLogger.warning).toHaveBeenNthCalledWith(1, expect.stringContaining('(read-only mount)'));
            expect(categoryLogger.warning).toHaveBeenNthCalledWith(2, expect.stringContaining('(code is undefined)'));
            expect(categoryLogger.warning).toHaveBeenNthCalledWith(
                3,
                expect.stringContaining('(not an Error instance)'),
            );
            expect(categoryLogger.warning).toHaveBeenNthCalledWith(4, expect.stringContaining('(unknown error)'));
        });

        test('createJsonStore writeRaw creates the directory when missing', () => {
            const { mod, fs } = loadStorage();
            fs.existsSync.mockReturnValue(false);
            const store = mod.createJsonStore({ fileName: 'metadata.json', prefKey: 'k' });
            store.writeRaw('{"a":1}');
            expect(fs.mkdirSync).toHaveBeenCalledWith(USER_DATA, { recursive: true, mode: 0o700 });
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

            expect(mod.getSettingsPath()).toBe(`${USER_DATA}/config.json`);
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
            expect(mod.getSettingsPath()).toBe(`${USER_DATA}/config.json`);
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

        test('getEnvironmentInfo reports when the process loaded, the same on every call', () => {
            const before = Date.now();
            const { mod } = loadStorage();
            const { launchedAt } = mod.getEnvironmentInfo();
            expect(launchedAt).toBeGreaterThanOrEqual(before);
            expect(launchedAt).toBeLessThanOrEqual(Date.now());
            expect(mod.getEnvironmentInfo().launchedAt).toBe(launchedAt);
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
