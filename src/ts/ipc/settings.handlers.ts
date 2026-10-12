/**
 * IPC handlers for everything settings-shaped: load/save, schema,
 * per-challenge overrides, and the bulk-registered
 * "thin" passthrough handlers that just delegate to a settings.*
 * method with a uniform try/catch shape.
 *
 * Also hosts get-environment-info, refresh-api, cleanup-stale-
 * metadata, the stored-settings recovery notice, the third-party notices and
 * the delete-all-local-data wipe since those are the small remaining
 * settings-adjacent orchestration channels.
 */

// Lazy require: esbuild must not resolve electron when this module is bundled
// into the Capacitor renderer; only register() uses BrowserWindow.
let BrowserWindow: typeof electronModule.BrowserWindow | null = null;
let electronApp: typeof electronModule.app | null = null;
try {
    const electron = require('electron') as typeof import('electron');
    BrowserWindow = electron.BrowserWindow;
    electronApp = electron.app;
} catch {
    // Capacitor / CLI: register() in this module is never reached.
}
import * as settings from '../settings';
import { registerHandlers, type IpcHandlerMap, type IpcHandler } from './registerHandlers';
import { errorResult } from './errorResult';
import { toRendererSettings, isRendererHiddenKey, withoutRendererHiddenKeys } from './rendererSettings';
import * as logger from '../logger';
import * as apiFactory from '../apiFactory';
import * as metadata from '../metadata';
import { stampChosenPhotosOwner } from './chosenPhotosOwner';
import { isIdArg } from './isIdArg';
import { refuseInvalidArgs } from './actions/shared';
import { wipeLocalData } from '../settings/localData';
import { loadThirdPartyNotices } from '../thirdPartyNotices';

import type { IpcMain } from 'electron';
import type { SettingsSchemaEntry } from '../settings/schema';
import type { AppSettings } from '../types/settings';
import type * as electronModule from 'electron';

/**
 * The renderer-facing projection of one schema entry (no validators).
 */
export type SerializableSchemaEntry = Pick<
    SettingsSchemaEntry,
    'type' | 'default' | 'perChallenge' | 'group' | 'label' | 'description' | 'helpKey' | 'min' | 'max' | 'unit'
> & { challengeOnly: boolean };

/**
 * A settings write listener: receives the settings to broadcast to every
 * renderer after a successful user-facing write.
 */
type BroadcastSettingsChange = (settings: object) => void;

/**
 * What a shell hands the settings handlers: where a write is announced, and what happens once
 * all local data has been deleted (relaunch to the login screen).
 */
type SettingsHandlerOptions = { broadcastSettingsChange?: BroadcastSettingsChange; afterWipe?: () => void };

// Where the challenge id sits in each thin channel's arguments, and whether the channel may be called without one.
// An id that is not a plain id (a non-blank string of bounded length, or a number) never reaches the settings.
const CHALLENGE_ID_ARGS: Record<string, { index: number; optional?: boolean }> = {
    'get-challenge-override': { index: 1 },
    'set-challenge-override': { index: 1 },
    'set-challenge-overrides': { index: 0 },
    'remove-challenge-override': { index: 1 },
    'get-effective-setting': { index: 1, optional: true },
    'get-challenge-overrides': { index: 0 },
    'replace-challenge-overrides': { index: 0 },
    'apply-challenge-profile': { index: 1 },
};

// Channels that just delegate to a settings facade method. Each row:
// [channel, lazy method lookup, fallback-on-error, verb-for-log]. The lookup
// runs per call, so the handler always reaches the facade's current method.
const thinRows = () =>
    [
        ['get-validation-error', () => settings.getValidationError, 'Validation error', 'getting validation error'],
        ['get-global-default', () => settings.getGlobalDefault, null, 'getting global default'],
        ['set-global-default', () => settings.setGlobalDefault, false, 'setting global default'],
        ['get-challenge-override', () => settings.getChallengeOverride, false, 'getting challenge override'],
        ['set-challenge-override', () => settings.setChallengeOverride, false, 'setting challenge override'],
        ['set-challenge-overrides', () => settings.setChallengeOverrides, false, 'setting challenge overrides'],
        ['remove-challenge-override', () => settings.removeChallengeOverride, false, 'removing challenge override'],
        ['get-effective-setting', () => settings.getEffectiveSetting, null, 'getting effective setting'],
        ['get-title-rules', () => settings.getTitleRules, null, 'getting title rules'],
        ['set-title-rules', () => settings.setTitleRules, false, 'setting title rules'],
        ['get-title-profile', () => settings.getTitleProfile, null, 'getting title profile'],
        ['get-challenge-overrides', () => settings.getChallengeOverrides, null, 'getting challenge overrides'],
        [
            'replace-challenge-overrides',
            () => settings.replaceChallengeOverrides,
            false,
            'replacing challenge overrides',
        ],
        ['get-challenge-profiles', () => settings.getChallengeProfiles, null, 'getting challenge profiles'],
        ['save-challenge-profile', () => settings.saveChallengeProfile, false, 'saving challenge profile'],
        ['delete-challenge-profile', () => settings.deleteChallengeProfile, false, 'deleting challenge profile'],
        ['apply-challenge-profile', () => settings.applyChallengeProfile, false, 'applying challenge profile'],
        ['cleanup-obsolete-settings', () => settings.cleanupObsoleteSettings, false, 'cleaning up obsolete settings'],
        ['reset-setting', () => settings.resetSetting, false, 'resetting setting'],
        ['reset-global-default', () => settings.resetGlobalDefault, false, 'resetting global default'],
        ['reset-all-global-defaults', () => settings.resetAllGlobalDefaults, false, 'resetting all global defaults'],
        ['reset-all-settings', () => settings.resetAllSettings, false, 'resetting all settings'],
        ['is-setting-modified', () => settings.isSettingModified, false, 'checking if setting is modified'],
        [
            'is-global-default-modified',
            () => settings.isGlobalDefaultModified,
            false,
            'checking if global default is modified',
        ],
    ] as const;

