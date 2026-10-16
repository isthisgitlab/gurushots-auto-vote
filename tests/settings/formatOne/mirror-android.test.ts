/**
 * The mirror on Android, and the order its writes keep. In the app window (Preferences behind a cache, a compare-and-write
 * through the native plugin shared with the background service) the mirror waits for the configuration's own write to
 * land, derives its text from the configuration Preferences holds then, and overwrites settings.json only while it
 * still holds what was read; when it changed meanwhile (the other context mirrored too) the text is made again from the
 * stored configuration, a few times, and then given up quietly until the next save or start. In the service the same
 * runs through the native bridge, one synchronous step at a time.
 */

// No test here may touch the real user-data folder: the path is a made-up one that does not exist.
jest.mock('../../../src/ts/runtime', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../../src/ts/runtime')>('../../../src/ts/runtime'),
    getAppUserDataPath: () => '/nonexistent/gurushots-auto-vote-test-user-data',
}));
jest.mock('../../../src/ts/logger', () => {
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
        __cat: cat,
    };
});

// What the native store holds: Preferences and the compare-and-write of the plugin are one store.
const prefs = new Map<string, string>();
const mockPreferences = {
    set: jest.fn<Promise<void>, [{ key: string; value: string }]>(),
    get: jest.fn<Promise<{ value: string | null }>, [{ key: string }]>(),
    remove: jest.fn<Promise<void>, [{ key: string }]>(),
    keys: jest.fn<Promise<{ keys: string[] }>, []>(),
};
jest.mock('@capacitor/preferences', () => ({ Preferences: mockPreferences }), { virtual: true });

import type * as settingsModule from '../../../src/ts/settings';
import type * as loggerModule from '../../../src/ts/logger';
import type * as storageModule from '../../../src/ts/settings/storage';
import type { CategoryLogger } from '../../../src/ts/logger';
import { installHeadlessStore, removeHeadlessStore } from '../../helpers/headlessStore';
import { invalid } from '../../helpers/invalid';
import { parseJsonObject } from '../../helpers/parseJson';

type CatDouble = jest.Mocked<Pick<CategoryLogger, 'info' | 'error' | 'debug' | 'success' | 'warning'>>;
type Cas = { key: string; expected: string | null; value: string };
type CasAnswer = { saved: boolean; current: string | null };

const g = globalThis as typeof globalThis & {
    Capacitor?: { isNativePlatform: () => boolean; Plugins?: Record<string, unknown> };
};

const CONFIG = 'gurushots-config';
const MIRROR = 'gurushots-settings';
const ORIGINAL = 'gurushots-settings_original';
const USER_FILE = JSON.stringify({ theme: 'dark', token: 'tok-secret', lastUsername: 'me' });
const STORED_CONFIG = JSON.stringify({
    version: 2,
    app: { theme: 'dark' },
    auth: { token: 'tok-secret', apiHeaders: {}, lastUsername: 'me', chosenPhotosMemberId: '' },
});

let cat: CatDouble;
// Every compare-and-write the plugin took, in order.
let calls: Cas[] = [];
// What decides one: a hook may answer before the store does (delay it, refuse it, change the store first).
let hook: ((call: Cas) => Promise<CasAnswer | undefined> | CasAnswer | undefined) | null = null;

const nativeCompareAndWrite = async (call: Cas): Promise<CasAnswer> => {
    calls.push(call);
    const answered = await hook?.(call);
    if (answered) return answered;
    const current = prefs.get(call.key) ?? null;
    if (current !== ((call.expected ?? '') || null)) return { saved: false, current };
    prefs.set(call.key, call.value);
    return { saved: true, current: null };
};

let discardPendingWrites: typeof storageModule.discardPendingWrites;

const loadSettingsModule = () => {
    let mod: typeof settingsModule | undefined;
    jest.isolateModules(() => {
        mod = require('../../../src/ts/settings') as typeof settingsModule;
        discardPendingWrites = (require('../../../src/ts/settings/storage') as typeof storageModule)
            .discardPendingWrites;
        cat = invalid<typeof loggerModule & { __cat: CatDouble }>(
            require('../../../src/ts/logger') as typeof loggerModule,
        ).__cat;
    });
    return mod!;
};

