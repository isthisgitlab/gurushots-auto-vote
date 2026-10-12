/**
 * "Delete all local data": the registry lists every store the app persists (a
 * source scan fails for a createJsonStore call site that is not listed), and the
 * wipe refuses while the app is working, gives up pending writes, deletes every
 * registry entry (files and directories on desktop, Preferences keys on
 * Capacitor), clears the Electron session, and re-creates nothing afterwards.
 */

// A partial mock of the real fs, so the failure of one delete can be injected.
jest.mock('node:fs', () => {
    const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
    return { __esModule: true, ...actual, default: actual };
});
jest.unmock('path');
jest.unmock('node:path');
jest.mock('../../src/ts/runtime', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/runtime')>('../../src/ts/runtime'),
}));
jest.mock('../../src/ts/logger', () => {
    const cat = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        withCategory: jest.fn(() => cat),
    };
});
const mockPreferences = {
    set: jest.fn<Promise<void>, [{ key: string; value: string }]>(() => Promise.resolve()),
    get: jest.fn<Promise<{ value: string | null }>, [{ key: string }]>(() => Promise.resolve({ value: null })),
    remove: jest.fn<Promise<void>, [{ key: string }]>(() => Promise.resolve()),
};
jest.mock('@capacitor/preferences', () => ({ Preferences: mockPreferences }), { virtual: true });
const mockSession = {
    clearStorageData: jest.fn<Promise<void>, []>(() => Promise.resolve()),
    clearCache: jest.fn<Promise<void>, []>(() => Promise.resolve()),
};
const mockFromPartition = jest.fn((_partition: string) => mockSession);
jest.mock('electron', () => ({ session: { fromPartition: mockFromPartition } }));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { APP_PARTITION } from '../../src/ts/index/session';
import type * as runtimeModule from '../../src/ts/runtime';
import type * as localDataModule from '../../src/ts/settings/localData';
import type * as storageModule from '../../src/ts/settings/storage';
import type * as settingsModule from '../../src/ts/settings';
import type * as cancellationModule from '../../src/ts/voting/cancellation';
import type * as lockModule from '../../src/ts/settings/cliSessionLock';
import type * as passActivityModule from '../../src/ts/voting/passActivity';

const SRC_ROOT = path.join(__dirname, '..', '..', 'src', 'ts');

const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return /\.tsx?$/.test(entry.name) ? [full] : [];
    });

/** The `{ ... }` argument of each `createJsonStore(` call of a source text. */
const callArguments = (text: string): string[] => {
    const found: string[] = [];
    for (const match of text.matchAll(/createJsonStore\(\s*\{/g)) {
        let depth = 0;
        for (let i = match.index + match[0].length - 1; i < text.length; i++) {
            if (text[i] === '{') depth++;
            if (text[i] === '}' && --depth === 0) {
                found.push(text.slice(match.index + match[0].length - 1, i + 1));
                break;
            }
        }
    }
    return found;
};

const literalOrConstant = (value: string, text: string): string => {
    const literal = /^'([^']+)'$/.exec(value.trim());
    if (literal) return literal[1];
    const constant = new RegExp(`const ${value.trim()}\\s*=\\s*'([^']+)'`).exec(text);
    if (!constant) throw new Error(`cannot resolve ${value}`);
    return constant[1];
};

