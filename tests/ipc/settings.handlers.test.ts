/**
 * Tests for the hand-written (non-thin) channels in
 * settings.handlers.ts plus the wiring of the installed platform's
 * windows (the write announcements and the post-wipe hand-over; the Electron
 * bodies are tests/shells/electronPlatform.test.ts).
 * The thin-handler rows are covered by settings.handlers.thin-table.test.ts.
 *
 * Every channel here has a documented error fallback the renderer relies on
 * (default settings, false, a schema-shaped empty object, …) — the handlers
 * must never throw across IPC.
 */

jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/settings/localData', () => ({ wipeLocalData: jest.fn() }));
jest.mock('../../src/ts/thirdPartyNotices', () => ({ loadThirdPartyNotices: jest.fn() }));
jest.mock('../../src/ts/metadata', () => ({ cleanupStaleMetadata: jest.fn() }));
jest.mock('../../src/ts/apiFactory', () => ({
    refreshApi: jest.fn(),
    getApiStrategy: jest.fn(),
    getMiddleware: jest.fn(),
}));

import { invalid } from '../helpers/invalid';
import { installTestPlatform } from '../helpers/platform';

import type { PlatformWindows } from '../../src/ts/platform/port';

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import metadataModule = require('../../src/ts/metadata');
const metadata = jest.mocked(metadataModule);
import apiFactoryModule = require('../../src/ts/apiFactory');
const apiFactory = jest.mocked(apiFactoryModule);
import localDataModule = require('../../src/ts/settings/localData');
const localData = jest.mocked(localDataModule);
import noticesModule = require('../../src/ts/thirdPartyNotices');
const notices = jest.mocked(noticesModule);
import type * as settings_handlersModule from '../../src/ts/ipc/settings.handlers';
const { buildHandlers } = require('../../src/ts/ipc/settings.handlers') as typeof settings_handlersModule;

const boom = () => {
    throw new Error('boom');
};

// Installs the platform with jest.fn windows and returns them: the handlers
// announce writes through platform().windows, so a test asserts on these.
// installTestPlatform replaces the windows group whole; the setup file's
// afterEach reinstalls the untouched node test platform.
const installWindows = (): PlatformWindows => {
    const windows: PlatformWindows = {
        broadcastSettingsChanged: jest.fn<void, [object]>(),
        afterWipe: jest.fn<void, []>(),
    };
    installTestPlatform({ windows });
    return windows;
};

let handlers: ReturnType<typeof buildHandlers>;

beforeEach(() => {
    jest.clearAllMocks();
    settings.getDefaultSettings = jest.fn().mockReturnValue({ app: { theme: 'light', boostTime: 3600 } });
    // Every successful write now announces through the installed platform's
    // windows, whose broadcast re-reads the settings — the default the tests
    // that do not say otherwise announce.
    settings.loadSettings = jest.fn().mockReturnValue({ auth: { token: '' }, app: { theme: 'light' } });
    handlers = buildHandlers();
});

describe('get-settings', () => {
    test('returns the loaded settings without the token, plus hasToken', async () => {
        jest.mocked(settings.loadSettings).mockReturnValue(
            invalid({ auth: { token: 'secret' }, app: { theme: 'dark' } }),
        );
        const result = await handlers['get-settings']();
        expect(result).toEqual({ app: { theme: 'dark' }, hasToken: true });
        expect(result).not.toHaveProperty('auth');
    });

    test('reports hasToken false for an empty or missing token', async () => {
        settings.loadSettings = jest.fn().mockReturnValue({ auth: { token: '' }, app: { theme: 'dark' } });
        await expect(handlers['get-settings']()).resolves.toEqual({ app: { theme: 'dark' }, hasToken: false });
        settings.loadSettings = jest.fn().mockReturnValue({ auth: {}, app: { theme: 'dark' } });
        await expect(handlers['get-settings']()).resolves.toEqual({ app: { theme: 'dark' }, hasToken: false });
    });

    test('falls back to defaults (still token-free) when loading throws', async () => {
        settings.loadSettings = jest.fn(boom);
        settings.getDefaultSettings = jest
            .fn()
            .mockReturnValue({ auth: { token: '' }, app: { theme: 'light', boostTime: 3600 } });
        const result = await handlers['get-settings']();
        expect(result).toEqual({ app: { theme: 'light', boostTime: 3600 }, hasToken: false });
        expect(result).not.toHaveProperty('auth');
        expect(settings.getDefaultSettings).toHaveBeenCalled();
    });
});