// The window after its start: stores read, the mirror checked at the first load, and every write of that settled.
const appWindow = async (initial: Record<string, string> = {}, { settled = true } = {}) => {
    for (const [key, value] of Object.entries(initial)) prefs.set(key, value);
    g.Capacitor = {
        isNativePlatform: () => true,
        Plugins: { AutoVoteBackground: { compareAndWrite: jest.fn(nativeCompareAndWrite) } },
    };
    const settings = loadSettingsModule();
    await settings.initializeAsync();
    if (settled) {
        settings.loadSettings();
        await settings.flushPendingWrites();
        calls = [];
    }
    return settings;
};

const callsTo = (key: string) => calls.filter((call) => call.key === key);
const stored = (key: string) => parseJsonObject(prefs.get(key) ?? 'null');

beforeEach(() => {
    mockPreferences.set.mockImplementation(({ key, value }) => {
        prefs.set(key, value);
        return Promise.resolve();
    });
    mockPreferences.get.mockImplementation(({ key }) => Promise.resolve({ value: prefs.get(key) ?? null }));
    mockPreferences.remove.mockImplementation(({ key }) => {
        prefs.delete(key);
        return Promise.resolve();
    });
    mockPreferences.keys.mockImplementation(() => Promise.resolve({ keys: [...prefs.keys()] }));
});

afterEach(() => {
    delete g.Capacitor;
    removeHeadlessStore();
    jest.clearAllMocks();
    prefs.clear();
    calls = [];
    hook = null;
});

