/**
 * The import on Android: in the app window (Preferences behind a cache, which must have been hydrated before the
 * import can read anything) and in the background service (the native store; the compare-and-write of the
 * configuration decides which context imports first).
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
// What Preferences holds: the mock reads and writes it, so the app window sees what it saved.
const prefs = new Map<string, string>();
const mockPreferences = {
    set: jest.fn<Promise<void>, [{ key: string; value: string }]>(({ key, value }) => {
        prefs.set(key, value);
        return Promise.resolve();
    }),
    get: jest.fn<Promise<{ value: string | null }>, [{ key: string }]>(({ key }) =>
        Promise.resolve({ value: prefs.get(key) ?? null }),
    ),
    remove: jest.fn<Promise<void>, [{ key: string }]>(({ key }) => {
        prefs.delete(key);
        return Promise.resolve();
    }),
    keys: jest.fn<Promise<{ keys: string[] }>, []>(() => Promise.resolve({ keys: [...prefs.keys()] })),
};
jest.mock('@capacitor/preferences', () => ({ Preferences: mockPreferences }), { virtual: true });

import type * as settingsModule from '../../src/ts/settings';
import type * as intentProfilesModule from '../../src/ts/settings/intentProfiles';
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import { parseJsonObject } from '../helpers/parseJson';

const g = globalThis as typeof globalThis & {
    Capacitor?: { isNativePlatform: () => boolean; Plugins?: Record<string, unknown> };
};

const ONE_X = JSON.stringify({
    theme: 'dark',
    token: 'tok-secret',
    challengeSettings: { titlePins: { '7': 'Macro' } },
});

const loadSettingsModule = () => {
    let mod: typeof settingsModule | undefined;
    jest.isolateModules(() => {
        mod = require('../../src/ts/settings') as typeof settingsModule;
    });
    return mod!;
};

const useMemoryPreferences = () => {
    mockPreferences.set.mockImplementation(({ key, value }) => {
        prefs.set(key, value);
        return Promise.resolve();
    });
    mockPreferences.get.mockImplementation(({ key }) => Promise.resolve({ value: prefs.get(key) ?? null }));
};

afterEach(() => {
    delete g.Capacitor;
    removeHeadlessStore();
    jest.clearAllMocks();
    prefs.clear();
    useMemoryPreferences();
});

// Lets the saves that wait their turn (the pins and the marker, written against what is stored) land.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const savedKeys = () => mockPreferences.set.mock.calls.map(([call]) => call.key);
const saved = (key: string) => parseJsonObject(prefs.get(key) ?? 'null');

describe('the import in the Android app window', () => {
    beforeEach(() => {
        g.Capacitor = { isNativePlatform: () => true };
    });

    test('waits for the stored settings to be read, and is not held against a later read', async () => {
        prefs.set('gurushots-settings', ONE_X);
        let settings!: typeof settingsModule;
        let cat!: Record<'error' | 'warning', jest.Mock<void, [string, ...unknown[]]>>;
        jest.isolateModules(() => {
            settings = require('../../src/ts/settings') as typeof settingsModule;
            cat = (require('../../src/ts/logger') as unknown as { __cat: typeof cat }).__cat;
        });

        // Before the window has hydrated, nothing can be read: the defaults answer, it is no import failure (nothing
        // blocking, nothing at error level, nothing remembered), and a save is refused so it cannot replace what is stored.
        expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
        expect(settings.getSettingsRecovery()).toBeNull();
        expect(settings.setSetting('theme', 'light')).toBe(false);
        expect(cat.error).not.toHaveBeenCalled();
        expect(cat.warning).toHaveBeenCalledWith('Not saving settings: the stored settings have not been read yet');
        expect(savedKeys()).toEqual([]);

        await settings.initializeAsync();

        expect(settings.loadSettings().app.theme).toBe('dark');
        expect(settings.getSettingsRecovery()).toBeNull();
        await settings.flushPendingWrites();
        await settle();
        // The pins are saved against what is stored, so the cache shows them once they are.
        expect(settings.getTitlePins()).toEqual({ '7': 'Macro' });
        expect(saved('gurushots-config')).toMatchObject({ version: 2 });
        expect(prefs.has('gs_v2_import')).toBe(true);
        // settings.json is left as the user had it: nothing is written back to it.
        expect(prefs.get('gurushots-settings')).toBe(ONE_X);
        expect(savedKeys()).not.toContain('gurushots-settings');
    });
});

describe('a damaged configuration in the Android app window', () => {
    beforeEach(() => {
        g.Capacitor = { isNativePlatform: () => true };
    });

    test('is set aside by a queued copy; when the store refuses it, saves are refused until a read tries again', async () => {
        prefs.set('gurushots-config', '{broken');
        const settings = loadSettingsModule();
        await settings.initializeAsync();
        const realSet = mockPreferences.set.getMockImplementation();
        mockPreferences.set.mockImplementation(({ key, value }) => {
            if (key.startsWith('gurushots-config_corrupt')) return Promise.reject(new Error('disk full'));
            prefs.set(key, value);
            return Promise.resolve();
        });
        const told: string[] = [];
        settings.onSettingsRecoveryChange(() => {
            told.push(settings.getSettingsRecovery()?.code ?? 'none');
        });

        expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
        await settings.flushPendingWrites();
        await new Promise((resolve) => setTimeout(resolve, 0));
        // The copy was refused: the damaged text is still what is stored, and saving is refused.
        expect(settings.getSettingsRecovery()).toEqual({
            code: 'settings-unreadable',
            path: 'gurushots-config',
            blocking: true,
        });
        expect(told).toEqual(['settings-unreadable']);
        expect(settings.setSetting('theme', 'light')).toBe(false);
        expect(prefs.get('gurushots-config')).toBe('{broken');

        // The store takes the copy again: the next read sets it aside, and the notice says where it went.
        mockPreferences.set.mockImplementation(realSet);
        settings.loadSettings();
        await settings.flushPendingWrites();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(settings.getSettingsRecovery()).toEqual({
            code: 'settings-corrupt',
            path: expect.stringContaining('gurushots-config_corrupt-'),
            blocking: false,
        });
        expect(prefs.get('gurushots-config')).toBeUndefined();
        expect(settings.setSetting('theme', 'light')).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(told).toEqual(['settings-unreadable', 'settings-corrupt']);
    });

    test('a copy the store refuses is said in the log when no window listens', async () => {
        prefs.set('gurushots-config', '{broken');
        const settings = loadSettingsModule();
        await settings.initializeAsync();
        mockPreferences.set.mockImplementation(({ key, value }) => {
            if (key.startsWith('gurushots-config_corrupt')) return Promise.reject(new Error('disk full'));
            prefs.set(key, value);
            return Promise.resolve();
        });

        settings.loadSettings();
        await settings.flushPendingWrites();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(settings.getSettingsRecovery()?.code).toBe('settings-unreadable');
    });

    test('an import that cannot pass stores the defaults and the marker once the queued write lands', async () => {
        prefs.set('gurushots-settings', '{broken');
        const settings = loadSettingsModule();
        await settings.initializeAsync();

        settings.loadSettings();
        await settings.flushPendingWrites();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(parseJsonObject(prefs.get('gurushots-config') ?? 'null')).toMatchObject({
            imported: { failure: { reason: 'corrupt' } },
        });
        expect(parseJsonObject(prefs.get('gs_v2_import') ?? 'null')).toEqual({ importedAt: expect.any(String) });
        expect(settings.getSettingsRecovery()).toEqual({
            code: 'settings-import-failed',
            path: 'gurushots-settings',
            blocking: false,
            detail: 'corrupt',
        });
    });

    test('an import that cannot pass stores the defaults; when their write is refused, the marker is not written and the next start tries the import again', async () => {
        prefs.set('gurushots-settings', '{broken');
        const settings = loadSettingsModule();
        await settings.initializeAsync();
        mockPreferences.set.mockImplementation(({ key, value }) => {
            if (key === 'gurushots-config') return Promise.reject(new Error('disk full'));
            prefs.set(key, value);
            return Promise.resolve();
        });

        settings.loadSettings();
        await settings.flushPendingWrites();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Nothing says the import is done, so the next start tries it again; this process answers the settled
        // notice and lets saves through (the next successful write stores the settings).
        expect(prefs.has('gs_v2_import')).toBe(false);
        expect(settings.getSettingsRecovery()).toEqual({
            code: 'settings-import-failed',
            path: 'gurushots-settings',
            blocking: false,
            detail: 'corrupt',
        });
    });
});

describe('the intent profiles in the Android app window', () => {
    beforeEach(() => {
        g.Capacitor = { isNativePlatform: () => true };
    });

    test('seeding before the stored settings are read stores nothing; seeding after it stores every profile', async () => {
        prefs.set('gurushots-settings', ONE_X);
        const settings = loadSettingsModule();

        settings.seedIntentProfiles();
        expect(savedKeys()).toEqual([]);
        expect(settings.getSettingsRecovery()).toBeNull();

        await settings.initializeAsync();
        expect(settings.seedIntentProfiles()).toBe(true);
        await settings.flushPendingWrites();

        const stored = saved('gurushots-config');
        const { INTENT_PROFILES } = require('../../src/ts/settings/intentProfiles') as typeof intentProfilesModule;
        expect(Object.keys(settings.getChallengeProfiles()).sort()).toEqual(
            INTENT_PROFILES.map((intent) => intent.name).sort(),
        );
        expect(stored).toMatchObject({ version: 2 });
        expect(settings.loadSettings().app.theme).toBe('dark');
    });
});

describe('the import in the Android app window is done only once its configuration is stored', () => {
    const hydrated = async () => {
        prefs.set('gurushots-settings', ONE_X);
        const settings = loadSettingsModule();
        await settings.initializeAsync();
        return settings;
    };

    beforeEach(() => {
        g.Capacitor = { isNativePlatform: () => true };
    });

    test('a configuration the store refuses leaves no marker and settings.json as it was; the next try imports again', async () => {
        const settings = await hydrated();
        mockPreferences.set.mockImplementation(({ key, value }) => {
            if (key === 'gurushots-config') return Promise.reject(new Error('disk full'));
            prefs.set(key, value);
            return Promise.resolve();
        });

        const told: string[] = [];
        settings.onSettingsRecoveryChange(() => {
            told.push(settings.getSettingsRecovery()?.code ?? 'none');
        });
        // The cache shows the import at once...
        expect(settings.loadSettings().app.theme).toBe('dark');
        await settings.flushPendingWrites();

        // ... and when the store turns it down, nothing says it is done, and nothing is saved over what is left.
        expect(savedKeys()).not.toContain('gs_v2_import');
        expect(told).toEqual(['settings-import-failed']);
        expect(settings.getSettingsRecovery()).toEqual({
            code: 'settings-import-failed',
            path: 'gurushots-settings',
            blocking: true,
        });
        expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
        expect(settings.setSetting('theme', 'light')).toBe(false);

        // The user's retry (or the next start, which finds no marker) imports again, and this time it lands.
        useMemoryPreferences();
        expect(settings.retryImport()).toBe(true);
        await settings.flushPendingWrites();
        await new Promise((resolve) => setTimeout(resolve, 0));
        // The late failure of the first attempt, which this one has replaced, says nothing of the state now.
        await settings.flushPendingWrites();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(settings.getSettingsRecovery()).toBeNull();
        expect(settings.loadSettings().app.theme).toBe('dark');
        await settings.flushPendingWrites();
        expect(savedKeys()).toContain('gs_v2_import');
        expect(prefs.get('gurushots-settings')).toBe(ONE_X);
    });

    test('a blob past the size the native store takes fails the import the same way', async () => {
        const settings = await hydrated();
        const tooLarge = Object.assign(new Error('too large'), { code: 'too-large' });
        g.Capacitor = {
            isNativePlatform: () => true,
            Plugins: { AutoVoteBackground: { compareAndWrite: jest.fn(() => Promise.reject(tooLarge)) } },
        };

        settings.loadSettings();
        await settings.flushPendingWrites();

        expect(settings.getSettingsRecovery()?.code).toBe('settings-import-failed');
        expect(savedKeys()).not.toContain('gs_v2_import');
    });

    test('losing the race to the background service adopts its configuration and writes nothing over it', async () => {
        const settings = await hydrated();
        const service = JSON.stringify({ version: 2, app: { theme: 'light' } });
        const compareAndWrite = jest.fn((call: { key: string }) =>
            Promise.resolve(
                call.key === 'gurushots-config' ? { saved: false, current: service } : { saved: true, current: null },
            ),
        );
        g.Capacitor = { isNativePlatform: () => true, Plugins: { AutoVoteBackground: { compareAndWrite } } };

        expect(settings.loadSettings().app.theme).toBe('dark');
        await settings.flushPendingWrites();

        expect(compareAndWrite.mock.calls.filter(([call]) => call.key === 'gurushots-config')).toHaveLength(1);
        expect(savedKeys()).not.toContain('gurushots-config');
        expect(settings.getSettingsRecovery()).toBeNull();
        expect(settings.loadSettings().app.theme).toBe('light');
        await settle();
        // What the winner imported is the same file: this context's marker only repeats its own.
        expect(compareAndWrite.mock.calls.map(([call]) => call.key)).toContain('gs_v2_import');
    });
});

describe('retrying the import in the Android app window before it has read the stored settings', () => {
    test('has nothing to read yet and changes nothing', () => {
        g.Capacitor = { isNativePlatform: () => true };
        prefs.set('gurushots-settings', ONE_X);
        const settings = loadSettingsModule();

        expect(settings.retryImport()).toBe(false);
        expect(mockPreferences.set).not.toHaveBeenCalled();
    });
});

describe('the import in the Android background service', () => {
    test('imports into the native store: the configuration, the pins and the marker; settings.json is left as it is', () => {
        const store = installHeadlessStore({ legacy: ONE_X });
        const settings = loadSettingsModule();

        expect(settings.loadSettings().app.theme).toBe('dark');

        expect(parseJsonObject(store.value ?? 'null')).toMatchObject({ version: 2, auth: { token: 'tok-secret' } });
        expect(store.keys.get('gs_title_pins')).toBe('{\n  "7": "Macro"\n}');
        expect(store.keys.has('gs_v2_import')).toBe(true);
        expect(store.legacy).toBe(ONE_X);
        expect(parseJsonObject(store.keys.get('gs_v2_import') ?? 'null')).toHaveProperty('importedAt');
    });

    test('adopts the configuration the app window saved first, and writes nothing over settings.json', () => {
        const store = installHeadlessStore({ legacy: ONE_X });
        const settings = loadSettingsModule();
        // The window's import lands between this context's read of the configuration and its write.
        const readKey = store.readKey!;
        store.readKey = (key) => {
            if (key === 'gurushots-settings') store.value = JSON.stringify({ app: { theme: 'light' } });
            return readKey(key);
        };

        expect(settings.loadSettings().app.theme).toBe('light');

        expect(settings.getSettingsRecovery()).toBeNull();
        expect(store.keys.has('gs_v2_import')).toBe(false);
        expect(store.legacy).toBe(ONE_X);
    });
});

describe('an import the Android native store does not take', () => {
    const refusing = () => {
        const store = installHeadlessStore({ legacy: ONE_X });
        store.write.mockImplementation(() => {
            throw new Error('commit failed');
        });
        return store;
    };

    test('fails, saying the configuration could not be saved, and marks nothing and leaves settings.json as it is', () => {
        const store = refusing();
        const settings = loadSettingsModule();

        settings.loadSettings();

        expect(settings.getSettingsRecovery()).toEqual({
            code: 'settings-import-failed',
            path: 'gurushots-settings',
            blocking: true,
        });
        expect(store.keys.has('gs_v2_import')).toBe(false);
        expect(store.legacy).toBe(ONE_X);
    });

    test('starting fresh fails the same way', () => {
        refusing();
        const settings = loadSettingsModule();
        settings.loadSettings();

        expect(settings.startFresh()).toBe(false);
    });

    test('starting fresh on a store that takes it writes the defaults and the marker, and leaves the blob as it is', () => {
        const store = installHeadlessStore({ legacy: '{broken' });
        const settings = loadSettingsModule();
        // The blob cannot be imported: the defaults were stored with the failure, and the import is not tried again.
        settings.loadSettings();
        expect(settings.getSettingsRecovery()).toEqual({
            code: 'settings-import-failed',
            path: 'gurushots-settings',
            blocking: false,
            detail: 'corrupt',
        });
        expect(parseJsonObject(store.value ?? 'null')).toMatchObject({
            version: 2,
            imported: { failure: { reason: 'corrupt' } },
        });
        expect(parseJsonObject(store.keys.get('gs_v2_import') ?? 'null')).toEqual({
            importedAt: expect.any(String),
        });

        // Start fresh finds the defaults in place and resets nothing.
        expect(settings.startFresh()).toBe(true);
        expect(settings.setSetting('theme', 'light')).toBe(true);
        // The blob was never written over.
        expect(store.legacy).toBe('{broken');
    });
});

describe('starting fresh in the Android background service', () => {
    test('finds the configuration the app window saved first and leaves it as it is', () => {
        const store = installHeadlessStore({ legacy: '{broken' });
        const settings = loadSettingsModule();
        settings.loadSettings();
        expect(settings.getSettingsRecovery()?.code).toBe('settings-import-failed');
        // The window's configuration lands between this context's read and its write.
        store.write.mockImplementationOnce(() => {
            store.value = JSON.stringify({ version: 2, app: { theme: 'light' } });
            return false;
        });

        expect(settings.startFresh()).toBe(true);

        expect(store.keys.has('gs_v2_import')).toBe(true);
        expect(settings.loadSettings().app.theme).toBe('light');
    });
});