describe('get-setting', () => {
    test('delegates a string key to settings.getSetting', async () => {
        settings.getSetting = jest.fn().mockReturnValue('dark');
        await expect(handlers['get-setting']({}, 'theme')).resolves.toBe('dark');
        expect(settings.getSetting).toHaveBeenCalledWith('theme');
    });

    test.each(['auth', 'token', 'hasToken', 'apiHeaders'])('never returns the %s key', async (key) => {
        settings.getSetting = jest.fn().mockReturnValue('secret');
        await expect(handlers['get-setting']({}, key)).resolves.toBeNull();
        expect(settings.getSetting).not.toHaveBeenCalled();
    });

    test('answers the account key lastUsername: the renderer reads it', async () => {
        settings.getSetting = jest.fn().mockReturnValue('me');
        await expect(handlers['get-setting']({}, 'lastUsername')).resolves.toBe('me');
        expect(settings.getSetting).toHaveBeenCalledWith('lastUsername');
    });

    test('rejects a non-string key and returns null (no default for it)', async () => {
        settings.getSetting = jest.fn();
        await expect(handlers['get-setting']({}, invalid(42))).resolves.toBeNull();
        expect(settings.getSetting).not.toHaveBeenCalled();
    });

    test('returns the key default when getSetting throws', async () => {
        settings.getSetting = invalid(jest.fn(boom));
        await expect(handlers['get-setting']({}, 'theme')).resolves.toBe('light');
    });

    test('returns null when getSetting throws for a key with no default', async () => {
        settings.getSetting = invalid(jest.fn(boom));
        await expect(handlers['get-setting']({}, 'unknownKey')).resolves.toBeNull();
    });
});

describe('set-setting', () => {
    test('delegates to settings.setSetting and returns its result', async () => {
        settings.setSetting = jest.fn().mockReturnValue(true);
        await expect(handlers['set-setting']({}, 'theme', 'dark')).resolves.toBe(true);
        expect(settings.setSetting).toHaveBeenCalledWith('theme', 'dark');
    });

    test.each(['auth', 'token', 'hasToken', 'apiHeaders', 'lastUsername'])(
        'refuses to write the %s key and does not broadcast',
        async (key) => {
            const windows = installWindows();
            settings.setSetting = jest.fn().mockReturnValue(true);
            const h = buildHandlers();
            await expect(h['set-setting']({}, key, 'planted')).resolves.toBe(false);
            expect(settings.setSetting).not.toHaveBeenCalled();
            expect(windows.broadcastSettingsChanged).not.toHaveBeenCalled();
        },
    );

    test('Stay Logged In is one write: the facade forgets the saved user name with it, and the answer is the facade’s', async () => {
        settings.setSetting = jest.fn().mockReturnValue(true);
        await expect(handlers['set-setting']({}, 'stayLoggedIn', false)).resolves.toBe(true);
        expect(settings.setSetting).toHaveBeenCalledTimes(1);
        expect(settings.setSetting).toHaveBeenCalledWith('stayLoggedIn', false);

        settings.setSetting = jest.fn().mockReturnValue(false);
        await expect(handlers['set-setting']({}, 'stayLoggedIn', false)).resolves.toBe(false);
        expect(settings.setSetting).toHaveBeenCalledTimes(1);
    });

    test('returns false for a non-string key without writing', async () => {
        settings.setSetting = jest.fn();
        await expect(handlers['set-setting']({}, invalid(null), 'x')).resolves.toBe(false);
        expect(settings.setSetting).not.toHaveBeenCalled();
    });

    test('returns false when setSetting throws', async () => {
        settings.setSetting = invalid(jest.fn(boom));
        await expect(handlers['set-setting']({}, 'theme', 'dark')).resolves.toBe(false);
    });

    test('broadcasts the freshly loaded settings after a successful write', async () => {
        const windows = installWindows();
        settings.setSetting = jest.fn().mockReturnValue(true);
        settings.loadSettings = jest
            .fn()
            .mockReturnValue({ auth: { token: 'secret' }, app: { language: 'lv', theme: 'dark' } });
        const h = buildHandlers();

        await expect(h['set-setting']({}, 'language', 'lv')).resolves.toBe(true);
        expect(windows.broadcastSettingsChanged).toHaveBeenCalledWith({
            app: { language: 'lv', theme: 'dark' },
            hasToken: true,
        });
    });

    test('does not broadcast a rejected write', async () => {
        const windows = installWindows();
        settings.setSetting = jest.fn().mockReturnValue(false);
        const h = buildHandlers();

        await expect(h['set-setting']({}, 'language', 'lv')).resolves.toBe(false);
        expect(windows.broadcastSettingsChanged).not.toHaveBeenCalled();
    });
});

