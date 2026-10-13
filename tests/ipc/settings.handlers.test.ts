/**
 * Tests for the hand-written (non-thin) channels in
 * settings.handlers.ts plus the Electron register() broadcast wiring.
 * The thin-handler rows are covered by settings.handlers.thin-table.test.ts.
 *
 * Every channel here has a documented error fallback the renderer relies on
 * (default settings, false, a schema-shaped empty object, …) — the handlers
 * must never throw across IPC.
 */

const getAllWindowsMock = jest.fn<unknown[], []>(() => []);
const relaunchMock = jest.fn<void, []>();
const exitMock = jest.fn<void, [number]>();

jest.mock('electron', () => ({
    BrowserWindow: { getAllWindows: getAllWindowsMock },
    app: { relaunch: relaunchMock, exit: exitMock },
}));
jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/settings/localData', () => ({ wipeLocalData: jest.fn() }));
jest.mock('../../src/ts/thirdPartyNotices', () => ({ loadThirdPartyNotices: jest.fn() }));
jest.mock('../../src/ts/metadata', () => ({ cleanupStaleMetadata: jest.fn() }));
jest.mock('../../src/ts/apiFactory', () => ({
    refreshApi: jest.fn(),
    getApiStrategy: jest.fn(),
    getMiddleware: jest.fn(),
}));

import type { IpcMain } from 'electron';
import { invalid } from '../helpers/invalid';

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
const { buildHandlers, register } = require('../../src/ts/ipc/settings.handlers') as typeof settings_handlersModule;

type ChannelImpl = Parameters<IpcMain['handle']>[1];

const boom = () => {
    throw new Error('boom');
};

let handlers: ReturnType<typeof buildHandlers>;

beforeEach(() => {
    jest.clearAllMocks();
    settings.getDefaultSettings = jest.fn().mockReturnValue({ theme: 'light', boostTime: 3600 });
    handlers = buildHandlers();
});

describe('get-settings', () => {
    test('returns the loaded settings without the token, plus hasToken', async () => {
        jest.mocked(settings.loadSettings).mockReturnValue(invalid({ token: 'secret', theme: 'dark' }));
        const result = await handlers['get-settings']();
        expect(result).toEqual({ theme: 'dark', hasToken: true });
        expect(result).not.toHaveProperty('token');
    });

    test('reports hasToken false for an empty or missing token', async () => {
        settings.loadSettings = jest.fn().mockReturnValue({ token: '', theme: 'dark' });
        await expect(handlers['get-settings']()).resolves.toEqual({ theme: 'dark', hasToken: false });
        settings.loadSettings = jest.fn().mockReturnValue({ theme: 'dark' });
        await expect(handlers['get-settings']()).resolves.toEqual({ theme: 'dark', hasToken: false });
    });

    test('falls back to defaults (still token-free) when loading throws', async () => {
        settings.loadSettings = jest.fn(boom);
        settings.getDefaultSettings = jest.fn().mockReturnValue({ token: '', theme: 'light', boostTime: 3600 });
        const result = await handlers['get-settings']();
        expect(result).toEqual({ theme: 'light', boostTime: 3600, hasToken: false });
        expect(result).not.toHaveProperty('token');
        expect(settings.getDefaultSettings).toHaveBeenCalled();
    });
});