describe('the mirror in the Android app window', () => {
    test('is written once the configuration has landed, from the configuration Preferences holds then', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MIRROR]: USER_FILE });
        const before = prefs.get(MIRROR);
        let releaseConfig: () => void = () => undefined;
        hook = (call) =>
            call.key === CONFIG
                ? new Promise<undefined>((resolve) => {
                      releaseConfig = () => resolve(undefined);
                  })
                : undefined;

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 20));

        // The configuration's write is out and not answered: nothing is mirrored from it yet.
        expect(callsTo(CONFIG)).toHaveLength(1);
        expect(callsTo(MIRROR)).toHaveLength(0);

        releaseConfig();
        await settings.flushPendingWrites();

        expect(callsTo(MIRROR)).toHaveLength(1);
        expect(stored(MIRROR)).toMatchObject({ theme: 'light', token: 'tok-secret' });
        expect(callsTo(MIRROR)[0].expected).toBe(before);
    });

    test('is not written from a configuration that did not land, and the next save makes it', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MIRROR]: USER_FILE });
        hook = (call) => (call.key === CONFIG ? Promise.reject(new Error('disk full')) : undefined);

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await settings.flushPendingWrites();

        expect(callsTo(MIRROR)).toHaveLength(0);
        expect(stored(MIRROR)).toMatchObject({ theme: 'dark' });
        expect(settings.getSettingsRecovery()).toBeNull();

        hook = null;
        expect(settings.setSetting('language', 'lv')).toBe(true);
        await settings.flushPendingWrites();

        expect(stored(MIRROR)).toMatchObject({ theme: 'dark', language: 'lv' });
    });

    test('keeps the file the user had before it first writes over it, and no copy afterwards', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MIRROR]: USER_FILE }, { settled: false });

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await settings.flushPendingWrites();

        const order = calls.map((call) => call.key);
        expect(order.indexOf(ORIGINAL)).toBeGreaterThanOrEqual(0);
        expect(order.indexOf(ORIGINAL)).toBeLessThan(order.lastIndexOf(MIRROR));
        expect(prefs.get(ORIGINAL)).toBe(USER_FILE);

        prefs.set(MIRROR, JSON.stringify({ theme: 'other' }));
        calls = [];
        expect(settings.setSetting('theme', 'dark')).toBe(true);
        await settings.flushPendingWrites();

        expect(callsTo(ORIGINAL)).toHaveLength(0);
        expect(prefs.get(ORIGINAL)).toBe(USER_FILE);
    });

    test('is not written over a file that could not be kept: the copy failed, settings.json stays, the next save tries again', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MIRROR]: USER_FILE }, { settled: false });
        hook = (call) => (call.key === ORIGINAL ? Promise.reject(new Error('quota')) : undefined);

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await settings.flushPendingWrites();

        expect(prefs.get(MIRROR)).toBe(USER_FILE);
        expect(prefs.has(ORIGINAL)).toBe(false);
        expect(callsTo(MIRROR)).toHaveLength(0);

        hook = null;
        expect(settings.setSetting('theme', 'dark')).toBe(true);
        await settings.flushPendingWrites();

        expect(prefs.get(ORIGINAL)).toBe(USER_FILE);
        expect(stored(MIRROR)).toMatchObject({ theme: 'dark' });
    });

    test('is made again from the stored configuration when settings.json changed under the write', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MIRROR]: USER_FILE });
        let conflicts = 1;
        hook = (call) => {
            if (call.key !== MIRROR || conflicts-- <= 0) return undefined;
            // The background service saved a newer configuration and mirrored it, in between.
            prefs.set(
                CONFIG,
                JSON.stringify({ ...parseJsonObject(prefs.get(CONFIG) ?? '{}'), defaults: { exposure: 42 } }),
            );
            prefs.set(MIRROR, JSON.stringify({ mirroredBy: 'service' }));
            return { saved: false, current: prefs.get(MIRROR) ?? null };
        };

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await settings.flushPendingWrites();

        expect(callsTo(MIRROR)).toHaveLength(2);
        // The second attempt rests on what the other context left, and carries what it saved.
        expect(callsTo(MIRROR)[1].expected).toBe(JSON.stringify({ mirroredBy: 'service' }));
        expect(stored(MIRROR)).toMatchObject({
            theme: 'light',
            challengeSettings: { globalDefaults: { exposure: 42 } },
        });
        expect(cat.error).not.toHaveBeenCalled();
    });

    test('is given up quietly after three conflicts, and made by the next save', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MIRROR]: USER_FILE });
        hook = (call) => (call.key === MIRROR ? { saved: false, current: prefs.get(MIRROR) ?? null } : undefined);

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await settings.flushPendingWrites();

        expect(callsTo(MIRROR)).toHaveLength(3);
        expect(cat.error).not.toHaveBeenCalled();
        expect(cat.info).toHaveBeenCalledWith(expect.stringContaining('tried again with the next save or start'));
        expect(settings.getSettingsRecovery()).toBeNull();
        expect(settings.getSettingsSaveDropped()).toBeNull();

        hook = null;
        settings.setSetting('language', 'lv');
        await settings.flushPendingWrites();
        expect(stored(MIRROR)).toMatchObject({ theme: 'light', language: 'lv' });
    });

    test('a store that refuses it, or takes nothing so large, is a failed mirror: logged, the configuration is intact', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MIRROR]: USER_FILE });
        hook = (call) =>
            call.key === MIRROR
                ? Promise.reject(Object.assign(new Error('too large'), { code: 'too-large' }))
                : undefined;

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await settings.flushPendingWrites();

        expect(stored(CONFIG).app).toMatchObject({ theme: 'light' });
        expect(stored(MIRROR)).toMatchObject({ theme: 'dark' });
        expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('write failed:'), expect.any(Error));
        // The window is not told its save was dropped: the configuration is what it saved.
        expect(settings.getSettingsSaveDropped()).toBeNull();
    });

    test('is not overwritten by a mirror of an older configuration: settings.json is read first, so the write is a conflict', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MIRROR]: USER_FILE });
        let armed = true;
        // Whichever of the two reads comes first, the service saves a newer configuration and mirrors it right after it.
        const real = mockPreferences.get.getMockImplementation();
        mockPreferences.get.mockImplementation(async (call) => {
            const answer = await real?.(call);
            if (armed && (call.key === CONFIG || call.key === MIRROR)) {
                armed = false;
                prefs.set(
                    CONFIG,
                    JSON.stringify({ ...parseJsonObject(prefs.get(CONFIG) ?? '{}'), defaults: { exposure: 42 } }),
                );
                prefs.set(MIRROR, JSON.stringify({ mirroredBy: 'service' }));
            }
            return answer ?? { value: null };
        });

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await settings.flushPendingWrites();

        expect(stored(MIRROR)).toMatchObject({
            theme: 'light',
            challengeSettings: { globalDefaults: { exposure: 42 } },
        });
        expect(stored(MIRROR)).not.toHaveProperty('mirroredBy');
    });

    test("a logout takes the token and the API headers out of the copy of the user's file, by compare-and-write", async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MIRROR]: USER_FILE }, { settled: false });
        expect(settings.setSetting('theme', 'light')).toBe(true);
        await settings.flushPendingWrites();
        expect(prefs.get(ORIGINAL)).toBe(USER_FILE);
        calls = [];

        expect(settings.setSetting('token', '')).toBe(true);
        await settings.flushPendingWrites();

        // (The copy keeps no user name either; the configuration and the live mirror do, for the login form.)
        expect(stored(ORIGINAL)).toEqual({ theme: 'dark', token: '', lastUsername: '', apiHeaders: {} });
        expect(callsTo(ORIGINAL)).toHaveLength(1);
        expect(callsTo(ORIGINAL)[0].expected).toBe(USER_FILE);
        expect(JSON.stringify(cat.info.mock.calls) + JSON.stringify(cat.error.mock.calls)).not.toContain('tok-secret');
    });

    test('is made at the start from what is stored, when it is not the mirror of the configuration', async () => {
        const settings = await appWindow(
            { [CONFIG]: STORED_CONFIG, [MIRROR]: JSON.stringify({ theme: 'light', token: '' }) },
            { settled: false },
        );

        expect(settings.loadSettings().auth.token).toBe('tok-secret');
        await settings.flushPendingWrites();

        expect(stored(MIRROR)).toMatchObject({ theme: 'dark', token: 'tok-secret' });
        expect(prefs.get(ORIGINAL)).toBe(JSON.stringify({ theme: 'light', token: '' }));
    });

    test('is not rewritten at the start when it is the mirror already', async () => {
        await appWindow({ [CONFIG]: STORED_CONFIG });
        const mirrored = prefs.get(MIRROR);
        expect(mirrored).toBeDefined();

        const next = await appWindow(
            { [CONFIG]: prefs.get(CONFIG) ?? '', [MIRROR]: mirrored ?? '' },
            { settled: false },
        );
        next.loadSettings();
        await next.flushPendingWrites();

        expect(callsTo(MIRROR)).toHaveLength(0);
    });

    test('is not written before the stores are read, and not after local data was discarded', async () => {
        g.Capacitor = {
            isNativePlatform: () => true,
            Plugins: { AutoVoteBackground: { compareAndWrite: jest.fn(nativeCompareAndWrite) } },
        };
        prefs.set(CONFIG, STORED_CONFIG);
        const early = loadSettingsModule();
        early.loadSettings();
        await early.flushPendingWrites();
        expect(callsTo(MIRROR)).toHaveLength(0);

        const settings = await appWindow({ [CONFIG]: STORED_CONFIG });
        settings.setSetting('theme', 'light');
        await discardPendingWrites();
        await settings.flushPendingWrites();

        expect(callsTo(MIRROR)).toHaveLength(0);
    });

    test('writes straight to Preferences where there is no native plugin', async () => {
        prefs.set(CONFIG, STORED_CONFIG);
        g.Capacitor = { isNativePlatform: () => true };
        const settings = loadSettingsModule();
        await settings.initializeAsync();
        settings.loadSettings();
        await settings.flushPendingWrites();

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await settings.flushPendingWrites();

        expect(stored(MIRROR)).toMatchObject({ theme: 'light', token: 'tok-secret' });
    });
});