describe('save-settings', () => {
    test('saves, then broadcasts the stored settings without the token', async () => {
        const windows = installWindows();
        settings.saveAppSettings = jest.fn().mockReturnValue(true);
        settings.loadSettings = jest
            .fn()
            .mockReturnValue({ auth: { token: 'secret' }, app: { theme: 'dark', language: 'en' } });
        const h = buildHandlers();

        await expect(h['save-settings']({}, { theme: 'dark' })).resolves.toBe(true);
        expect(settings.saveAppSettings).toHaveBeenCalledWith({ theme: 'dark' });
        expect(windows.broadcastSettingsChanged).toHaveBeenCalledWith({
            app: { theme: 'dark', language: 'en' },
            hasToken: true,
        });
    });

    test('strips the sign-in keys from the payload too: a renderer cannot write them', async () => {
        settings.saveAppSettings = jest.fn().mockReturnValue(true);
        settings.loadSettings = jest.fn().mockReturnValue({ app: { theme: 'dark' }, auth: { apiHeaders: { a: 'b' } } });
        await expect(
            handlers['save-settings'](
                {},
                {
                    apiHeaders: { evil: '1' },
                    lastUsername: 'evil',
                    auth: { token: 'evil' },
                    theme: 'dark',
                },
            ),
        ).resolves.toBe(true);
        expect(settings.saveAppSettings).toHaveBeenCalledWith({ theme: 'dark' });
    });

    test('get-settings then save-settings of its app block round-trips without touching the sign-in state', async () => {
        const stored = { auth: { token: 'secret', apiHeaders: { a: 'b' } }, app: { theme: 'dark' } };
        settings.loadSettings = jest.fn().mockReturnValue(stored);
        settings.saveAppSettings = jest.fn().mockReturnValue(true);
        const fetched = await handlers['get-settings']();
        expect(fetched).not.toHaveProperty('auth');
        await expect(handlers['save-settings']({}, fetched.app)).resolves.toBe(true);
        expect(settings.saveAppSettings).toHaveBeenCalledWith({ theme: 'dark' });
    });

    test('strips token and hasToken from the payload before saving and from the broadcast', async () => {
        const windows = installWindows();
        settings.saveAppSettings = jest.fn().mockReturnValue(true);
        settings.loadSettings = jest.fn().mockReturnValue({ auth: { token: 'stored' }, app: { theme: 'dark' } });
        const h = buildHandlers();

        await expect(h['save-settings']({}, { token: 'planted', hasToken: false, theme: 'dark' })).resolves.toBe(true);
        expect(settings.saveAppSettings).toHaveBeenCalledWith({ theme: 'dark' });
        expect(windows.broadcastSettingsChanged).toHaveBeenCalledWith({ app: { theme: 'dark' }, hasToken: true });
    });

    test('does not broadcast when the save fails', async () => {
        const windows = installWindows();
        settings.saveAppSettings = jest.fn().mockReturnValue(false);
        const h = buildHandlers();

        await expect(h['save-settings']({}, { theme: 'dark' })).resolves.toBe(false);
        expect(windows.broadcastSettingsChanged).not.toHaveBeenCalled();
    });

    test.each([null, 'str', 5, undefined])('rejects non-object payload %p', async (bad) => {
        settings.saveAppSettings = jest.fn();
        await expect(handlers['save-settings']({}, invalid(bad))).resolves.toBe(false);
        expect(settings.saveAppSettings).not.toHaveBeenCalled();
    });

    test('returns false when saveAppSettings throws', async () => {
        settings.saveAppSettings = invalid(jest.fn(boom));
        await expect(handlers['save-settings']({}, { theme: 'dark' })).resolves.toBe(false);
    });
});