describe('get-setting', () => {
    test('delegates a string key to settings.getSetting', async () => {
        settings.getSetting = jest.fn().mockReturnValue('dark');
        await expect(handlers['get-setting']({}, 'theme')).resolves.toBe('dark');
        expect(settings.getSetting).toHaveBeenCalledWith('theme');
    });

    test.each(['token', 'hasToken', 'apiHeaders'])('never returns the %s key', async (key) => {
        settings.getSetting = jest.fn().mockReturnValue('secret');
        await expect(handlers['get-setting']({}, key)).resolves.toBeNull();
        expect(settings.getSetting).not.toHaveBeenCalled();
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

    test.each(['token', 'hasToken', 'apiHeaders'])(
        'refuses to write the %s key and does not broadcast',
        async (key) => {
            const broadcastSettingsChange = jest.fn();
            settings.setSetting = jest.fn().mockReturnValue(true);
            const h = buildHandlers({ broadcastSettingsChange });
            await expect(h['set-setting']({}, key, 'planted')).resolves.toBe(false);
            expect(settings.setSetting).not.toHaveBeenCalled();
            expect(broadcastSettingsChange).not.toHaveBeenCalled();
        },
    );

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
        const broadcastSettingsChange = jest.fn();
        settings.setSetting = jest.fn().mockReturnValue(true);
        settings.loadSettings = jest.fn().mockReturnValue({ token: 'secret', language: 'lv', theme: 'dark' });
        const h = buildHandlers({ broadcastSettingsChange });

        await expect(h['set-setting']({}, 'language', 'lv')).resolves.toBe(true);
        expect(broadcastSettingsChange).toHaveBeenCalledWith({ language: 'lv', theme: 'dark', hasToken: true });
    });

    test('does not broadcast a rejected write', async () => {
        const broadcastSettingsChange = jest.fn();
        settings.setSetting = jest.fn().mockReturnValue(false);
        const h = buildHandlers({ broadcastSettingsChange });

        await expect(h['set-setting']({}, 'language', 'lv')).resolves.toBe(false);
        expect(broadcastSettingsChange).not.toHaveBeenCalled();
    });
});