type ThinRow = ReturnType<typeof thinRows>[number];

/**
 * Each thin channel as a handler: the facade method's arguments, resolving to
 * its result or the row's fallback on error.
 */
type ThinHandlers = {
    [R in ThinRow as R[0]]: (
        event: unknown,
        ...args: Parameters<ReturnType<R[1]>>
    ) => Promise<ReturnType<ReturnType<R[1]>> | R[2]>;
};

// Capacitor has no filesystem watcher to rebroadcast settings mutations, and
// Electron's watcher reloads only the main window for reload-required keys.
// Notify every renderer subscriber after a successful user-facing write so
// cards immediately re-read effective global/profile/per-challenge values and
// every open window follows a saved language (set-setting broadcasts too).
const CHANGE_BROADCAST_CHANNELS = new Set([
    'set-global-default',
    'set-challenge-override',
    'set-challenge-overrides',
    'remove-challenge-override',
    'set-title-rules',
    'replace-challenge-overrides',
    'save-challenge-profile',
    'delete-challenge-profile',
    'apply-challenge-profile',
    'reset-setting',
    'reset-global-default',
    'reset-all-global-defaults',
    'reset-all-settings',
]);

// The writes that can carry a Chosen Photos list, after which the saving
// account is recorded (see chosenPhotosOwner.ts).
const CHOSEN_LIST_CHANNELS = new Set([
    'set-global-default',
    'set-challenge-override',
    'set-challenge-overrides',
    'replace-challenge-overrides',
    'set-title-rules',
    'save-challenge-profile',
]);

const handleGetSetting = async (key: string) => {
    try {
        if (typeof key !== 'string') {
            throw new Error('Invalid key type, expected string');
        }
        // The token never reaches a renderer; hasToken lives on get-settings.
        if (isRendererHiddenKey(key)) return null;
        return settings.getSetting(key);
    } catch (error) {
        logger.withCategory('settings').error(`Error handling get-setting request for key "${key}":`, error);
        // A non-string key reaches here too; indexing coerces it like any
        // property access (and misses, falling back to null).
        const defaultSettings = settings.getDefaultSettings() as Record<string, unknown>;
        return Object.hasOwn(defaultSettings, key) && defaultSettings[key] !== undefined ? defaultSettings[key] : null;
    }
};

const handleSetSetting = async (
    broadcastSettingsChange: BroadcastSettingsChange | undefined,
    key: string,
    value: unknown,
) => {
    try {
        if (typeof key !== 'string') {
            throw new Error('Invalid key type, expected string');
        }
        // A renderer can neither plant a token nor persist the derived hasToken.
        if (isRendererHiddenKey(key)) return false;
        const result = settings.setSetting(key, value);
        if (result && typeof broadcastSettingsChange === 'function') {
            broadcastSettingsChange(toRendererSettings(settings.loadSettings()));
        }
        return result;
    } catch (error) {
        logger.withCategory('settings').error(`Error handling set-setting request for key "${key}":`, error);
        return false;
    }
};

// A user-initiated removal of every saved Chosen Photos list (see settings/chosenPhotosClear.ts).
const handleClearChosenPhotos = async (broadcastSettingsChange: BroadcastSettingsChange | undefined) => {
    try {
        const removed = settings.clearChosenPhotos();
        if (removed === null) return { success: false as const, error: 'The settings file could not be saved' };
        if (typeof broadcastSettingsChange === 'function') {
            broadcastSettingsChange(toRendererSettings(settings.loadSettings()));
        }
        return { success: true as const, removed };
    } catch (error) {
        logger.withCategory('settings').error('Error handling clear-chosen-photos request:', error);
        return errorResult(error, 'Failed to clear chosen photos');
    }
};