describe('get-environment-info', () => {
    test('returns the facade environment info', async () => {
        settings.getEnvironmentInfo = jest.fn().mockReturnValue({ nodeEnv: 'test' });
        await expect(handlers['get-environment-info']()).resolves.toEqual({ nodeEnv: 'test' });
    });

    test('returns a mock-defaulting "unknown" shape when it throws', async () => {
        settings.getEnvironmentInfo = jest.fn(boom);
        await expect(handlers['get-environment-info']()).resolves.toEqual({
            nodeEnv: 'unknown',
            dev: undefined,
            prod: undefined,
            defaultMock: true,
            platform: process.platform,
            userDataPath: 'unknown',
            launchedAt: undefined,
        });
    });
});

describe('refresh-api', () => {
    test('refreshes the API factory', async () => {
        await expect(handlers['refresh-api']()).resolves.toEqual({ success: true });
        expect(apiFactory.refreshApi).toHaveBeenCalledTimes(1);
    });

    test('returns the error envelope when refresh throws', async () => {
        apiFactory.refreshApi.mockImplementationOnce(boom);
        await expect(handlers['refresh-api']()).resolves.toEqual({ success: false, error: 'boom' });
    });

    test('falls back to a fixed message when refresh throws null', async () => {
        apiFactory.refreshApi.mockImplementationOnce(() => {
            throw null;
        });
        await expect(handlers['refresh-api']()).resolves.toEqual({ success: false, error: 'Failed to refresh API' });
    });
});

describe('get-settings-schema', () => {
    test('serialises only the whitelisted schema fields plus defaults, groups, tiers and profile caps', async () => {
        settings.SETTINGS_SCHEMA = invalid({
            boostTime: {
                type: 'number',
                default: 3600,
                perChallenge: true,
                group: 'boost',
                label: 'Boost',
                description: 'd',
                helpKey: 'h',
                min: 0,
                max: 86400,
                unit: 's',
                minutes: true,
                validate: () => true,
            },
        });
        settings.SETTINGS_GROUPS = invalid(['boost']);
        settings.SETTINGS_TIERS = invalid({ basic: ['boostTime'] });
        settings.MAX_CHALLENGE_PROFILES = invalid(20);
        settings.MAX_PROFILE_NAME_LENGTH = invalid(40);
        settings.getGlobalDefault = jest.fn().mockReturnValue(1800);

        const result = await handlers['get-settings-schema']();

        expect(result).toEqual({
            schema: {
                boostTime: {
                    type: 'number',
                    default: 3600,
                    perChallenge: true,
                    challengeOnly: false,
                    group: 'boost',
                    label: 'Boost',
                    description: 'd',
                    helpKey: 'h',
                    min: 0,
                    max: 86400,
                    unit: 's',
                    minutes: true,
                },
            },
            defaults: { boostTime: 1800 },
            groups: ['boost'],
            tiers: { basic: ['boostTime'] },
            profileLimits: { maxChallengeProfiles: 20, maxProfileNameLength: 40 },
        });
        expect(settings.getGlobalDefault).toHaveBeenCalledWith('boostTime');
        // The validate function must never cross the IPC boundary.
        expect(invalid<Record<string, Record<string, unknown>>>(result.schema).boostTime.validate).toBeUndefined();
    });

    test('returns an empty schema shape when building it throws', async () => {
        settings.SETTINGS_SCHEMA = invalid({ boostTime: { type: 'number' } });
        settings.getGlobalDefault = invalid(jest.fn(boom));
        await expect(handlers['get-settings-schema']()).resolves.toEqual({ schema: {}, defaults: {} });
    });
});