describe('save-settings', () => {
    test('saves, then broadcasts the stored settings without the token', async () => {
        const broadcastSettingsChange = jest.fn();
        settings.saveSettings = jest.fn().mockReturnValue(true);
        settings.loadSettings = jest.fn().mockReturnValue({ token: 'secret', theme: 'dark', language: 'en' });
        const h = buildHandlers({ broadcastSettingsChange });

        await expect(h['save-settings']({}, { theme: 'dark' })).resolves.toBe(true);
        expect(settings.saveSettings).toHaveBeenCalledWith({ theme: 'dark' });
        expect(broadcastSettingsChange).toHaveBeenCalledWith({ theme: 'dark', language: 'en', hasToken: true });
    });

    test('strips apiHeaders from the payload too: a renderer cannot write the API headers', async () => {
        settings.saveSettings = jest.fn().mockReturnValue(true);
        settings.loadSettings = jest.fn().mockReturnValue({ theme: 'dark', apiHeaders: { a: 'b' } });
        await expect(handlers['save-settings']({}, { apiHeaders: { evil: '1' }, theme: 'dark' })).resolves.toBe(true);
        expect(settings.saveSettings).toHaveBeenCalledWith({ theme: 'dark' });
    });

    test('get-settings then save-settings round-trips without touching the stored API headers', async () => {
        const stored = { token: 'secret', theme: 'dark', apiHeaders: { a: 'b' } };
        settings.loadSettings = jest.fn().mockReturnValue(stored);
        settings.saveSettings = jest.fn().mockReturnValue(true);
        const fetched = await handlers['get-settings']();
        expect(fetched).not.toHaveProperty('apiHeaders');
        await expect(handlers['save-settings']({}, fetched)).resolves.toBe(true);
        expect(settings.saveSettings).toHaveBeenCalledWith({ theme: 'dark' });
    });

    test('strips token and hasToken from the payload before saving and from the broadcast', async () => {
        const broadcastSettingsChange = jest.fn();
        settings.saveSettings = jest.fn().mockReturnValue(true);
        settings.loadSettings = jest.fn().mockReturnValue({ token: 'stored', theme: 'dark' });
        const h = buildHandlers({ broadcastSettingsChange });

        await expect(h['save-settings']({}, { token: 'planted', hasToken: false, theme: 'dark' })).resolves.toBe(true);
        expect(settings.saveSettings).toHaveBeenCalledWith({ theme: 'dark' });
        expect(broadcastSettingsChange).toHaveBeenCalledWith({ theme: 'dark', hasToken: true });
    });

    test('does not broadcast when the save fails', async () => {
        const broadcastSettingsChange = jest.fn();
        settings.saveSettings = jest.fn().mockReturnValue(false);
        const h = buildHandlers({ broadcastSettingsChange });

        await expect(h['save-settings']({}, { theme: 'dark' })).resolves.toBe(false);
        expect(broadcastSettingsChange).not.toHaveBeenCalled();
    });

    test('succeeds without a broadcaster (CLI / Capacitor shape)', async () => {
        settings.saveSettings = jest.fn().mockReturnValue(true);
        await expect(handlers['save-settings']({}, { theme: 'dark' })).resolves.toBe(true);
    });

    test.each([null, 'str', 5, undefined])('rejects non-object payload %p', async (bad) => {
        settings.saveSettings = jest.fn();
        await expect(handlers['save-settings']({}, invalid(bad))).resolves.toBe(false);
        expect(settings.saveSettings).not.toHaveBeenCalled();
    });

    test('returns false when saveSettings throws', async () => {
        settings.saveSettings = invalid(jest.fn(boom));
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

    test('ids are compared the way perChallenge is keyed: numeric ids become strings, untrimmed ones are trimmed', async () => {
        jest.mocked(settings.cleanupStaleChallengeSetting).mockReturnValue(true);
        await handlers['cleanup-stale-challenge-setting']({}, [7, ' 8 ', '9']);
        expect(settings.cleanupStaleChallengeSetting).toHaveBeenCalledWith(['7', '8', '9']);
    });

    test.each([
        ['not an array', 'abc'],
        ['missing', undefined],
        ['empty, which would prune every challenge', []],
        ['an item that is not an id', ['1', {}]],
        ['a blank id', ['1', '  ']],
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

describe('get-settings-recovery', () => {
    test('reports the settings layer recovery, or null', async () => {
        settings.getSettingsRecovery = jest
            .fn()
            .mockReturnValue({ code: 'settings-corrupt', path: '/u/settings.json.corrupt-1' });
        await expect(handlers['get-settings-recovery']()).resolves.toEqual({
            success: true,
            recovery: { code: 'settings-corrupt', path: '/u/settings.json.corrupt-1' },
        });
        settings.getSettingsRecovery = jest.fn().mockReturnValue(null);
        settings.getSettingsSaveDropped = jest.fn().mockReturnValue(null);
        await expect(handlers['get-settings-recovery']()).resolves.toEqual({ success: true, recovery: null });
    });

    test('reports a change the window could not save when the stored settings are in use', async () => {
        settings.getSettingsRecovery = jest.fn().mockReturnValue(null);
        settings.getSettingsSaveDropped = jest
            .fn()
            .mockReturnValue({ code: 'settings-save-dropped', path: 'gurushots-settings' });
        await expect(handlers['get-settings-recovery']()).resolves.toEqual({
            success: true,
            recovery: { code: 'settings-save-dropped', path: 'gurushots-settings' },
        });
    });

    test('a recovery of the stored settings comes before a dropped save', async () => {
        settings.getSettingsRecovery = jest.fn().mockReturnValue({ code: 'settings-unreadable', path: '/u/s.json' });
        settings.getSettingsSaveDropped = jest
            .fn()
            .mockReturnValue({ code: 'settings-save-dropped', path: 'gurushots-settings' });
        await expect(handlers['get-settings-recovery']()).resolves.toEqual({
            success: true,
            recovery: { code: 'settings-unreadable', path: '/u/s.json' },
        });
    });
});

describe('a save the window gave up', () => {
    test('is announced like a settings change, with the settings as the window now has them', () => {
        const broadcast = jest.fn();
        settings.loadSettings = jest.fn().mockReturnValue({ token: 'secret', theme: 'dark' });
        buildHandlers({ broadcastSettingsChange: broadcast });

        const [listener] = settings.onSettingsSaveDroppedChange.mock.calls.at(-1) ?? [];
        listener?.();

        expect(broadcast).toHaveBeenCalledWith({ theme: 'dark', hasToken: true });
    });

    test('is not listened for where nothing is announced', () => {
        settings.onSettingsSaveDroppedChange.mockClear();
        buildHandlers();
        expect(settings.onSettingsSaveDroppedChange).not.toHaveBeenCalled();
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
        const afterWipe = jest.fn();
        localData.wipeLocalData.mockResolvedValue({ success: true, removed: ['x'] });
        await expect(buildHandlers({ afterWipe })['wipe-local-data']()).resolves.toEqual({ success: true });
        expect(afterWipe).toHaveBeenCalledTimes(1);
    });

    test('works without a shell hook (CLI shape)', async () => {
        localData.wipeLocalData.mockResolvedValue({ success: true, removed: [] });
        await expect(handlers['wipe-local-data']()).resolves.toEqual({ success: true });
    });

    test('a refusal is passed on and the shell is not told to relaunch', async () => {
        const afterWipe = jest.fn();
        localData.wipeLocalData.mockResolvedValue({ success: false, error: 'busy' });
        await expect(buildHandlers({ afterWipe })['wipe-local-data']()).resolves.toEqual({
            success: false,
            error: 'busy',
        });
        expect(afterWipe).not.toHaveBeenCalled();
    });

    test('a partial failure keeps the reload request for the window to act on', async () => {
        const afterWipe = jest.fn();
        localData.wipeLocalData.mockResolvedValue({ success: false, error: 'x', removed: [], reload: true });
        await expect(buildHandlers({ afterWipe })['wipe-local-data']()).resolves.toEqual({
            success: false,
            error: 'x',
            removed: [],
            reload: true,
        });
        expect(afterWipe).not.toHaveBeenCalled();
    });

    test('never throws across IPC', async () => {
        localData.wipeLocalData.mockRejectedValue(new Error('boom'));
        await expect(handlers['wipe-local-data']()).resolves.toEqual({ success: false, error: 'boom' });
    });
});

describe('clear-chosen-photos', () => {
    test('removes the lists, broadcasts the change and reports how many went', async () => {
        const broadcast = jest.fn();
        jest.mocked(settings.clearChosenPhotos).mockReturnValue(4);
        jest.mocked(settings.loadSettings).mockReturnValue(invalid({ token: 'secret', theme: 'dark' }));
        await expect(buildHandlers({ broadcastSettingsChange: broadcast })['clear-chosen-photos']()).resolves.toEqual({
            success: true,
            removed: 4,
        });
        expect(broadcast).toHaveBeenCalledWith({ theme: 'dark', hasToken: true });
    });

    test('works without a broadcast listener', async () => {
        jest.mocked(settings.clearChosenPhotos).mockReturnValue(0);
        await expect(handlers['clear-chosen-photos']()).resolves.toEqual({ success: true, removed: 0 });
    });

    test('a save that failed is an error result, with no broadcast', async () => {
        const broadcast = jest.fn();
        jest.mocked(settings.clearChosenPhotos).mockReturnValue(null);
        await expect(buildHandlers({ broadcastSettingsChange: broadcast })['clear-chosen-photos']()).resolves.toEqual({
            success: false,
            error: 'The settings file could not be saved',
        });
        expect(broadcast).not.toHaveBeenCalled();
    });

    test('never throws across IPC', async () => {
        settings.clearChosenPhotos = invalid(jest.fn(boom));
        await expect(handlers['clear-chosen-photos']()).resolves.toEqual({ success: false, error: 'boom' });
    });
});

describe('set-entry-pin', () => {
    const pin = (broadcast?: jest.Mock<void, [object]>, ...args: [unknown, unknown, unknown]) =>
        invalid<(event: unknown, ...a: unknown[]) => Promise<unknown>>(
            buildHandlers({ broadcastSettingsChange: broadcast })['set-entry-pin'],
        )({}, ...args);

    test('pins a photo, broadcasts the change and answers success', async () => {
        const broadcast = jest.fn();
        jest.mocked(settings.setEntryPin).mockReturnValue('ok');
        jest.mocked(settings.loadSettings).mockReturnValue(invalid({ token: 'secret', theme: 'dark' }));
        await expect(pin(broadcast, 'boost', 100, 'img_a')).resolves.toEqual({ success: true });
        expect(settings.setEntryPin).toHaveBeenCalledWith('boost', 100, 'img_a');
        expect(broadcast).toHaveBeenCalledWith({ theme: 'dark', hasToken: true });
    });

    test('clears a pin (imageId null) and works without a broadcast listener', async () => {
        jest.mocked(settings.setEntryPin).mockReturnValue('ok');
        await expect(pin(undefined, 'turbo', '100', null)).resolves.toEqual({ success: true });
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
        const broadcast = jest.fn();
        await expect(pin(broadcast, kind, challengeId, imageId)).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
        expect(settings.setEntryPin).not.toHaveBeenCalled();
        expect(broadcast).not.toHaveBeenCalled();
    });

    test.each([
        ['a refused argument', 'invalid', 'invalid-args'],
        ['the pin cap', 'cap', 'pin-cap-reached'],
        ['a failed write', 'write-failed', 'pin-write-failed'],
    ] as const)('%s is its own error code, with no broadcast', async (_name, outcome, error) => {
        const broadcast = jest.fn();
        jest.mocked(settings.setEntryPin).mockReturnValue(outcome);
        await expect(pin(broadcast, 'boost', 100, 'has space')).resolves.toEqual({ success: false, error });
        expect(broadcast).not.toHaveBeenCalled();
    });

    test('never throws across IPC', async () => {
        settings.setEntryPin = invalid(jest.fn(boom));
        await expect(pin(undefined, 'boost', 100, 'img_a')).resolves.toEqual({ success: false, error: 'boom' });
    });
});

describe('register (Electron)', () => {
    const makeIpcMain = () => {
        const channels = new Map<string, ChannelImpl>();
        return { channels, handle: (channel: string, impl: ChannelImpl) => channels.set(channel, impl) };
    };

    test('registers every built channel', () => {
        const ipcMain = makeIpcMain();
        register(invalid(ipcMain));
        expect([...ipcMain.channels.keys()].sort()).toEqual(Object.keys(buildHandlers()).sort());
    });

    test('broadcasts settings-changed to every open window after a successful save', async () => {
        const winA = { isDestroyed: () => false, webContents: { send: jest.fn() } };
        const winB = { isDestroyed: () => false, webContents: { send: jest.fn() } };
        getAllWindowsMock.mockReturnValue([winA, winB]);
        settings.saveSettings = jest.fn().mockReturnValue(true);
        jest.mocked(settings.loadSettings).mockReturnValue(invalid({ token: 'secret', theme: 'dark' }));
        const ipcMain = makeIpcMain();
        register(invalid(ipcMain));

        const payload = { theme: 'dark' };
        await expect(ipcMain.channels.get('save-settings')!(invalid(undefined), payload)).resolves.toBe(true);

        const sent = { theme: 'dark', hasToken: true };
        expect(winA.webContents.send).toHaveBeenCalledWith('settings-changed', sent);
        expect(winB.webContents.send).toHaveBeenCalledWith('settings-changed', sent);
    });

    test('relaunches the app once the wipe has been answered', async () => {
        jest.useFakeTimers();
        try {
            localData.wipeLocalData.mockResolvedValue({ success: true, removed: [] });
            const ipcMain = makeIpcMain();
            register(invalid(ipcMain));

            await expect(ipcMain.channels.get('wipe-local-data')!(invalid(undefined))).resolves.toEqual({
                success: true,
            });
            expect(relaunchMock).not.toHaveBeenCalled();
            jest.advanceTimersByTime(200);
            expect(relaunchMock).toHaveBeenCalledTimes(1);
            expect(exitMock).toHaveBeenCalledWith(0);
        } finally {
            jest.useRealTimers();
        }
    });

    test('skips a window destroyed mid-save and still reports the write as saved', async () => {
        const closed = {
            isDestroyed: () => true,
            webContents: {
                send: jest.fn(() => {
                    throw new Error('Object has been destroyed');
                }),
            },
        };
        const open = { isDestroyed: () => false, webContents: { send: jest.fn() } };
        getAllWindowsMock.mockReturnValue([closed, open]);
        settings.saveSettings = jest.fn().mockReturnValue(true);
        settings.loadSettings = jest.fn().mockReturnValue({ theme: 'dark' });
        const ipcMain = makeIpcMain();
        register(invalid(ipcMain));

        await expect(ipcMain.channels.get('save-settings')!(invalid(undefined), { theme: 'dark' })).resolves.toBe(true);

        expect(closed.webContents.send).not.toHaveBeenCalled();
        expect(open.webContents.send).toHaveBeenCalledWith('settings-changed', { theme: 'dark', hasToken: false });
    });
});