describe('Start fresh in the Android app window', () => {
    const freshStart = async (initial: Record<string, string>) => {
        const settings = await appWindow(initial, { settled: false });
        settings.loadSettings();
        await settings.flushPendingWrites();
        expect(settings.getSettingsRecovery()?.code).toBe('settings-import-failed');
        return settings;
    };
    const unimportable = () => [...prefs.keys()].filter((key) => key.startsWith('gurushots-settings_unimportable-'));

    test('keeps the unimportable file as the original when that is free, before the mirror writes over it', async () => {
        const settings = await freshStart({ [MIRROR]: '{broken' });

        expect(settings.startFresh()).toBe(true);
        settings.loadSettings();
        await settings.flushPendingWrites();
        // The mirror is made on the first read of the configuration once it is stored.
        settings.loadSettings();
        await settings.flushPendingWrites();

        expect(prefs.get(ORIGINAL)).toBe('{broken');
        expect(unimportable()).toEqual([]);
        expect(callsTo(MIRROR)).toHaveLength(1);
        expect(calls.map((call) => call.key).indexOf(ORIGINAL)).toBeLessThan(
            calls.map((call) => call.key).indexOf(MIRROR),
        );
    });

    test('keeps it under a key of its own, named by the time, when the original is taken: that one stays', async () => {
        const settings = await freshStart({ [MIRROR]: '{broken', [ORIGINAL]: USER_FILE });

        expect(settings.startFresh()).toBe(true);
        settings.loadSettings();
        await settings.flushPendingWrites();
        // The mirror is made on the first read of the configuration once it is stored.
        settings.loadSettings();
        await settings.flushPendingWrites();

        // The original is the file as it was: a configuration that merely holds no login is no sign-out.
        expect(prefs.get(ORIGINAL)).toBe(USER_FILE);
        expect(unimportable()).toHaveLength(1);
        expect(prefs.get(unimportable()[0])).toBe('{broken');
        expect(stored(MIRROR)).toMatchObject({ token: '' });
    });

    test('does not let the mirror write while the file could not be kept, and does it with the next save', async () => {
        const settings = await freshStart({ [MIRROR]: '{broken', [ORIGINAL]: USER_FILE });
        const set = mockPreferences.set.getMockImplementation();
        let refusing = true;
        mockPreferences.set.mockImplementation(({ key, value }) =>
            refusing && key.startsWith('gurushots-settings_unimportable-')
                ? Promise.reject(new Error('quota'))
                : (set?.({ key, value }) ?? Promise.resolve()),
        );

        expect(settings.startFresh()).toBe(true);
        settings.loadSettings();
        await settings.flushPendingWrites();

        expect(prefs.get(MIRROR)).toBe('{broken');
        expect(callsTo(MIRROR)).toHaveLength(0);
        expect(unimportable()).toEqual([]);

        refusing = false;
        expect(settings.setSetting('theme', 'light')).toBe(true);
        await settings.flushPendingWrites();

        expect(unimportable()).toHaveLength(1);
        expect(prefs.get(unimportable()[0])).toBe('{broken');
        expect(stored(MIRROR)).toMatchObject({ theme: 'light' });
    });

    test('is refused before the stores are read', async () => {
        g.Capacitor = { isNativePlatform: () => true };
        prefs.set(MIRROR, '{broken');
        const settings = loadSettingsModule();
        settings.loadSettings();

        expect(settings.startFresh()).toBe(false);
        expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('could not be set aside'));
    });

    test('where the original is taken meanwhile by the other context, the copy of its own is made', async () => {
        const settings = await freshStart({ [MIRROR]: '{broken' });
        // The service keeps its own first file between this window's look at the original and its write.
        hook = (call) => {
            if (call.key !== ORIGINAL) return undefined;
            prefs.set(ORIGINAL, USER_FILE);
            return { saved: false, current: USER_FILE };
        };

        expect(settings.startFresh()).toBe(true);
        settings.loadSettings();
        await settings.flushPendingWrites();

        expect(prefs.get(ORIGINAL)).toBe(USER_FILE);
        expect(unimportable()).toHaveLength(1);
    });
});