describe('cleanup-stale-metadata', () => {
    beforeEach(() => {
        settings.getSetting = jest.fn().mockReturnValue(false);
    });

    test('delegates the active ids, as strings, to metadata.cleanupStaleMetadata', async () => {
        metadata.cleanupStaleMetadata.mockReturnValue(true);
        await expect(handlers['cleanup-stale-metadata']({}, [1, '2'])).resolves.toEqual({ success: true });
        expect(metadata.cleanupStaleMetadata).toHaveBeenCalledWith(['1', '2']);
    });

    test('a cleanup that did not save is an error result', async () => {
        metadata.cleanupStaleMetadata.mockReturnValue(false);
        await expect(handlers['cleanup-stale-metadata']({}, ['1'])).resolves.toEqual({
            success: false,
            error: 'The metadata could not be saved',
        });
    });

    test('an error is an error result with its message', async () => {
        metadata.cleanupStaleMetadata.mockImplementationOnce(boom);
        await expect(handlers['cleanup-stale-metadata']({}, ['1'])).resolves.toEqual({
            success: false,
            error: 'boom',
        });
    });

    test.each([
        ['not an array', 'abc'],
        ['missing', undefined],
        ['an item that is not an id', ['1', {}]],
        ['a blank id', ['1', '  ']],
        ['an untrimmed id', ['1', ' 8 ']],
        ['an over-long id', ['9'.repeat(65)]],
    ])('refuses %s without touching the metadata', async (_name, ids) => {
        await expect(handlers['cleanup-stale-metadata']({}, invalid(ids))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
        expect(metadata.cleanupStaleMetadata).not.toHaveBeenCalled();
    });

    test('in mock mode it does nothing: the active list holds mock ids, and the real metadata survives', async () => {
        settings.getSetting = jest.fn().mockReturnValue(true);
        await expect(handlers['cleanup-stale-metadata']({}, ['mock-1'])).resolves.toEqual({ success: true });
        expect(metadata.cleanupStaleMetadata).not.toHaveBeenCalled();
    });
});

describe('cleanup-stale-challenge-setting', () => {
    beforeEach(() => {
        settings.getSetting = jest.fn().mockReturnValue(false);
    });

    test('passes a list of ids to the settings layer and says it was saved', async () => {
        jest.mocked(settings.cleanupStaleChallengeSetting).mockReturnValue(true);
        await expect(handlers['cleanup-stale-challenge-setting']({}, ['1', '2'])).resolves.toEqual({ success: true });
        expect(settings.cleanupStaleChallengeSetting).toHaveBeenCalledWith(['1', '2']);
    });

    test('ids are compared the way perChallenge is keyed: numeric ids become strings', async () => {
        jest.mocked(settings.cleanupStaleChallengeSetting).mockReturnValue(true);
        await handlers['cleanup-stale-challenge-setting']({}, [7, '8', '9']);
        expect(settings.cleanupStaleChallengeSetting).toHaveBeenCalledWith(['7', '8', '9']);
    });

    test.each([
        ['not an array', 'abc'],
        ['missing', undefined],
        ['empty, which would prune every challenge', []],
        ['an item that is not an id', ['1', {}]],
        ['a blank id', ['1', '  ']],
        ['an untrimmed id', ['1', ' 8 ']],
        ['an over-long id', ['9'.repeat(65)]],
    ])('refuses %s without touching the settings', async (_name, ids) => {
        jest.mocked(settings.cleanupStaleChallengeSetting).mockClear();
        await expect(handlers['cleanup-stale-challenge-setting']({}, invalid(ids))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
        expect(settings.cleanupStaleChallengeSetting).not.toHaveBeenCalled();
    });

    test('a save that failed is an error result, never read as success', async () => {
        jest.mocked(settings.cleanupStaleChallengeSetting).mockReturnValue(false);
        await expect(handlers['cleanup-stale-challenge-setting']({}, ['1'])).resolves.toEqual({
            success: false,
            error: 'The settings file could not be saved',
        });
    });

    test('an error is an error result with its message', async () => {
        settings.cleanupStaleChallengeSetting = invalid(jest.fn(boom));
        await expect(handlers['cleanup-stale-challenge-setting']({}, ['1'])).resolves.toEqual({
            success: false,
            error: 'boom',
        });
    });

    test('in mock mode it does nothing: the active list holds mock ids, and the real overrides survive', async () => {
        settings.cleanupStaleChallengeSetting = jest.fn().mockReturnValue(true);
        settings.getSetting = jest.fn().mockReturnValue(true);
        await expect(handlers['cleanup-stale-challenge-setting']({}, ['mock-1'])).resolves.toEqual({ success: true });
        expect(settings.cleanupStaleChallengeSetting).not.toHaveBeenCalled();
    });
});

describe('the recovery of the stored settings', () => {
    const channels = [
        ['retry-settings-import', 'retryImportDetailed'],
        ['start-fresh-settings', 'startFreshDetailed'],
        ['acknowledge-import-report', 'acknowledgeImportReport'],
    ] as const;
    type Method = (typeof channels)[number][1];
    // What each action answers when it worked: a boolean, or the detail the answer carries.
    const worked = (method: Method) =>
        method === 'startFreshDetailed' ? { ok: true } : method === 'retryImportDetailed' ? { ok: true } : true;
    const didNot = (method: Method) =>
        method === 'startFreshDetailed' ? { ok: false } : method === 'retryImportDetailed' ? { ok: false } : false;
    const answerOf = (): { success: true } => ({ success: true });

    test.each(channels)('%s runs %s, then announces the settings to every window', async (channel, method) => {
        const windows = installWindows();
        settings[method] = jest.fn().mockReturnValue(worked(method));
        settings.loadSettings = jest.fn().mockReturnValue({ auth: { token: 't' }, app: { theme: 'dark' } });
        const h = buildHandlers();

        await expect(h[channel]()).resolves.toEqual(answerOf());

        expect(settings[method]).toHaveBeenCalledTimes(1);
        expect(windows.broadcastSettingsChanged).toHaveBeenCalledWith({ app: { theme: 'dark' }, hasToken: true });
    });

    test('start-fresh-settings says nothing was reset when a configuration was in place already', async () => {
        settings.startFreshDetailed = jest.fn().mockReturnValue({ ok: true, adopted: true });

        await expect(handlers['start-fresh-settings']()).resolves.toEqual({ success: true, adopted: true });
    });

    test.each(channels)(
        '%s answers the failure code when the action did not work, and announces nothing',
        async (channel, method) => {
            const windows = installWindows();
            settings[method] = jest.fn().mockReturnValue(didNot(method));
            const h = buildHandlers();

            // A report that could not be saved is not an import that failed.
            await expect(h[channel]()).resolves.toEqual({
                success: false,
                error: channel === 'acknowledge-import-report' ? 'import-report-not-saved' : 'settings-import-failed',
            });

            expect(windows.broadcastSettingsChanged).not.toHaveBeenCalled();
        },
    );

    test.each(channels)('%s never throws to the renderer', async (channel, method) => {
        settings[method] = invalid(jest.fn(boom));
        await expect(handlers[channel]()).resolves.toEqual({ success: false, error: 'boom' });
        settings[method] = invalid(
            jest.fn(() => {
                throw null;
            }),
        );
        await expect(handlers[channel]()).resolves.toEqual({
            success: false,
            error: 'Failed to recover the settings',
        });
    });

    test('retry-settings-import says nothing was imported when a configuration was in place already', async () => {
        settings.retryImportDetailed = jest.fn().mockReturnValue({ ok: true, adopted: true });

        await expect(handlers['retry-settings-import']()).resolves.toEqual({ success: true, adopted: true });
    });
});

describe('get-import-report', () => {
    test('answers the report the settings hold, or null when there was no import', async () => {
        const report = {
            at: '2026-10-16T09:00:00.000Z',
            refsBlocked: [
                'rules[0].profile: "Gone"',
                {
                    holder: { kind: 'rule' as const, number: 3, title: 'Macro' },
                    refers: 'profile' as const,
                    name: 'Night',
                },
            ],
            acknowledged: false,
        };
        settings.getImportReport = jest.fn().mockReturnValue(report);
        await expect(handlers['get-import-report']()).resolves.toEqual({ success: true, report });
        settings.getImportReport = jest.fn().mockReturnValue(null);
        await expect(handlers['get-import-report']()).resolves.toEqual({ success: true, report: null });
    });

    test('never throws to the renderer', async () => {
        settings.getImportReport = invalid(jest.fn(boom));
        await expect(handlers['get-import-report']()).resolves.toEqual({ success: false, error: 'boom' });
        settings.getImportReport = invalid(
            jest.fn(() => {
                throw null;
            }),
        );
        await expect(handlers['get-import-report']()).resolves.toEqual({
            success: false,
            error: 'The import report could not be read',
        });
    });
});

describe('get-settings-recovery', () => {
    test('reports the settings layer recovery, or null', async () => {
        settings.getSettingsRecovery = jest
            .fn()
            .mockReturnValue({ code: 'settings-corrupt', path: '/u/config.json.corrupt-1' });
        await expect(handlers['get-settings-recovery']()).resolves.toEqual({
            success: true,
            recovery: { code: 'settings-corrupt', path: '/u/config.json.corrupt-1' },
        });
        settings.getSettingsRecovery = jest.fn().mockReturnValue(null);
        settings.getSettingsSaveDropped = jest.fn().mockReturnValue(null);
        await expect(handlers['get-settings-recovery']()).resolves.toEqual({ success: true, recovery: null });
    });

    test('reports a change the window could not save when the stored settings are in use', async () => {
        settings.getSettingsRecovery = jest.fn().mockReturnValue(null);
        settings.getSettingsSaveDropped = jest
            .fn()
            .mockReturnValue({ code: 'settings-save-dropped', path: 'gurushots-config' });
        await expect(handlers['get-settings-recovery']()).resolves.toEqual({
            success: true,
            recovery: { code: 'settings-save-dropped', path: 'gurushots-config' },
        });
    });

    test('a recovery of the stored settings comes before a dropped save', async () => {
        settings.getSettingsRecovery = jest
            .fn()
            .mockReturnValue({ code: 'settings-unreadable', path: '/u/s.json', blocking: true });
        settings.getSettingsSaveDropped = jest
            .fn()
            .mockReturnValue({ code: 'settings-save-dropped', path: 'gurushots-config' });
        await expect(handlers['get-settings-recovery']()).resolves.toEqual({
            success: true,
            recovery: { code: 'settings-unreadable', path: '/u/s.json', blocking: true },
        });
    });
});

describe('a save the window gave up', () => {
    test('is announced like a settings change, with the settings as the window now has them', () => {
        const windows = installWindows();
        settings.loadSettings = jest.fn().mockReturnValue({ auth: { token: 'secret' }, app: { theme: 'dark' } });
        buildHandlers();

        const [listener] = settings.onSettingsSaveDroppedChange.mock.calls.at(-1) ?? [];
        listener?.();

        expect(windows.broadcastSettingsChanged).toHaveBeenCalledWith({ app: { theme: 'dark' }, hasToken: true });
    });
});

describe('a block a read cleared', () => {
    test('is announced like a settings change, so that a notice shown for it is read again', () => {
        const windows = installWindows();
        settings.loadSettings = jest.fn().mockReturnValue({ auth: { token: 'secret' }, app: { theme: 'dark' } });
        buildHandlers();

        const [listener] = settings.onSettingsRecoveryChange.mock.calls.at(-1) ?? [];
        listener?.();

        expect(windows.broadcastSettingsChanged).toHaveBeenCalledWith({ app: { theme: 'dark' }, hasToken: true });
    });
});

describe('get-third-party-notices', () => {
    test('returns the notices text', async () => {
        notices.loadThirdPartyNotices.mockResolvedValue('LICENSES');
        await expect(handlers['get-third-party-notices']()).resolves.toEqual({ success: true, text: 'LICENSES' });
    });

    test('an unreadable asset is an error result', async () => {
        notices.loadThirdPartyNotices.mockRejectedValue(new Error('ENOENT'));
        await expect(handlers['get-third-party-notices']()).resolves.toEqual({ success: false, error: 'ENOENT' });
    });

    test('falls back to a fixed message when the failure has none', async () => {
        notices.loadThirdPartyNotices.mockRejectedValue(null);
        await expect(handlers['get-third-party-notices']()).resolves.toEqual({
            success: false,
            error: 'The third-party notices could not be read',
        });
    });
});

describe('wipe-local-data', () => {
    test('wipes, then hands over to the shell', async () => {
        const windows = installWindows();
        localData.wipeLocalData.mockResolvedValue({ success: true, removed: ['x'] });
        await expect(buildHandlers()['wipe-local-data']()).resolves.toEqual({ success: true });
        expect(windows.afterWipe).toHaveBeenCalledTimes(1);
    });

    test('the hand-over without installed assertions is the platform no-op (CLI shape)', async () => {
        localData.wipeLocalData.mockResolvedValue({ success: true, removed: [] });
        await expect(handlers['wipe-local-data']()).resolves.toEqual({ success: true });
    });

    test('a refusal is passed on and the shell is not told to relaunch', async () => {
        const windows = installWindows();
        localData.wipeLocalData.mockResolvedValue({ success: false, error: 'busy' });
        await expect(buildHandlers()['wipe-local-data']()).resolves.toEqual({
            success: false,
            error: 'busy',
        });
        expect(windows.afterWipe).not.toHaveBeenCalled();
    });

    test('a partial failure keeps the reload request for the window to act on', async () => {
        const windows = installWindows();
        localData.wipeLocalData.mockResolvedValue({ success: false, error: 'x', removed: [], reload: true });
        await expect(buildHandlers()['wipe-local-data']()).resolves.toEqual({
            success: false,
            error: 'x',
            removed: [],
            reload: true,
        });
        expect(windows.afterWipe).not.toHaveBeenCalled();
    });

    test('never throws across IPC', async () => {
        localData.wipeLocalData.mockRejectedValue(new Error('boom'));
        await expect(handlers['wipe-local-data']()).resolves.toEqual({ success: false, error: 'boom' });
    });
});

describe('set-entry-pin', () => {
    // Builds the handler over a freshly installed platform whose windows the
    // test asserts on, and calls it.
    const pin = (...args: [unknown, unknown, unknown]) => {
        const windows = installWindows();
        const result = invalid<(event: unknown, ...a: unknown[]) => Promise<unknown>>(buildHandlers()['set-entry-pin'])(
            {},
            ...args,
        );
        return { windows, result };
    };

    test('pins a photo, broadcasts the change and answers success', async () => {
        jest.mocked(settings.setEntryPin).mockReturnValue('ok');
        jest.mocked(settings.loadSettings).mockReturnValue(
            invalid({ auth: { token: 'secret' }, app: { theme: 'dark' } }),
        );
        const { windows, result } = pin('boost', 100, 'img_a');
        await expect(result).resolves.toEqual({ success: true });
        expect(settings.setEntryPin).toHaveBeenCalledWith('boost', 100, 'img_a');
        expect(windows.broadcastSettingsChanged).toHaveBeenCalledWith({ app: { theme: 'dark' }, hasToken: true });
    });

    test('clears a pin (imageId null) and answers success', async () => {
        jest.mocked(settings.setEntryPin).mockReturnValue('ok');
        const { result } = pin('turbo', '100', null);
        await expect(result).resolves.toEqual({ success: true });
        expect(settings.setEntryPin).toHaveBeenCalledWith('turbo', '100', null);
    });

    test.each([
        ['an unknown feature', 'bogus', 100, 'img_a'],
        ['a missing feature', undefined, 100, 'img_a'],
        ['a challenge id that is not an id', 'boost', {}, 'img_a'],
        ['a blank challenge id', 'boost', '  ', 'img_a'],
        ['an image id that is not an id', 'boost', 100, {}],
        ['a blank image id', 'boost', 100, ''],
    ])('refuses %s without touching the settings or broadcasting', async (_name, kind, challengeId, imageId) => {
        const { windows, result } = pin(kind, challengeId, imageId);
        await expect(result).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
        expect(settings.setEntryPin).not.toHaveBeenCalled();
        expect(windows.broadcastSettingsChanged).not.toHaveBeenCalled();
    });

    test.each([
        ['a refused argument', 'invalid', 'invalid-args'],
        ['the pin cap', 'cap', 'pin-cap-reached'],
        ['a failed write', 'write-failed', 'pin-write-failed'],
    ] as const)('%s is its own error code, with no broadcast', async (_name, outcome, error) => {
        jest.mocked(settings.setEntryPin).mockReturnValue(outcome);
        const { windows, result } = pin('boost', 100, 'img_a');
        await expect(result).resolves.toEqual({ success: false, error });
        expect(windows.broadcastSettingsChanged).not.toHaveBeenCalled();
    });

    test('never throws across IPC', async () => {
        settings.setEntryPin = invalid(jest.fn(boom));
        const { result } = pin('boost', 100, 'img_a');
        await expect(result).resolves.toEqual({ success: false, error: 'boom' });
    });
});

describe('platform windows', () => {
    test('a successful save announces through the platform windows the handlers were built over', async () => {
        const windows = installWindows();
        settings.saveAppSettings = jest.fn().mockReturnValue(true);
        jest.mocked(settings.loadSettings).mockReturnValue(
            invalid({ auth: { token: 'secret' }, app: { theme: 'dark' } }),
        );

        const payload = { theme: 'dark' };
        await expect(buildHandlers()['save-settings'](invalid(undefined), payload)).resolves.toBe(true);

        expect(windows.broadcastSettingsChanged).toHaveBeenCalledWith({ app: { theme: 'dark' }, hasToken: true });
    });

    test('a landed wipe hands over to the platform windows once the wipe has been answered', async () => {
        const windows = installWindows();
        localData.wipeLocalData.mockResolvedValue({ success: true, removed: [] });

        await expect(buildHandlers()['wipe-local-data']()).resolves.toEqual({
            success: true,
        });
        expect(windows.afterWipe).toHaveBeenCalledTimes(1);
    });
});
