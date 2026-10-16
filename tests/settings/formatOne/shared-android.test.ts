/**
 * What the app window and the background service share on Android, and neither may erase in the other: the title pins
 * and the import marker are changed against what is stored when the write is made (the native compare-and-write), never
 * written whole from the window's cache; the mirror carries the stored pins. The sign-in an older build changed in
 * settings.json is taken over in both contexts, a logout clears the set-aside copies (Preferences keys), and the
 * settings.json the configuration could not be restored from is set aside before it is mirrored over.
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
import type * as formatOneMirrorModule from '../../../src/ts/settings/formatOneMirror';
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

// The storage of the module graph the last settings module was loaded in (the one its saves go through).
let storageApi: typeof storageModule;
let mirrorApi: typeof formatOneMirrorModule;

const loadSettingsModule = () => {
    let mod: typeof settingsModule | undefined;
    jest.isolateModules(() => {
        mod = require('../../../src/ts/settings') as typeof settingsModule;
        storageApi = require('../../../src/ts/settings/storage') as typeof storageModule;
        mirrorApi = require('../../../src/ts/settings/formatOneMirror') as typeof formatOneMirrorModule;
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

const PINS = 'gs_title_pins';
const MARKER = 'gs_v2_import';
const MARKER_TEXT = '{"importedAt":"2026-10-01T00:00:00.000Z"}';
const RECORD = { at: '2026-10-01T00:00:00.000Z', report: { refsBlocked: [] }, acknowledged: false };

// Lets the saves that wait their turn (the pins and the marker, written against what is stored) land, and what they set off.
const drain = async (settings: typeof settingsModule) => {
    for (let round = 0; round < 6; round++) {
        await settings.flushPendingWrites();
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

describe('the title pins in the Android app window', () => {
    test('a pin the service saved after the window started is kept when the window pins another title, and the mirror carries both', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MARKER]: MARKER_TEXT });
        expect(settings.getTitlePins()).toEqual({});
        // The service pins a title after the window read the pins: the window's cache holds none.
        prefs.set(PINS, JSON.stringify({ '7': 'Sunsets' }));

        expect(settings.mergeTitlePins({ '8': 'Dusk' })).toBe(true);
        await drain(settings);

        expect(stored(PINS)).toEqual({ '7': 'Sunsets', '8': 'Dusk' });
        // The write rested on what the window knew (nothing), was refused, and was made again on what is stored.
        expect(callsTo(PINS).map((call) => call.expected)).toEqual([null, JSON.stringify({ '7': 'Sunsets' })]);
        expect(settings.getTitlePins()).toEqual({ '7': 'Sunsets', '8': 'Dusk' });
        expect(stored(MIRROR)).toMatchObject({
            challengeSettings: { titlePins: { '7': 'Sunsets', '8': 'Dusk' } },
        });
    });

    test('the mirror of a configuration save carries the pins stored now, not the window cache', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MARKER]: MARKER_TEXT });
        prefs.set(PINS, JSON.stringify({ '7': 'Sunsets' }));

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await drain(settings);

        expect(stored(MIRROR)).toMatchObject({ theme: 'light', challengeSettings: { titlePins: { '7': 'Sunsets' } } });
    });

    test('a pin that cannot be saved is logged and the window goes on', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MARKER]: MARKER_TEXT });
        hook = (call) => (call.key === PINS ? Promise.reject(new Error('quota')) : undefined);

        expect(settings.mergeTitlePins({ '8': 'Dusk' })).toBe(true);
        await drain(settings);

        expect(prefs.has(PINS)).toBe(false);
        expect(cat.error).toHaveBeenCalledWith('Could not save the title pins', null);
    });

    test('the pins of an import are saved against what the service stored since the window started', async () => {
        const settings = await appWindow(
            { [MIRROR]: JSON.stringify({ theme: 'dark', challengeSettings: { titlePins: { '9': 'Old' } } }) },
            { settled: false },
        );
        prefs.set(PINS, JSON.stringify({ '7': 'Sunsets' }));

        settings.loadSettings();
        await drain(settings);

        expect(stored(PINS)).toEqual({ '7': 'Sunsets', '9': 'Old' });
    });

    test('a reset forgets every pin, whatever the window knew', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MARKER]: MARKER_TEXT });
        prefs.set(PINS, JSON.stringify({ '7': 'Sunsets' }));

        expect(settings.resetAllSettings()).toBe(true);
        await drain(settings);

        expect(stored(PINS)).toEqual({});
    });
});

describe('the import marker in the Android app window', () => {
    const withReport = JSON.stringify({ ...parseJsonObject(STORED_CONFIG), imported: RECORD });

    test('what the service recorded after the window started is kept when the window acknowledges the report', async () => {
        const settings = await appWindow(
            { [CONFIG]: withReport, [MARKER]: JSON.stringify({ importedAt: RECORD.at, importedRecord: RECORD }) },
            { settled: false },
        );
        // The service starts the mirror and records it, after the window read the marker.
        prefs.set(
            MARKER,
            JSON.stringify({
                importedAt: RECORD.at,
                importedRecord: RECORD,
                mirrorStartedAt: '2026-10-02T00:00:00.000Z',
                signInPending: 'abc',
                signInConfirmed: 'abc',
            }),
        );

        expect(settings.acknowledgeImportReport()).toBe(true);
        await drain(settings);

        expect(stored(MARKER)).toMatchObject({
            mirrorStartedAt: '2026-10-02T00:00:00.000Z',
            importedRecord: { acknowledged: true },
        });
    });

    test('the import record the service kept is not dropped when the window records the mirror', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MARKER]: MARKER_TEXT }, { settled: false });
        prefs.set(MARKER, JSON.stringify({ importedAt: RECORD.at, importedRecord: RECORD }));

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await drain(settings);

        expect(stored(MARKER)).toMatchObject({
            importedRecord: RECORD,
            mirrorStartedAt: expect.any(String),
            signInConfirmed: expect.any(String),
        });
    });

    test('a window whose cache does not show the mirror started still sees it in the stored marker, and keeps no second copy of the file', async () => {
        const settings = await appWindow(
            { [CONFIG]: STORED_CONFIG, [MIRROR]: USER_FILE, [MARKER]: MARKER_TEXT },
            { settled: false },
        );
        // The service has mirrored since the window read the marker.
        prefs.set(MARKER, JSON.stringify({ importedAt: RECORD.at, mirrorStartedAt: '2026-10-02T00:00:00.000Z' }));
        prefs.set(MIRROR, JSON.stringify({ theme: 'other' }));

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await drain(settings);

        expect(prefs.has(ORIGINAL)).toBe(false);
        expect(stored(MIRROR)).toMatchObject({ theme: 'light' });
    });
});

describe('the sign-in an older build changed in settings.json, on Android', () => {
    const SIGNED_OUT = JSON.stringify({ theme: 'light', token: '', apiHeaders: {}, lastUsername: 'me' });

    test('in the app window: a sign-out stays, and nothing else is taken back', async () => {
        await appWindow({ [CONFIG]: STORED_CONFIG, [MARKER]: MARKER_TEXT });
        expect(stored(MARKER)).toHaveProperty('signInConfirmed');
        // An older build signs out (and changes a setting) in settings.json; the app starts again.
        prefs.set(MIRROR, SIGNED_OUT);
        const settings = await appWindow({ [MARKER]: prefs.get(MARKER) ?? '' }, { settled: false });

        // The window's mirror is queued: it adopts the sign-out when its turn comes, and the next read has it.
        settings.loadSettings();
        await drain(settings);
        expect(settings.loadSettings().auth).toMatchObject({ token: '', apiHeaders: {} });

        expect(stored(CONFIG).auth).toMatchObject({ token: '', apiHeaders: {} });
        expect(stored(CONFIG).app).toMatchObject({ theme: 'dark' });
        expect(stored(MIRROR)).toMatchObject({ theme: 'dark', token: '' });
        expect(cat.info).toHaveBeenCalledWith('The sign-in in settings.json was changed by an older build; it is kept');
    });

    test('in the background service: another account is adopted', () => {
        const store = installHeadlessStore({ config: STORED_CONFIG, legacy: USER_FILE });
        store.keys.set(MARKER, MARKER_TEXT);
        loadSettingsModule().setSetting('theme', 'light');
        expect(parseJsonObject(store.keys.get(MARKER) ?? '{}')).toHaveProperty('signInConfirmed');
        store.legacy = JSON.stringify({ theme: 'light', token: 'tok-2', lastUsername: 'other' });

        const settings = loadSettingsModule();

        expect(settings.loadSettings().auth).toMatchObject({ token: 'tok-2', lastUsername: 'other' });
        expect(parseJsonObject(store.value ?? 'null').auth).toMatchObject({ token: 'tok-2', lastUsername: 'other' });
        expect(parseJsonObject(store.legacy ?? 'null')).toMatchObject({ theme: 'light', token: 'tok-2' });
    });

    test('in the app window: a logout in an older build while the app runs is kept by the next save, in the configuration and both blobs', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MARKER]: MARKER_TEXT });
        prefs.set(MIRROR, SIGNED_OUT);

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await drain(settings);

        expect(stored(CONFIG).auth).toMatchObject({ token: '', apiHeaders: {} });
        expect(stored(CONFIG).app).toMatchObject({ theme: 'light' });
        expect(stored(MIRROR)).toMatchObject({ theme: 'light', token: '' });
        expect(cat.info).toHaveBeenCalledWith('The sign-in in settings.json was changed by an older build; it is kept');
        expect(settings.loadSettings().auth.token).toBe('');
    });

    test('in the background service: a logout in an older build while the service runs is kept by its next save', () => {
        const store = installHeadlessStore({ config: STORED_CONFIG, legacy: USER_FILE });
        store.keys.set(MARKER, MARKER_TEXT);
        const settings = loadSettingsModule();
        settings.setSetting('theme', 'light');
        store.legacy = JSON.stringify({ theme: 'light', token: '', apiHeaders: {}, lastUsername: 'me' });

        expect(settings.setSetting('theme', 'dark')).toBe(true);

        expect(parseJsonObject(store.value ?? 'null').auth).toMatchObject({ token: '', apiHeaders: {} });
        expect(parseJsonObject(store.legacy ?? 'null')).toMatchObject({ theme: 'dark', token: '' });
    });

    test('in the app window: a take-over whose configuration cannot be saved writes nothing and records nothing', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MARKER]: MARKER_TEXT });
        prefs.set(MIRROR, SIGNED_OUT);
        const marker = prefs.get(MARKER);
        let configWrites = 0;
        // The save of the theme lands; the one that adopts the sign-out is refused.
        hook = (call) =>
            call.key === CONFIG && configWrites++ >= 1 ? Promise.reject(new Error('disk full')) : undefined;

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await drain(settings);

        expect(prefs.get(MIRROR)).toBe(SIGNED_OUT);
        expect(prefs.get(MARKER)).toBe(marker);
        expect(stored(CONFIG).auth).toMatchObject({ token: 'tok-secret' });
        expect(cat.info).not.toHaveBeenCalledWith(
            'The sign-in in settings.json was changed by an older build; it is kept',
        );
    });

    test('in the app window: a take-over that cannot be saved at once (the write is refused) writes nothing, and the next save adopts it', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MARKER]: MARKER_TEXT });
        prefs.set(MIRROR, SIGNED_OUT);
        const marker = prefs.get(MARKER);
        const real = storageApi.storage.write.bind(storageApi.storage);
        let writes = 0;
        // The save of the theme goes through; the one that adopts the sign-out is refused on the spot.
        const refusing = jest
            .spyOn(storageApi.storage, 'write')
            .mockImplementation((data) => (writes++ >= 1 ? { ok: false } : real(data)));

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await drain(settings);

        expect(prefs.get(MIRROR)).toBe(SIGNED_OUT);
        expect(prefs.get(MARKER)).toBe(marker);

        refusing.mockRestore();
        expect(settings.setSetting('theme', 'dark')).toBe(true);
        await drain(settings);

        expect(stored(CONFIG).auth).toMatchObject({ token: '' });
        expect(stored(MIRROR)).toMatchObject({ theme: 'dark', token: '' });
    });

    test('in the app window: while the configuration in use is the defaults of a damaged one, the take-over is declined and the mirror goes on', async () => {
        jest.doMock('../../../src/ts/settings/importV1', () => ({
            importV1Settings: () => ({ ok: false, code: 'migration-failed', detail: 'a pass exploded' }),
        }));
        const settings = await appWindow(
            {
                [CONFIG]: '{"app":{"theme":',
                [MIRROR]: SIGNED_OUT,
                [MARKER]: JSON.stringify({
                    importedAt: RECORD.at,
                    mirrorStartedAt: '2026-10-02T00:00:00.000Z',
                    signInPending: 'abc',
                    signInConfirmed: 'abc',
                }),
            },
            { settled: false },
        );
        settings.loadSettings();
        await drain(settings);
        jest.dontMock('../../../src/ts/settings/importV1');
        expect(settings.getSettingsRecovery()?.code).toBe('settings-corrupt');

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await drain(settings);

        expect(cat.info).not.toHaveBeenCalledWith(
            'The sign-in in settings.json was changed by an older build; it is kept',
        );
        expect(stored(MIRROR)).toMatchObject({ theme: 'light' });
    });

    test("in the app window: the other context's pending record survives this one's confirmation, so what it wrote is not taken for an older build's", async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MARKER]: MARKER_TEXT });
        // The service logs out while the window's mirror is under way: its pending record and its settings.json land
        // between the window's write and the window's confirmation.
        hook = (call) => {
            if (call.key !== MIRROR) return undefined;
            prefs.set(MARKER, JSON.stringify({ ...stored(MARKER), signInPending: 'service-out.a.b.c' }));
            return undefined;
        };

        const before = stored(MARKER).signInConfirmed;
        expect(settings.setSetting('token', 'tok-2')).toBe(true);
        await drain(settings);

        // The window confirmed its own; the service's pending one is still there.
        expect(stored(MARKER).signInConfirmed).not.toBe(before);
        expect(stored(MARKER).signInPending).toBe('service-out.a.b.c');
        expect(stored(MARKER).signInConfirmed).toEqual(expect.stringMatching(/^[0-9a-f]+(\.[0-9a-f]+){3}$/));
    });

    test('in the app window: a mirror write whose pending record could not be made is not made', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MARKER]: MARKER_TEXT });
        const before = prefs.get(MIRROR);
        hook = (call) => (call.key === MARKER ? Promise.reject(new Error('quota')) : undefined);

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await drain(settings);

        expect(prefs.get(MIRROR)).toBe(before);
    });

    test('in the app window: the sign-in the stored mirror holds stays known when the next one is recorded pending', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MARKER]: MARKER_TEXT });
        const firstConfirmed = stored(MARKER).signInConfirmed;
        // The next sign-in is recorded as pending; its write to settings.json does not land.
        hook = (call) => (call.key === MIRROR ? Promise.reject(new Error('quota')) : undefined);
        expect(settings.setSetting('token', 'tok-2')).toBe(true);
        await drain(settings);

        expect(stored(MARKER).signInConfirmed).toBe(firstConfirmed);
        expect(stored(MARKER).signInPending).toEqual(expect.any(String));
        expect(stored(MARKER).signInPending).not.toBe(firstConfirmed);
        expect(stored(MIRROR)).toMatchObject({ token: 'tok-secret' });
    });

    test('nothing is taken over before the stores are read', async () => {
        g.Capacitor = { isNativePlatform: () => true };
        prefs.set(CONFIG, STORED_CONFIG);
        prefs.set(MIRROR, SIGNED_OUT);
        prefs.set(MARKER, JSON.stringify({ importedAt: RECORD.at, signInPending: 'abc', signInConfirmed: 'abc' }));
        const early = loadSettingsModule();

        expect(early.loadSettings()).toEqual(early.getDefaultSettings());
        expect(cat.info).not.toHaveBeenCalledWith(expect.stringContaining('older build'));
    });
});

describe('a logout in the Android app window clears the sign-in out of the set-aside copies', () => {
    const CONFIG_COPY = 'gurushots-config_corrupt-2026-10-16T08-00-00-000Z';
    const SETTINGS_COPY = 'gurushots-settings_unimportable-2026-10-16T08-00-00-000Z';
    const OLD_COPY = 'gurushots-settings_corrupt';
    const BAD_COPY = 'gurushots-config_corrupt-2026-10-16T09-00-00-000Z';
    const OTHER = 'gs_scenario_state';

    const arranged = () =>
        appWindow(
            {
                [CONFIG]: STORED_CONFIG,
                [MARKER]: MARKER_TEXT,
                [CONFIG_COPY]: JSON.stringify({
                    version: 2,
                    auth: { token: 'tok-old', apiHeaders: { a: 'b' }, lastUsername: 'me', chosenPhotosMemberId: '' },
                }),
                [SETTINGS_COPY]: JSON.stringify({ token: 'tok-u', apiHeaders: { a: 'b' }, theme: 'dark' }),
                [OLD_COPY]: JSON.stringify({ token: 'tok-o', apiHeaders: {} }),
                [BAD_COPY]: '{"auth":{"token":"tok-bad"',
                [OTHER]: '{"token":"tok-keep"}',
            },
            { settled: false },
        );

    test('every copy that parses and holds one is cleared, the others are left, and the log holds no token', async () => {
        const settings = await arranged();
        settings.loadSettings();
        await drain(settings);

        expect(settings.setSetting('token', '')).toBe(true);
        await drain(settings);

        expect(stored(CONFIG_COPY).auth).toMatchObject({ token: '', apiHeaders: {}, lastUsername: '' });
        expect(stored(SETTINGS_COPY)).toEqual({ token: '', apiHeaders: {}, theme: 'dark' });
        expect(stored(OLD_COPY)).toEqual({ token: '', apiHeaders: {} });
        expect(prefs.get(BAD_COPY)).toBe('{"auth":{"token":"tok-bad"');
        expect(prefs.get(OTHER)).toBe('{"token":"tok-keep"}');
        expect(JSON.stringify([cat.info.mock.calls, cat.error.mock.calls])).not.toMatch(/tok-(old|u|o)/);
    });

    test('a copy that cannot be read or written is logged, and the others are still cleared', async () => {
        const settings = await arranged();
        settings.loadSettings();
        await drain(settings);
        const real = mockPreferences.get.getMockImplementation();
        mockPreferences.get.mockImplementation((call) =>
            call.key === CONFIG_COPY
                ? Promise.reject(new Error('EIO'))
                : (real?.(call) ?? Promise.resolve({ value: null })),
        );

        expect(settings.setSetting('token', '')).toBe(true);
        await drain(settings);

        expect(cat.error).toHaveBeenCalledWith(`Capacitor ${CONFIG_COPY} could not be rewritten:`, expect.any(Error));
        expect(stored(SETTINGS_COPY)).toMatchObject({ token: '' });
        expect(stored(CONFIG_COPY).auth).toMatchObject({ token: 'tok-old' });
    });

    test('a copy that vanished between the listing and the read is skipped', async () => {
        const settings = await arranged();
        settings.loadSettings();
        await drain(settings);
        const real = mockPreferences.get.getMockImplementation();
        mockPreferences.get.mockImplementation((call) =>
            call.key === OLD_COPY
                ? Promise.resolve({ value: null })
                : (real?.(call) ?? Promise.resolve({ value: null })),
        );

        expect(settings.setSetting('token', '')).toBe(true);
        await drain(settings);

        expect(stored(OLD_COPY)).toMatchObject({ token: 'tok-o' });
        expect(stored(SETTINGS_COPY)).toMatchObject({ token: '' });
    });
});

describe('the settings.json the configuration could not be restored from, in the Android app window', () => {
    const unimportable = () => [...prefs.keys()].filter((key) => key.startsWith('gurushots-settings_unimportable-'));
    const damaged = async () => {
        const settings = await appWindow(
            {
                [CONFIG]: '{"app":{"theme":',
                [MIRROR]: '{broken',
                [MARKER]: JSON.stringify({ importedAt: RECORD.at, mirrorStartedAt: '2026-10-02T00:00:00.000Z' }),
            },
            { settled: false },
        );
        settings.loadSettings();
        await drain(settings);
        return settings;
    };

    test('is one state however often it is read, with the file untouched until the first save', async () => {
        const settings = await damaged();

        for (let read = 0; read < 3; read++) {
            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt', blocking: false });
            expect(settings.getSettingsRecovery()).not.toHaveProperty('settingsSetAside');
        }
        await drain(settings);

        expect(prefs.get(MIRROR)).toBe('{broken');
        expect(unimportable()).toEqual([]);
    });

    test('the first save sets the file aside under a key of its own before the mirror writes, and the notice knows', async () => {
        const settings = await damaged();

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await drain(settings);

        expect(unimportable()).toHaveLength(1);
        expect(prefs.get(unimportable()[0])).toBe('{broken');
        expect(stored(MIRROR)).toMatchObject({ theme: 'light' });
        // (The key it was written under, not a guess.)
        expect(settings.getSettingsRecovery()).toMatchObject({
            code: 'settings-corrupt',
            settingsSetAside: unimportable()[0],
        });
        expect(calls.map((call) => call.key).indexOf(MIRROR)).toBeGreaterThan(-1);
    });

    test('a file that could not be set aside is not written over, and the next save sets it aside', async () => {
        const settings = await damaged();
        const set = mockPreferences.set.getMockImplementation();
        let refusing = true;
        mockPreferences.set.mockImplementation(({ key, value }) =>
            refusing && key.startsWith('gurushots-settings_unimportable-')
                ? Promise.reject(new Error('quota'))
                : (set?.({ key, value }) ?? Promise.resolve()),
        );

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await drain(settings);

        expect(prefs.get(MIRROR)).toBe('{broken');
        expect(unimportable()).toEqual([]);
        // The notice does not say it was set aside when it was not.
        expect(settings.getSettingsRecovery()).not.toHaveProperty('settingsSetAside');

        refusing = false;
        expect(settings.setSetting('theme', 'dark')).toBe(true);
        await drain(settings);

        expect(unimportable()).toHaveLength(1);
        expect(stored(MIRROR)).toMatchObject({ theme: 'dark' });
    });

    test('the notice says where the file went only once the queued set-aside has landed', async () => {
        const settings = await damaged();
        const set = mockPreferences.set.getMockImplementation();
        let release: () => void = () => undefined;
        mockPreferences.set.mockImplementation(({ key, value }) =>
            key.startsWith('gurushots-settings_unimportable-')
                ? new Promise<void>((resolve) => {
                      release = () => {
                          void set?.({ key, value });
                          resolve();
                      };
                  })
                : (set?.({ key, value }) ?? Promise.resolve()),
        );

        expect(settings.setSetting('theme', 'light')).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 20));

        // Asked for, not done: nothing is claimed, and nothing is written over the file.
        expect(settings.getSettingsRecovery()).not.toHaveProperty('settingsSetAside');
        expect(prefs.get(MIRROR)).toBe('{broken');

        release();
        await drain(settings);

        expect(settings.getSettingsRecovery()).toMatchObject({ settingsSetAside: unimportable()[0] });
        expect(unimportable()).toHaveLength(1);
    });

    test('Start fresh says nothing was kept when there was no stored settings, and that a copy was when there was', async () => {
        const none = await appWindow({}, { settled: false });
        none.loadSettings();
        await drain(none);
        expect(none.startFreshDetailed()).toEqual({ ok: true, keptAt: null });

        prefs.clear();
        const kept = await appWindow({ [MIRROR]: '{broken' }, { settled: false });
        kept.loadSettings();
        await drain(kept);
        expect(kept.getSettingsRecovery()?.code).toBe('settings-import-failed');

        const result = kept.startFreshDetailed();
        kept.loadSettings();
        await drain(kept);

        expect(result.ok).toBe(true);
        // Where the copy is written later, the key it was written under is told once it has landed.
        expect(result.keptAt).toBeNull();
        await expect(result.landed).resolves.toBe(ORIGINAL);
        expect(prefs.get(ORIGINAL)).toBe('{broken');
    });

    test('Start fresh reports the copy of its own as the key it wrote when the original is taken', async () => {
        const settings = await appWindow({ [MIRROR]: '{broken', [ORIGINAL]: USER_FILE }, { settled: false });
        settings.loadSettings();
        await drain(settings);

        const result = settings.startFreshDetailed();
        const key = await result.landed;
        await drain(settings);

        expect(key).toMatch(/^gurushots-settings_unimportable-/);
        expect(prefs.get(key ?? '')).toBe('{broken');
        expect(prefs.get(ORIGINAL)).toBe(USER_FILE);
    });

    test('a set-aside asked for again while one is being made stays owed when the first one settles, and the mirror makes it', async () => {
        const settings = await appWindow({ [CONFIG]: STORED_CONFIG, [MARKER]: MARKER_TEXT });
        const unimportable = () =>
            [...prefs.keys()].filter((key) => key.startsWith('gurushots-settings_unimportable-'));
        const set = mockPreferences.set.getMockImplementation();
        let refusing = true;
        mockPreferences.set.mockImplementation(({ key, value }) =>
            refusing && key.startsWith('gurushots-settings_unimportable-')
                ? Promise.reject(new Error('quota'))
                : (set?.({ key, value }) ?? Promise.resolve()),
        );

        // The first lands as the original; the second (the original is taken by then) cannot be written.
        const first = mirrorApi.setAsideLegacy();
        const second = mirrorApi.setAsideLegacy();
        await expect(first.ok && first.landed).resolves.toBe(ORIGINAL);
        await expect(second.ok && second.landed).resolves.toBeNull();
        expect(unimportable()).toEqual([]);

        // The first one's settling did not clear what the second asked for: the next mirror still makes it, before it writes.
        refusing = false;
        expect(settings.setSetting('theme', 'light')).toBe(true);
        await drain(settings);

        expect(unimportable()).toHaveLength(1);
        expect(prefs.get(unimportable()[0])).toBe(prefs.get(ORIGINAL));
        expect(stored(MIRROR)).toMatchObject({ theme: 'light' });
    });

    test('Start fresh whose original cannot be written says so with null too', async () => {
        const settings = await appWindow({ [MIRROR]: '{broken' }, { settled: false });
        settings.loadSettings();
        await drain(settings);
        hook = (call) => (call.key === ORIGINAL ? Promise.reject(new Error('quota')) : undefined);

        const result = settings.startFreshDetailed();

        await expect(result.landed).resolves.toBeNull();
    });

    test('Start fresh whose copy cannot be written says so with null, and the mirror still writes nothing over the file', async () => {
        const settings = await appWindow({ [MIRROR]: '{broken', [ORIGINAL]: USER_FILE }, { settled: false });
        settings.loadSettings();
        await drain(settings);
        const set = mockPreferences.set.getMockImplementation();
        mockPreferences.set.mockImplementation(({ key, value }) =>
            key.startsWith('gurushots-settings_unimportable-')
                ? Promise.reject(new Error('quota'))
                : (set?.({ key, value }) ?? Promise.resolve()),
        );

        const result = settings.startFreshDetailed();

        await expect(result.landed).resolves.toBeNull();
        settings.loadSettings();
        await drain(settings);
        expect(prefs.get(MIRROR)).toBe('{broken');
    });
});

describe('Re-import in the Android app window', () => {
    test('imports settings.json: the key of a copy is not a path to read', async () => {
        const settings = await appWindow(
            {
                [CONFIG]: '{"app":{"theme":',
                [MIRROR]: '{broken',
                [MARKER]: JSON.stringify({ importedAt: RECORD.at, mirrorStartedAt: '2026-10-02T00:00:00.000Z' }),
            },
            { settled: false },
        );
        settings.loadSettings();
        settings.setSetting('theme', 'light');
        await drain(settings);
        expect(settings.getSettingsRecovery()?.code).toBe('settings-corrupt');

        // (The settings.json of the window is now the mirror of what it saved; that is what it can import.)
        expect(settings.reimportFromV1()).toBe(true);
        await drain(settings);

        expect(settings.getSettingsRecovery()).toBeNull();
        expect(stored(CONFIG).app).toMatchObject({ theme: 'light' });
    });
});

describe('the settings.json that does not import, in the background service', () => {
    test('is left as it is, quietly: only the app window can set it aside, and the service does not try on every save', () => {
        const store = installHeadlessStore({ config: '{"app":{"theme":', legacy: '{broken' });
        store.keys.set(MARKER, JSON.stringify({ importedAt: RECORD.at, mirrorStartedAt: '2026-10-02T00:00:00.000Z' }));
        let settings!: typeof settingsModule;
        jest.isolateModules(() => {
            settings = require('../../../src/ts/settings') as typeof settingsModule;
            cat = invalid<typeof loggerModule & { __cat: CatDouble }>(
                require('../../../src/ts/logger') as typeof loggerModule,
            ).__cat;
            // The service cannot set a configuration aside; as if it could, so that the state this is about is reached.
            const { storage } =
                require('../../../src/ts/settings/storage') as typeof import('../../../src/ts/settings/storage');
            jest.spyOn(storage, 'quarantineRaw').mockImplementation((raw) => {
                expect(raw).toBe('{"app":{"theme":');
                store.value = null;
                return { ok: true, path: 'moved' };
            });
        });

        settings.loadSettings();
        expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt' });
        expect(settings.setSetting('theme', 'light')).toBe(true);
        expect(settings.setSetting('theme', 'dark')).toBe(true);

        expect(store.legacy).toBe('{broken');
        expect(cat.warning).not.toHaveBeenCalledWith(expect.stringContaining('could not be set aside'));
        expect(cat.debug).toHaveBeenCalledWith(expect.stringContaining('only the app window can set it aside'));
    });
});
