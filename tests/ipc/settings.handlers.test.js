/**
 * Tests for the hand-written (non-THIN_HANDLERS) channels in
 * settings.handlers.js plus the Electron register() broadcast wiring.
 * The THIN_HANDLERS table is covered by settings.handlers.thin-table.test.js.
 *
 * Every channel here has a documented error fallback the renderer relies on
 * (default settings, false, a schema-shaped empty object, …) — the handlers
 * must never throw across IPC.
 */

const getAllWindowsMock = jest.fn(() => []);

jest.mock('electron', () => ({
    BrowserWindow: { getAllWindows: getAllWindowsMock },
}));
jest.mock('../../src/js/settings');
jest.mock('../../src/js/metadata', () => ({ cleanupStaleMetadata: jest.fn() }));
jest.mock('../../src/js/apiFactory', () => ({
    refreshApi: jest.fn(),
    getApiStrategy: jest.fn(),
    getMiddleware: jest.fn(),
}));

const settings = require('../../src/js/settings');
const metadata = require('../../src/js/metadata');
const apiFactory = require('../../src/js/apiFactory');
const { buildHandlers, register } = require('../../src/js/ipc/settings.handlers');

const boom = () => {
    throw new Error('boom');
};

let handlers;

beforeEach(() => {
    jest.clearAllMocks();
    settings.getDefaultSettings = jest.fn().mockReturnValue({ theme: 'light', boostTime: 3600 });
    handlers = buildHandlers();
});

describe('get-settings', () => {
    test('returns the loaded settings', async () => {
        settings.loadSettings = jest.fn().mockReturnValue({ token: 't', theme: 'dark' });
        await expect(handlers['get-settings']()).resolves.toEqual({ token: 't', theme: 'dark' });
    });

    test('falls back to defaults when loading throws', async () => {
        settings.loadSettings = jest.fn(boom);
        await expect(handlers['get-settings']()).resolves.toEqual({ theme: 'light', boostTime: 3600 });
        expect(settings.getDefaultSettings).toHaveBeenCalled();
    });
});

describe('get-setting', () => {
    test('delegates a string key to settings.getSetting', async () => {
        settings.getSetting = jest.fn().mockReturnValue('dark');
        await expect(handlers['get-setting']({}, 'theme')).resolves.toBe('dark');
        expect(settings.getSetting).toHaveBeenCalledWith('theme');
    });

    test('rejects a non-string key and returns null (no default for it)', async () => {
        settings.getSetting = jest.fn();
        await expect(handlers['get-setting']({}, 42)).resolves.toBeNull();
        expect(settings.getSetting).not.toHaveBeenCalled();
    });

    test('returns the key default when getSetting throws', async () => {
        settings.getSetting = jest.fn(boom);
        await expect(handlers['get-setting']({}, 'theme')).resolves.toBe('light');
    });

    test('returns null when getSetting throws for a key with no default', async () => {
        settings.getSetting = jest.fn(boom);
        await expect(handlers['get-setting']({}, 'unknownKey')).resolves.toBeNull();
    });
});

describe('set-setting', () => {
    test('delegates to settings.setSetting and returns its result', async () => {
        settings.setSetting = jest.fn().mockReturnValue(true);
        await expect(handlers['set-setting']({}, 'theme', 'dark')).resolves.toBe(true);
        expect(settings.setSetting).toHaveBeenCalledWith('theme', 'dark');
    });

    test('returns false for a non-string key without writing', async () => {
        settings.setSetting = jest.fn();
        await expect(handlers['set-setting']({}, null, 'x')).resolves.toBe(false);
        expect(settings.setSetting).not.toHaveBeenCalled();
    });

    test('returns false when setSetting throws', async () => {
        settings.setSetting = jest.fn(boom);
        await expect(handlers['set-setting']({}, 'theme', 'dark')).resolves.toBe(false);
    });
});