const buildSettingsHandlers = ({ broadcastSettingsChange }: SettingsHandlerOptions) => ({
    'get-settings': async () => {
        try {
            return toRendererSettings(settings.loadSettings());
        } catch (error) {
            logger.withCategory('settings').error('Error handling get-settings request:', error);
            return toRendererSettings(settings.getDefaultSettings());
        }
    },

    'get-setting': (event: unknown, key: string) => handleGetSetting(key),

    'set-setting': (event: unknown, key: string, value: unknown) =>
        handleSetSetting(broadcastSettingsChange, key, value),

    'cleanup-stale-challenge-setting': handleCleanupStaleChallengeSetting,

    'clear-chosen-photos': async () => handleClearChosenPhotos(broadcastSettingsChange),

    'save-settings': async (event: unknown, newSettings: Partial<AppSettings>) => {
        try {
            if (typeof newSettings !== 'object' || newSettings === null) {
                throw new Error('Invalid settings type, expected object');
            }
            // Only the object shape is checked here; the facade validates each
            // key. The token, its derived flag and the API headers are not renderer-writable.
            const result = settings.saveSettings(withoutRendererHiddenKeys(newSettings));
            if (result && typeof broadcastSettingsChange === 'function') {
                broadcastSettingsChange(toRendererSettings(settings.loadSettings()));
            }
            return result;
        } catch (error) {
            logger.withCategory('settings').error('Error handling save-settings request:', error);
            return false;
        }
    },
});

// Prunes the settings of every challenge not in the given list, so the list is
// checked: a non-array, an empty one, or one holding anything but ids would
// empty the lot. Ids are compared as the trimmed strings perChallenge is keyed by.
// The settings layer then prunes only what the main process's own active list also lacks.
// In mock mode the active list holds the mock challenges' ids, so pruning against it would delete the real ones' data:
// both cleanup channels do nothing then.
const handleCleanupStaleChallengeSetting = async (event: unknown, activeChallengeIds: Array<string | number>) => {
    if (!Array.isArray(activeChallengeIds) || activeChallengeIds.length === 0 || !activeChallengeIds.every(isIdArg)) {
        return refuseInvalidArgs('settings', 'cleanup-stale-challenge-setting');
    }
    try {
        if (settings.getSetting('mock') === true) return { success: true as const };
        const saved = settings.cleanupStaleChallengeSetting(activeChallengeIds.map((id) => String(id).trim()));
        return saved
            ? { success: true as const }
            : { success: false as const, error: 'The settings file could not be saved' };
    } catch (error) {
        logger.withCategory('settings').error('Error cleaning up stale challenge settings:', error);
        return errorResult(error, 'Failed to clean up stale challenge settings');
    }
};

const buildEnvironmentHandlers = () => ({
    'get-environment-info': async () => {
        try {
            return settings.getEnvironmentInfo();
        } catch (error) {
            logger.withCategory('api').error('Error handling get-environment-info request:', error);
            return {
                nodeEnv: 'unknown',
                dev: undefined,
                prod: undefined,
                defaultMock: true,
                platform: process.platform,
                userDataPath: 'unknown',
                launchedAt: undefined,
            };
        }
    },

    'refresh-api': async () => {
        try {
            logger.withCategory('settings').info('🔄 Refreshing API due to settings change');
            apiFactory.refreshApi();
            return { success: true as const };
        } catch (error) {
            logger.withCategory('api').error('Error handling refresh-api request:', error);
            return errorResult(error, 'Failed to refresh API');
        }
    },

    'cleanup-stale-metadata': async (event: unknown, activeChallengeIds: Array<string | number>) => {
        if (!Array.isArray(activeChallengeIds) || !activeChallengeIds.every(isIdArg)) {
            return refuseInvalidArgs('api', 'cleanup-stale-metadata');
        }
        try {
            if (settings.getSetting('mock') === true) return { success: true as const };
            return metadata.cleanupStaleMetadata(activeChallengeIds.map(String))
                ? { success: true as const }
                : { success: false as const, error: 'The metadata could not be saved' };
        } catch (error) {
            logger.withCategory('api').error('Error cleaning up stale metadata:', error);
            return errorResult(error, 'Failed to clean up stale metadata');
        }
    },
});

const buildLocalDataHandlers = ({ afterWipe }: SettingsHandlerOptions) => ({
    // Why the stored settings are not in use (a corrupt file moved aside, or one that cannot be read), or null.
    'get-settings-recovery': async () => ({ success: true as const, recovery: settings.getSettingsRecovery() }),

    'get-third-party-notices': async () => {
        try {
            return { success: true as const, text: await loadThirdPartyNotices() };
        } catch (error) {
            logger.withCategory('ui').error('Error reading the third-party notices:', error);
            return errorResult(error, 'The third-party notices could not be read');
        }
    },

    // Deletes everything the app stores on this device, then hands over to the shell (relaunch to the login screen).
    'wipe-local-data': async () => {
        try {
            const result = await wipeLocalData();
            if (!result.success) return result;
            afterWipe?.();
            return { success: true as const };
        } catch (error) {
            return errorResult(error, 'Failed to delete the local data');
        }
    },
});

