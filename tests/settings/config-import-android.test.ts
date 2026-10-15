/**
 * The one-time import on Android: in the app window (Preferences behind a cache, which must have been hydrated before
 * the import can read anything) and in the background service (the native store; the compare-and-write of the
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
const mockPreferences = {
    set: jest.fn<Promise<void>, [{ key: string; value: string }]>(() => Promise.resolve()),
    get: jest.fn<Promise<{ value: string | null }>, [{ key: string }]>(() => Promise.resolve({ value: null })),
    remove: jest.fn<Promise<void>, [{ key: string }]>(() => Promise.resolve()),
    keys: jest.fn<Promise<{ keys: string[] }>, []>(() => Promise.resolve({ keys: [] })),
};
jest.mock('@capacitor/preferences', () => ({ Preferences: mockPreferences }), { virtual: true });

import type * as settingsModule from '../../src/ts/settings';
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

afterEach(() => {
    delete g.Capacitor;
    removeHeadlessStore();
    jest.clearAllMocks();
    mockPreferences.get.mockImplementation(() => Promise.resolve({ value: null }));
});

describe('the import in the Android app window', () => {
    beforeEach(() => {
        g.Capacitor = { isNativePlatform: () => true };
    });

    test('waits for the stored settings to be read, and is not held against a later read', async () => {
        mockPreferences.get.mockImplementation(({ key }) =>
            Promise.resolve({ value: key === 'gurushots-settings' ? ONE_X : null }),
        );
        const settings = loadSettingsModule();

        // Before the window has hydrated, nothing can be read: saves are refused, but the failure is not remembered.
        expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
        expect(settings.getSettingsRecovery()).toEqual({
            code: 'settings-import-failed',
            path: 'gurushots-settings',
            blocking: true,
        });
        expect(settings.setSetting('theme', 'light')).toBe(false);

        await settings.initializeAsync();

        expect(settings.loadSettings().app.theme).toBe('dark');
        expect(settings.getSettingsRecovery()).toBeNull();
        expect(settings.getTitlePins()).toEqual({ '7': 'Macro' });
        await settings.flushPendingWrites();
        const saved = new Map(mockPreferences.set.mock.calls.map(([call]) => [call.key, call.value]));
        expect(parseJsonObject(saved.get('gurushots-config') ?? 'null')).toMatchObject({ version: 2 });
        expect(saved.has('gs_v2_import')).toBe(true);
        expect(parseJsonObject(saved.get('gurushots-settings') ?? 'null')).toMatchObject({ theme: 'dark', token: '' });
    });
});

describe('the settings.json the Android import was made from', () => {
    const latest = () => {
        const saved = new Map<string, string>();
        for (const [call] of mockPreferences.set.mock.calls) saved.set(call.key, call.value);
        return saved;
    };
    const importedHash = () => {
        const { imported } = parseJsonObject(latest().get('gurushots-config') ?? '{}');
        return typeof imported === 'object' && imported !== null && 'sha256' in imported ? imported.sha256 : undefined;
    };

    beforeEach(() => {
        g.Capacitor = { isNativePlatform: () => true };
    });

    test('its hash is stored with the import, and a change made later raises the notice at the next start', async () => {
        mockPreferences.get.mockImplementation(({ key }) =>
            Promise.resolve({ value: key === 'gurushots-settings' ? ONE_X : null }),
        );
        const first = loadSettingsModule();
        await first.initializeAsync();
        first.loadSettings();
        for (let attempt = 0; attempt < 200 && !/^[0-9a-f]{64}$/.test(`${importedHash()}`); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            await first.flushPendingWrites();
        }
        expect(importedHash()).toMatch(/^[0-9a-f]{64}$/);

        // The next start: the same stores, and a settings.json that was edited meanwhile.
        const saved = latest();
        const edited = JSON.stringify({ ...parseJsonObject(ONE_X), theme: 'light' });
        mockPreferences.get.mockImplementation(({ key }) =>
            Promise.resolve({ value: key === 'gurushots-settings' ? edited : (saved.get(key) ?? null) }),
        );
        const next = loadSettingsModule();
        await next.initializeAsync();
        await next.checkLegacyDrift();

        expect(next.getSettingsRecovery()).toEqual({
            code: 'settings-v1-changed',
            path: 'gurushots-settings',
            blocking: false,
        });
        expect(next.setSetting('theme', 'light')).toBe(true);
    });
});

describe('the import in the Android app window is done only once its configuration is stored', () => {
    const hydrated = async () => {
        mockPreferences.get.mockImplementation(({ key }) =>
            Promise.resolve({ value: key === 'gurushots-settings' ? ONE_X : null }),
        );
        const settings = loadSettingsModule();
        await settings.initializeAsync();
        return settings;
    };
    const savedKeys = () => mockPreferences.set.mock.calls.map(([call]) => call.key);

    beforeEach(() => {
        g.Capacitor = { isNativePlatform: () => true };
    });

    test('a configuration the store refuses leaves no marker and the sign-in state in settings.json; the next try imports again', async () => {
        const settings = await hydrated();
        mockPreferences.set.mockImplementation(({ key }) =>
            key === 'gurushots-config' ? Promise.reject(new Error('disk full')) : Promise.resolve(),
        );

        // The cache shows the import at once...
        expect(settings.loadSettings().app.theme).toBe('dark');
        await settings.flushPendingWrites();

        // ... and when the store turns it down, nothing says it is done, and nothing is saved over what is left.
        expect(savedKeys()).not.toContain('gs_v2_import');
        expect(savedKeys()).not.toContain('gurushots-settings');
        expect(settings.getSettingsRecovery()).toEqual({
            code: 'settings-import-failed',
            path: 'gurushots-settings',
            blocking: true,
        });
        expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
        expect(settings.setSetting('theme', 'light')).toBe(false);

        // The user's retry (or the next start, which finds no marker) imports again, and this time it lands.
        mockPreferences.set.mockImplementation(() => Promise.resolve());
        expect(settings.retryImport()).toBe(true);
        await settings.flushPendingWrites();

        expect(settings.getSettingsRecovery()).toBeNull();
        expect(settings.loadSettings().app.theme).toBe('dark');
        expect(savedKeys()).toContain('gs_v2_import');
        const blanked = mockPreferences.set.mock.calls.find(([call]) => call.key === 'gurushots-settings');
        expect(parseJsonObject(blanked?.[0].value ?? 'null')).toMatchObject({ theme: 'dark', token: '' });
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
        // What the winner imported is the same 1.x file: this context's marker and blanking only repeat its own.
        expect(savedKeys()).toContain('gs_v2_import');
    });
});

describe('importing again in the Android app window before it has read the stored settings', () => {
    test('has nothing to import yet and changes nothing', () => {
        g.Capacitor = { isNativePlatform: () => true };
        const settings = loadSettingsModule();

        expect(settings.reimportFromV1()).toBe(false);
        expect(mockPreferences.set).not.toHaveBeenCalled();
    });
});

describe('the import in the Android background service', () => {
    test('imports into the native store: the configuration, the pins and the marker, with the sign-in state blanked', () => {
        const store = installHeadlessStore({ legacy: ONE_X });
        const settings = loadSettingsModule();

        expect(settings.loadSettings().app.theme).toBe('dark');

        expect(parseJsonObject(store.value ?? 'null')).toMatchObject({ version: 2, auth: { token: 'tok-secret' } });
        expect(store.keys.get('gs_title_pins')).toBe('{\n  "7": "Macro"\n}');
        expect(store.keys.has('gs_v2_import')).toBe(true);
        expect(parseJsonObject(store.legacy ?? 'null')).toMatchObject({ theme: 'dark', token: '' });
    });

    test('adopts the configuration the app window saved first, and leaves settings.json alone', () => {
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
        expect(parseJsonObject(store.legacy ?? 'null')).toMatchObject({ token: 'tok-secret' });
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

    test('fails, saying the configuration could not be saved, and marks and blanks nothing', () => {
        const store = refusing();
        const settings = loadSettingsModule();

        settings.loadSettings();

        expect(settings.getSettingsRecovery()).toEqual({
            code: 'settings-import-failed',
            path: 'gurushots-settings',
            blocking: true,
        });
        expect(store.keys.has('gs_v2_import')).toBe(false);
        expect(parseJsonObject(store.legacy ?? 'null')).toMatchObject({ token: 'tok-secret' });
    });

    test('starting fresh fails the same way', () => {
        refusing();
        const settings = loadSettingsModule();
        settings.loadSettings();

        expect(settings.startFresh()).toBe(false);
    });

    test('starting fresh on a store that takes it writes the defaults and the marker', () => {
        const store = installHeadlessStore({ legacy: '{broken' });
        const settings = loadSettingsModule();
        settings.loadSettings();
        expect(settings.getSettingsRecovery()?.code).toBe('settings-import-failed');

        expect(settings.startFresh()).toBe(true);

        expect(parseJsonObject(store.value ?? 'null')).toMatchObject({ version: 2 });
        expect(store.keys.has('gs_v2_import')).toBe(true);
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

describe('importing again in the Android background service', () => {
    test('cannot set the configuration in use aside, so it changes nothing', () => {
        const config = JSON.stringify({ app: { theme: 'light' } });
        const store = installHeadlessStore({ config, legacy: ONE_X });
        const settings = loadSettingsModule();
        settings.loadSettings();

        expect(settings.reimportFromV1()).toBe(false);

        expect(store.value).toBe(config);
        expect(settings.loadSettings().app.theme).toBe('light');
    });
});