describe('the local-data registry', () => {
    const { LOCAL_DATA_STORES } = require('../../src/ts/settings/localData') as typeof localDataModule;

    const callSites = sourceFiles(SRC_ROOT)
        .filter((file) => !file.endsWith(path.join('settings', 'storage.ts')))
        .flatMap((file) => {
            const text = fs.readFileSync(file, 'utf8');
            return callArguments(text).map((args) => {
                const fileName = /fileName:\s*('[^']+')/.exec(args)?.[1];
                const prefKey = /prefKey:\s*([A-Za-z_'][^,}\n]*)/.exec(args)?.[1];
                if (!fileName || !prefKey) throw new Error(`cannot read a createJsonStore call in ${file}`);
                return {
                    file: path.relative(SRC_ROOT, file),
                    fileName: literalOrConstant(fileName, text),
                    prefKey: literalOrConstant(prefKey, text),
                };
            });
        });

    test('the scan finds the stores (so it cannot pass on an empty list)', () => {
        expect(callSites.length).toBeGreaterThanOrEqual(9);
    });

    test.each(callSites.map((site) => [site.file, site.fileName, site.prefKey]))(
        '%s: store %s / %s is in the registry',
        (_file, fileName, prefKey) => {
            expect(LOCAL_DATA_STORES).toContainEqual({ fileName, prefKey });
        },
    );

    test('the registry holds nothing the source does not create, plus the settings file', () => {
        const created = callSites.map((site) => `${site.fileName}|${site.prefKey}`);
        const listed = LOCAL_DATA_STORES.map((store) => `${store.fileName}|${store.prefKey}`);
        expect(listed.filter((entry) => !created.includes(entry))).toEqual(['settings.json|gurushots-settings']);
    });

    test('names are unique', () => {
        expect(new Set(LOCAL_DATA_STORES.map((s) => s.fileName)).size).toBe(LOCAL_DATA_STORES.length);
        expect(new Set(LOCAL_DATA_STORES.map((s) => s.prefKey)).size).toBe(LOCAL_DATA_STORES.length);
    });
});

type Ctx = {
    runtime: typeof runtimeModule;
    localData: typeof localDataModule;
    storage: typeof storageModule;
    settings: typeof settingsModule;
    cancellation: typeof cancellationModule;
    lock: typeof lockModule;
    passActivity: typeof passActivityModule;
};

const g = globalThis as typeof globalThis & {
    Capacitor?: { isNativePlatform: () => boolean; Plugins?: Record<string, unknown> };
};

describe('wipeLocalData', () => {
    let root: string;
    let userData: string;
    let visionParent: string;
    let ctx: Ctx;

    const load = () => {
        jest.isolateModules(() => {
            const runtime = require('../../src/ts/runtime') as typeof runtimeModule;
            jest.spyOn(runtime, 'getAppUserDataPath').mockReturnValue(userData);
            jest.spyOn(runtime, 'getUserDataDir').mockReturnValue(visionParent);
            ctx = {
                runtime,
                localData: require('../../src/ts/settings/localData') as typeof localDataModule,
                storage: require('../../src/ts/settings/storage') as typeof storageModule,
                settings: require('../../src/ts/settings') as typeof settingsModule,
                cancellation: require('../../src/ts/voting/cancellation') as typeof cancellationModule,
                lock: require('../../src/ts/settings/cliSessionLock') as typeof lockModule,
                passActivity: require('../../src/ts/voting/passActivity') as typeof passActivityModule,
            };
        });
    };

    /** Every file, backup and directory the wipe is to remove, filled with something. */
    const fillUserData = () => {
        for (const { fileName } of ctx.localData.LOCAL_DATA_STORES) {
            fs.writeFileSync(path.join(userData, fileName), '{"x":1}');
        }
        fs.writeFileSync(path.join(userData, 'settings.json.corrupt-2026-01-01T00-00-00-000Z'), 'broken');
        fs.writeFileSync(path.join(userData, 'settings.json.12.abcd1234.tmp'), 'half');
        fs.writeFileSync(path.join(userData, 'statelock-scenario.lock'), 'token');
        fs.writeFileSync(path.join(userData, 'joinlock-77.lock.stale-9'), 'token');
        fs.mkdirSync(path.join(userData, 'logs'));
        fs.writeFileSync(path.join(userData, 'logs', 'app-2026-01-01.log'), 'line');
        fs.mkdirSync(path.join(visionParent, 'vision', 'abc'), { recursive: true });
        fs.writeFileSync(path.join(visionParent, 'vision', 'abc', 'model.bin'), 'bytes');
        // Something that is not the app's stays.
        fs.writeFileSync(path.join(userData, 'Cookies'), 'chromium');
    };

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-wipe-'));
        userData = path.join(root, 'userData');
        visionParent = path.join(root, 'cli-data');
        fs.mkdirSync(userData);
        fs.mkdirSync(visionParent);
        mockPreferences.set.mockClear();
        mockPreferences.remove.mockClear();
        mockSession.clearStorageData.mockClear();
        mockSession.clearCache.mockClear();
        mockFromPartition.mockClear();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete g.Capacitor;
        fs.rmSync(root, { recursive: true, force: true });
    });

    describe('desktop (files)', () => {
        test('deletes every registry entry, its backups and temp files, the lock files and both directories', async () => {
            load();
            fillUserData();

            const result = await ctx.localData.wipeLocalData({ clearSession: async () => {} });

            expect(result.success).toBe(true);
            expect(fs.readdirSync(userData)).toEqual(['Cookies']);
            expect(fs.existsSync(path.join(visionParent, 'vision'))).toBe(false);
            const { removed } = result as Extract<typeof result, { success: true }>;
            expect(removed).toEqual(
                expect.arrayContaining([
                    path.join(userData, 'settings.json'),
                    path.join(userData, 'metadata.json'),
                    path.join(userData, 'logs'),
                    path.join(visionParent, 'vision'),
                ]),
            );
        });

        test('nothing the wipe deleted is re-created by a write that comes after it (or was pending)', async () => {
            load();
            fillUserData();
            const metadataStore = ctx.storage.createJsonStore({
                fileName: 'metadata.json',
                prefKey: 'gurushots-metadata',
            });

            const wiping = ctx.localData.wipeLocalData({ clearSession: async () => {} });
            // Writes made while it runs and right after: settings, a store, a store's atomic write, the token write.
            expect(ctx.storage.storage.writeRaw('{"token":"late"}')).toBe(false);
            metadataStore.writeRaw('{"late":1}');
            expect(await metadataStore.updateThrough(() => '{"late":2}')).toBe('failed');
            await wiping;
            expect(ctx.settings.setSetting('token', 'later')).toBe(false);
            metadataStore.writeRaw('{"later":1}');

            expect(fs.readdirSync(userData)).toEqual(['Cookies']);
        });

        test('stops a voting pass that is under way', async () => {
            load();
            ctx.cancellation.reset();

            await ctx.localData.wipeLocalData({ clearSession: async () => {} });

            expect(ctx.cancellation.isCancelled()).toBe(true);
        });

        test('a user-data directory that cannot be listed still has its listed entries deleted', async () => {
            load();
            fillUserData();
            const realReaddir = fs.readdirSync;
            jest.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, ...rest: unknown[]) => {
                if (String(dir) === userData) throw new Error('EIO');
                return (realReaddir as (...args: unknown[]) => unknown)(dir, ...rest);
            }) as typeof fs.readdirSync);

            const result = await ctx.localData.wipeLocalData({ clearSession: async () => {} });

            expect(result.success).toBe(true);
            expect(fs.existsSync(path.join(userData, 'settings.json'))).toBe(false);
            expect(fs.existsSync(path.join(userData, 'logs'))).toBe(false);
            // Only what the listing would have found beside them stays.
            expect(fs.existsSync(path.join(userData, 'statelock-scenario.lock'))).toBe(true);
        });

        test('works on a directory that holds none of it', async () => {
            load();
            await expect(ctx.localData.wipeLocalData({ clearSession: async () => {} })).resolves.toEqual({
                success: true,
                removed: [],
            });
        });

        test('a path that cannot be removed fails the wipe, names it, deletes the rest and lets stores write again', async () => {
            load();
            fillUserData();
            const realRm = fs.rmSync;
            jest.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, options?: fs.RmOptions) => {
                if (String(target).endsWith('metadata.json')) throw new Error('EBUSY: resource busy');
                return realRm(target, options);
            }) as typeof fs.rmSync);

            const result = await ctx.localData.wipeLocalData({ clearSession: async () => {} });

            expect(result).toEqual({
                success: false,
                error: expect.stringContaining(`${path.join(userData, 'metadata.json')} (EBUSY: resource busy)`),
            });
            expect(fs.existsSync(path.join(userData, 'settings.json'))).toBe(false);
            expect(fs.existsSync(path.join(userData, 'logs'))).toBe(false);
            // The app is still running: its stores work again.
            expect(ctx.storage.storage.writeRaw('{}')).toBe(true);
        });

        test('a failure with no message and a wipe step that throws are reported', async () => {
            load();
            fillUserData();
            jest.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
                throw null;
            });
            const first = await ctx.localData.wipeLocalData({ clearSession: async () => {} });
            expect(first).toEqual({ success: false, error: expect.stringContaining('(unknown error)') });

            load();
            const second = await ctx.localData.wipeLocalData({
                clearSession: async () => {
                    throw new Error('session gone');
                },
            });
            expect(second).toEqual({ success: false, error: 'Could not delete: session gone' });

            load();
            const third = await ctx.localData.wipeLocalData({
                stopScheduler: () => {
                    throw null;
                },
            });
            expect(third).toEqual({ success: false, error: 'Could not delete: unknown error' });
        });
    });

    describe('refusing', () => {
        test('while auto-vote is running, touching nothing', async () => {
            load();
            fillUserData();
            fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ autovoteRunning: true }));

            const result = await ctx.localData.wipeLocalData({ clearSession: async () => {} });

            expect(result).toEqual({ success: false, error: 'busy' });
            expect(fs.existsSync(path.join(userData, 'metadata.json'))).toBe(true);
            expect(ctx.cancellation.isCancelled()).toBe(false);
            expect(ctx.storage.storage.writeRaw('{"autovoteRunning":true}')).toBe(true);
        });

        test('while a CLI session holds its marker, touching nothing', async () => {
            load();
            fillUserData();
            // The parent process (the test runner's shell or the runner itself) is a live process that is not this one.
            fs.writeFileSync(path.join(userData, 'cli-session.lock'), JSON.stringify({ pid: process.ppid }));

            const result = await ctx.localData.wipeLocalData({ clearSession: async () => {} });

            expect(result).toEqual({ success: false, error: 'busy' });
            expect(fs.existsSync(path.join(userData, 'metadata.json'))).toBe(true);
        });

        test('while a voting pass is under way, touching nothing', async () => {
            load();
            fillUserData();
            const endPass = ctx.passActivity.beginVotingPass();

            const result = await ctx.localData.wipeLocalData({ clearSession: async () => {} });
            endPass();

            expect(result).toEqual({ success: false, error: 'busy' });
            expect(fs.existsSync(path.join(userData, 'metadata.json'))).toBe(true);
            expect(ctx.cancellation.isCancelled()).toBe(false);
        });

        test('a stale marker (its process is gone) does not block', async () => {
            load();
            fs.writeFileSync(path.join(userData, 'cli-session.lock'), JSON.stringify({ pid: 2 ** 22 + 12345 }));

            await expect(ctx.localData.wipeLocalData({ clearSession: async () => {} })).resolves.toEqual({
                success: true,
                removed: [path.join(userData, 'cli-session.lock')],
            });
        });
    });

    describe('Electron', () => {
        test('clears the cookies, storage and cache of the session the windows use', async () => {
            load();
            jest.spyOn(ctx.runtime, 'isElectron').mockReturnValue(true);

            await ctx.localData.wipeLocalData();

            expect(mockFromPartition).toHaveBeenCalledWith(APP_PARTITION);
            expect(mockSession.clearStorageData).toHaveBeenCalledTimes(1);
            expect(mockSession.clearCache).toHaveBeenCalledTimes(1);
        });

        test('outside Electron there is no session to clear', async () => {
            load();
            jest.spyOn(ctx.runtime, 'isElectron').mockReturnValue(false);

            await ctx.localData.wipeLocalData();

            expect(mockFromPartition).not.toHaveBeenCalled();
        });
    });

    describe('Capacitor (Preferences)', () => {
        const wipeNative = jest.fn<Promise<{ ok: boolean }>, []>();

        beforeEach(() => {
            g.Capacitor = {
                isNativePlatform: () => true,
                Plugins: { AutoVoteBackground: { wipeLocalData: wipeNative, compareAndWrite: jest.fn() } },
            };
            wipeNative.mockReset();
            wipeNative.mockResolvedValue({ ok: true });
        });

        test('asks the native plugin first, then removes every store key and the settings backup key', async () => {
            load();

            const result = await ctx.localData.wipeLocalData();

            expect(wipeNative).toHaveBeenCalledTimes(1);
            expect(result.success).toBe(true);
            const removedKeys = mockPreferences.remove.mock.calls.map(([{ key }]) => key);
            expect(removedKeys).toEqual(
                expect.arrayContaining([
                    'gurushots-settings',
                    'gurushots-settings_corrupt',
                    'gs_scenario_state',
                    'gs_join_state',
                    'gurushots-metadata',
                ]),
            );
            expect(removedKeys).toHaveLength(ctx.localData.LOCAL_DATA_STORES.length * 2);
            // No file system on Android: nothing under the user-data path is touched.
            expect(fs.readdirSync(userData)).toEqual([]);
        });

        test('writes still queued are given up, so nothing puts a value back after the keys are removed', async () => {
            load();
            let release: () => void = () => {};
            mockPreferences.set.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
            const store = ctx.storage.createJsonStore({ fileName: 'metadata.json', prefKey: 'gurushots-metadata' });
            store.writeRaw('{"first":1}');
            store.writeRaw('{"second":2}');
            store.writeRaw('{"third":3}');
            ctx.storage.storage.writeRaw('{"settings":1}');
            // The settings' write takes a few turns to reach Preferences.
            while (mockPreferences.set.mock.calls.length < 2) await Promise.resolve();
            expect(mockPreferences.set).toHaveBeenCalledTimes(2);

            const wiping = ctx.localData.wipeLocalData();
            release();
            await wiping;
            store.writeRaw('{"after":1}');
            await store.flushPendingWrites();

            // The two writes already handed to Preferences (the store's first, the settings') landed before the keys were
            // removed; the others never did.
            expect(mockPreferences.set).toHaveBeenCalledTimes(2);
            expect(mockPreferences.set.mock.invocationCallOrder[0]).toBeLessThan(
                mockPreferences.remove.mock.invocationCallOrder[0],
            );
            // A write after the wipe is refused, so nothing is cached for the app to read either.
            expect(store.readRaw()).toBeNull();
            expect(mockPreferences.set).toHaveBeenCalledTimes(2);
        });

        test('a strict store whose last write did not persist does not fail the wipe', async () => {
            load();
            mockPreferences.set.mockRejectedValueOnce(new Error('not persisted'));
            const strict = ctx.storage.createJsonStore({ fileName: 'x.json', prefKey: 'gs_x', strict: true });
            strict.writeRaw('{"a":1}');

            await expect(ctx.localData.wipeLocalData()).resolves.toEqual(expect.objectContaining({ success: true }));
        });

        test('a write-through still waiting its turn is given up as well, and changes nothing', async () => {
            load();
            let release: () => void = () => {};
            mockPreferences.set.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
            const store = ctx.storage.createJsonStore({ fileName: 'metadata.json', prefKey: 'gurushots-metadata' });
            store.writeRaw('{"first":1}');
            await Promise.resolve();
            const update = jest.fn(() => '{"through":1}');
            const through = store.updateThrough(update);

            const wiping = ctx.localData.wipeLocalData();
            release();
            await wiping;

            await expect(through).resolves.toBe('aborted');
            expect(update).not.toHaveBeenCalled();
            expect(mockPreferences.set).toHaveBeenCalledTimes(1);
        });

        test('a native wipe that did not go through fails the wipe, and the stores write again', async () => {
            load();
            wipeNative.mockResolvedValue({ ok: false });

            const result = await ctx.localData.wipeLocalData();

            expect(result).toEqual({ success: false, error: 'Could not delete: the background service data' });
            expect(ctx.storage.storage.writeRaw('{}')).toBe(true);
        });

        test('a build without the plugin carries on', async () => {
            load();
            g.Capacitor = { isNativePlatform: () => true, Plugins: {} };

            await expect(ctx.localData.wipeLocalData()).resolves.toEqual(expect.objectContaining({ success: true }));
        });

        test('an answer that is no object counts as not done', async () => {
            load();
            wipeNative.mockResolvedValue(undefined as unknown as { ok: boolean });

            await expect(ctx.localData.wipeLocalData()).resolves.toEqual({
                success: false,
                error: 'Could not delete: the background service data',
            });
        });

        test('with no Capacitor plugins object at all there is nothing native to ask', async () => {
            load();
            g.Capacitor = { isNativePlatform: () => true };

            await expect(ctx.localData.wipeLocalData()).resolves.toEqual(expect.objectContaining({ success: true }));
        });
    });
});