describe('the mirror in the Android background service', () => {
    const service = (initial: { config?: string | null; legacy?: string | null } = {}) => {
        const store = installHeadlessStore(initial);
        const settings = loadSettingsModule();
        return { store, settings };
    };

    test('is written through the bridge after the configuration, keeping the file first', () => {
        const { store, settings } = service({ config: STORED_CONFIG, legacy: USER_FILE });

        expect(settings.setSetting('theme', 'light')).toBe(true);

        expect(parseJsonObject(store.legacy ?? 'null')).toMatchObject({ theme: 'light', token: 'tok-secret' });
        expect(store.keys.get(ORIGINAL)).toBe(USER_FILE);
    });

    test('is made again from the stored configuration when settings.json changed under the write', () => {
        const { store, settings } = service({ config: STORED_CONFIG, legacy: USER_FILE });
        settings.loadSettings();
        const writes = jest.fn(store.compareAndWriteKey!);
        let conflicts = 1;
        store.compareAndWriteKey = (key, expected, data) => {
            if (key === MIRROR && conflicts-- > 0) {
                // The app window saved a newer configuration, and mirrored it.
                store.value = JSON.stringify({ ...parseJsonObject(store.value ?? '{}'), defaults: { exposure: 42 } });
                store.legacy = JSON.stringify({ mirroredBy: 'window' });
                return false;
            }
            return writes(key, expected, data);
        };

        settings.setSetting('theme', 'light');

        expect(parseJsonObject(store.legacy ?? 'null')).toMatchObject({
            theme: 'light',
            challengeSettings: { globalDefaults: { exposure: 42 } },
        });
    });

    test('is given up after three conflicts, quietly', () => {
        const { store, settings } = service({ config: STORED_CONFIG, legacy: USER_FILE });
        settings.loadSettings();
        // Every time it writes, the other context has mirrored in between.
        store.compareAndWriteKey = (key) => {
            if (key === MIRROR) store.legacy = JSON.stringify({ mirroredBy: Math.random() });
            return key !== MIRROR;
        };

        expect(settings.setSetting('theme', 'light')).toBe(true);

        expect(cat.error).not.toHaveBeenCalled();
        expect(cat.info).toHaveBeenCalledWith(expect.stringContaining('tried again with the next save or start'));
    });

    test('without a bridge that reaches the key, is a failed mirror: logged, the save stands', () => {
        const { store, settings } = service({ config: STORED_CONFIG, legacy: USER_FILE });
        delete store.compareAndWriteKey;

        expect(settings.setSetting('theme', 'light')).toBe(true);

        expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining('could not be brought up to date'));
        expect(store.legacy).toBe(USER_FILE);
    });

    test('a bridge that refuses the blob is a failed mirror, not a conflict', () => {
        const { store, settings } = service({ config: STORED_CONFIG, legacy: USER_FILE });
        settings.loadSettings();
        store.compareAndWriteKey = (key) => key !== MIRROR;

        expect(settings.setSetting('theme', 'light')).toBe(true);

        expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining('could not be brought up to date'));
        expect(cat.info).not.toHaveBeenCalledWith(expect.stringContaining('kept changing'));
    });
});