const serializeSchemaEntries = () => {
    const schema: Record<string, SettingsSchemaEntry> = settings.SETTINGS_SCHEMA;
    const serializableSchema: Record<string, SerializableSchemaEntry> = {};
    const defaults: Record<string, unknown> = {};
    Object.keys(schema).forEach((key) => {
        serializableSchema[key] = {
            type: schema[key].type,
            default: schema[key].default,
            perChallenge: schema[key].perChallenge,
            challengeOnly: schema[key].challengeOnly === true,
            group: schema[key].group,
            label: schema[key].label,
            description: schema[key].description,
            helpKey: schema[key].helpKey,
            min: schema[key].min,
            max: schema[key].max,
            unit: schema[key].unit,
        };
        defaults[key] = settings.getGlobalDefault(key);
    });
    return { schema: serializableSchema, defaults };
};

const buildSchemaHandlers = () => ({
    'get-settings-schema': async () => {
        try {
            const { schema, defaults } = serializeSchemaEntries();
            return {
                schema,
                defaults,
                groups: settings.SETTINGS_GROUPS,
                tiers: settings.SETTINGS_TIERS,
                // Profile caps travel with the schema so the renderer's
                // client-side pre-validation never hardcodes the literals
                // the facade enforces.
                profileLimits: {
                    maxChallengeProfiles: settings.MAX_CHALLENGE_PROFILES,
                    maxProfileNameLength: settings.MAX_PROFILE_NAME_LENGTH,
                },
            };
        } catch (error) {
            logger.withCategory('settings').error('Error getting settings schema:', error);
            return { schema: {}, defaults: {} };
        }
    },
});

const buildThinHandlers = ({ broadcastSettingsChange }: SettingsHandlerOptions) => {
    const handlers: Record<string, IpcHandler> = {};
    thinRows().forEach(([channel, lookup, fallback, verb]) => {
        const idArg = Object.hasOwn(CHALLENGE_ID_ARGS, channel) ? CHALLENGE_ID_ARGS[channel] : null;
        handlers[channel] = async (event, ...args: unknown[]) => {
            if (idArg) {
                const id = args[idArg.index];
                if (!(idArg.optional && (id === undefined || id === null)) && !isIdArg(id)) {
                    refuseInvalidArgs('settings', channel);
                    // aislop-ignore-next-line ai-slop/hidden-fallback -- refused and logged by refuseInvalidArgs; the row's fallback is the channel contract
                    return fallback;
                }
            }
            try {
                const result = (lookup() as (...a: unknown[]) => unknown)(...args);
                if (result && CHOSEN_LIST_CHANNELS.has(channel)) stampChosenPhotosOwner(args);
                if (result && CHANGE_BROADCAST_CHANNELS.has(channel) && typeof broadcastSettingsChange === 'function') {
                    broadcastSettingsChange(toRendererSettings(settings.loadSettings()));
                }
                return result;
            } catch (error) {
                logger.withCategory('settings').error(`Error ${verb}:`, error);
                // aislop-ignore-next-line ai-slop/hidden-fallback -- logged via the settings logger; the row's fallback is the channel contract
                return fallback;
            }
        };
    });
    return handlers as ThinHandlers;
};

const buildHandlers = (options: SettingsHandlerOptions = {}) => {
    const handlers = {
        ...buildSettingsHandlers(options),
        ...buildEnvironmentHandlers(),
        ...buildLocalDataHandlers(options),
        ...buildSchemaHandlers(),
    } satisfies IpcHandlerMap;
    return { ...handlers, ...buildThinHandlers(options) };
};

const register = (ipcMain: IpcMain) => {
    const broadcastSettingsChange: BroadcastSettingsChange = (newSettings) => {
        // A window closing mid-save must not turn a landed write into a
        // reported failure (a send to a destroyed window throws). register()
        // only runs under Electron, where BrowserWindow resolved.
        (BrowserWindow as typeof electronModule.BrowserWindow).getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) win.webContents.send('settings-changed', newSettings);
        });
    };
    // The window is closed by the exit, so the reply to the wipe is let out first.
    const afterWipe = () => {
        setTimeout(() => {
            const app = electronApp as typeof electronModule.app;
            app.relaunch();
            app.exit(0);
        }, 200);
    };
    registerHandlers(ipcMain, buildHandlers({ broadcastSettingsChange, afterWipe }));
};

export { register, buildHandlers };