describe('save-settings', () => {
    test('saves and broadcasts the new settings on success', async () => {
        const broadcastSettingsChange = jest.fn();
        settings.saveSettings = jest.fn().mockReturnValue(true);
        const h = buildHandlers({ broadcastSettingsChange });
        const payload = { theme: 'dark' };

        await expect(h['save-settings']({}, payload)).resolves.toBe(true);
        expect(settings.saveSettings).toHaveBeenCalledWith(payload);
        expect(broadcastSettingsChange).toHaveBeenCalledWith(payload);
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
        await expect(handlers['save-settings']({}, bad)).resolves.toBe(false);
        expect(settings.saveSettings).not.toHaveBeenCalled();
    });

    test('returns false when saveSettings throws', async () => {
        settings.saveSettings = jest.fn(boom);
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

describe('boost threshold channels', () => {
    test('get-boost-threshold reads the effective boostTime for the challenge', async () => {
        settings.getEffectiveSetting = jest.fn().mockReturnValue(900);
        await expect(handlers['get-boost-threshold']({}, 'c1')).resolves.toBe(900);
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('boostTime', 'c1');
    });

    test('get-boost-threshold falls back to the schema default when it throws', async () => {
        settings.getEffectiveSetting = jest.fn(boom);
        settings.SETTINGS_SCHEMA = { boostTime: { default: 1234 } };
        await expect(handlers['get-boost-threshold']({}, 'c1')).resolves.toBe(1234);
    });

    test('set-boost-threshold writes a stringified per-challenge override', async () => {
        settings.setChallengeOverride = jest.fn();
        await expect(handlers['set-boost-threshold']({}, 42, 600)).resolves.toEqual({ success: true });
        expect(settings.setChallengeOverride).toHaveBeenCalledWith('boostTime', '42', 600);
    });

    test('set-boost-threshold returns the error envelope when challengeId is missing', async () => {
        settings.setChallengeOverride = jest.fn();
        const result = await handlers['set-boost-threshold']({}, undefined, 600);
        expect(result.success).toBe(false);
        expect(typeof result.error).toBe('string');
        expect(settings.setChallengeOverride).not.toHaveBeenCalled();
    });

    test('set-default-boost-threshold writes the global default', async () => {
        settings.setGlobalDefault = jest.fn();
        await expect(handlers['set-default-boost-threshold']({}, 300)).resolves.toEqual({ success: true });
        expect(settings.setGlobalDefault).toHaveBeenCalledWith('boostTime', 300);
    });

    test('set-default-boost-threshold returns the error envelope when it throws', async () => {
        settings.setGlobalDefault = jest.fn(boom);
        await expect(handlers['set-default-boost-threshold']({}, 300)).resolves.toEqual({
            success: false,
            error: 'boom',
        });
    });

    test.each([
        ['set-boost-threshold', 'setChallengeOverride', ['c1', 600], 'Failed to set boost threshold'],
        ['set-default-boost-threshold', 'setGlobalDefault', [300], 'Failed to set default boost threshold'],
    ])('%s falls back to a fixed message when the write throws null', async (channel, method, args, expected) => {
        settings[method] = jest.fn(() => {
            throw null;
        });
        await expect(handlers[channel]({}, ...args)).resolves.toEqual({ success: false, error: expected });
    });
});

describe('get-settings-schema', () => {
    test('serialises only the whitelisted schema fields plus defaults, groups, tiers and profile caps', async () => {
        settings.SETTINGS_SCHEMA = {
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
        };
        settings.SETTINGS_GROUPS = ['boost'];
        settings.SETTINGS_TIERS = { basic: ['boostTime'] };
        settings.MAX_CHALLENGE_PROFILES = 20;
        settings.MAX_PROFILE_NAME_LENGTH = 40;
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
        expect(result.schema.boostTime.validate).toBeUndefined();
    });

    test('returns an empty schema shape when building it throws', async () => {
        settings.SETTINGS_SCHEMA = { boostTime: { type: 'number' } };
        settings.getGlobalDefault = jest.fn(boom);
        await expect(handlers['get-settings-schema']()).resolves.toEqual({ schema: {}, defaults: {} });
    });
});

describe('cleanup-stale-metadata', () => {
    test('delegates the active ids to metadata.cleanupStaleMetadata', async () => {
        metadata.cleanupStaleMetadata.mockReturnValue(true);
        await expect(handlers['cleanup-stale-metadata']({}, [1, 2])).resolves.toBe(true);
        expect(metadata.cleanupStaleMetadata).toHaveBeenCalledWith([1, 2]);
    });

    test('returns false when cleanup throws', async () => {
        metadata.cleanupStaleMetadata.mockImplementationOnce(boom);
        await expect(handlers['cleanup-stale-metadata']({}, [1])).resolves.toBe(false);
    });
});

describe('register (Electron)', () => {
    const makeIpcMain = () => {
        const channels = new Map();
        return { channels, handle: (channel, impl) => channels.set(channel, impl) };
    };

    test('registers every built channel', () => {
        const ipcMain = makeIpcMain();
        register(ipcMain);
        expect([...ipcMain.channels.keys()].sort()).toEqual(Object.keys(buildHandlers()).sort());
    });

    test('broadcasts settings-changed to every open window after a successful save', async () => {
        const winA = { webContents: { send: jest.fn() } };
        const winB = { webContents: { send: jest.fn() } };
        getAllWindowsMock.mockReturnValue([winA, winB]);
        settings.saveSettings = jest.fn().mockReturnValue(true);
        const ipcMain = makeIpcMain();
        register(ipcMain);

        const payload = { theme: 'dark' };
        await expect(ipcMain.channels.get('save-settings')(undefined, payload)).resolves.toBe(true);

        expect(winA.webContents.send).toHaveBeenCalledWith('settings-changed', payload);
        expect(winB.webContents.send).toHaveBeenCalledWith('settings-changed', payload);
    });
});