describe('the compare-and-overwrite of a settings file in the Android background service', () => {
    test('is a failed write without a bridge to reach the configuration through', () => {
        (globalThis as typeof globalThis & { __GS_HEADLESS__?: boolean }).__GS_HEADLESS__ = true;
        const settings = loadSettingsModule();
        void settings;
        const { storage } = require('../../../src/ts/settings/storage') as typeof storageModule;

        expect(storage.overwriteIf(null, '{}')).toBe('failed');
    });

    test('refuses a text the key no longer holds, before it writes anything', () => {
        const store = installHeadlessStore({ legacy: USER_FILE });
        loadSettingsModule();
        const { legacyStorage } = require('../../../src/ts/settings/storage') as typeof storageModule;

        expect(legacyStorage.overwriteIf('{"other":true}', '{}')).toBe('conflict');
        expect(store.legacy).toBe(USER_FILE);
    });
});

describe('Start fresh in the Android background service', () => {
    test('keeps the unimportable file as the original when that is free', () => {
        const store = installHeadlessStore({ legacy: '{broken' });
        const settings = loadSettingsModule();
        settings.loadSettings();
        expect(settings.getSettingsRecovery()?.code).toBe('settings-import-failed');

        expect(settings.startFresh()).toBe(true);

        expect(store.keys.get(ORIGINAL)).toBe('{broken');
    });

    test('cannot keep a copy of its own where the original is taken, so it writes nothing', () => {
        const store = installHeadlessStore({ legacy: '{broken' });
        store.keys.set(ORIGINAL, USER_FILE);
        const settings = loadSettingsModule();
        settings.loadSettings();

        expect(settings.startFresh()).toBe(false);

        expect(store.value).toBeNull();
        expect(store.legacy).toBe('{broken');
        expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('could not be set aside'));
    });
});

describe('reading the stored configuration without moving what the next write rests on, in the Android background service', () => {
    const storageOf = () => {
        loadSettingsModule();
        return (require('../../../src/ts/settings/storage') as typeof storageModule).storage;
    };

    test('is the keyed read where the bridge has one, and leaves the dedicated read alone', () => {
        const store = installHeadlessStore({ config: STORED_CONFIG });
        const storage = storageOf();

        expect(storage.peekRaw()).toBe(STORED_CONFIG);
        expect(store.read).not.toHaveBeenCalled();
    });

    test('is the dedicated read where the bridge has no keyed one, and nothing where there is no bridge', () => {
        const store = installHeadlessStore({ config: STORED_CONFIG });
        delete store.readKey;
        const storage = storageOf();
        expect(storage.peekRaw()).toBe(STORED_CONFIG);
        expect(store.read).toHaveBeenCalledTimes(1);

        removeHeadlessStore();
        (globalThis as typeof globalThis & { __GS_HEADLESS__?: boolean }).__GS_HEADLESS__ = true;
        expect(storage.peekRaw()).toBeNull();
    });
});
