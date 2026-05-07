/**
 * IPC handlers for everything settings-shaped: load/save, schema,
 * boost thresholds, per-challenge overrides, and the bulk-registered
 * "thin" passthrough handlers that just delegate to a settings.*
 * method with a uniform try/catch shape.
 *
 * Also hosts get-environment-info, refresh-api, and cleanup-stale-
 * metadata since those are the small remaining settings-adjacent
 * orchestration channels.
 */

const {BrowserWindow} = require('electron');
const settings = require('../settings');
const logger = require('../logger');
const apiFactory = require('../apiFactory');

// Channels that just delegate to settings.<method>(...args). Each
// entry: [channel, method-name, fallback-on-error, verb-for-log].
const THIN_HANDLERS = [
    ['get-validation-error', 'getValidationError', 'Validation error', 'getting validation error'],
    ['get-global-default', 'getGlobalDefault', null, 'getting global default'],
    ['set-global-default', 'setGlobalDefault', false, 'setting global default'],
    ['get-challenge-override', 'getChallengeOverride', false, 'getting challenge override'],
    ['set-challenge-override', 'setChallengeOverride', false, 'setting challenge override'],
    ['set-challenge-overrides', 'setChallengeOverrides', false, 'setting challenge overrides'],
    ['remove-challenge-override', 'removeChallengeOverride', false, 'removing challenge override'],
    ['get-effective-setting', 'getEffectiveSetting', null, 'getting effective setting'],
    ['cleanup-stale-challenge-setting', 'cleanupStaleChallengeSetting', false, 'cleaning up stale challenge settings'],
    ['cleanup-obsolete-settings', 'cleanupObsoleteSettings', false, 'cleaning up obsolete settings'],
    ['reset-setting', 'resetSetting', false, 'resetting setting'],
    ['reset-global-default', 'resetGlobalDefault', false, 'resetting global default'],
    ['reset-all-global-defaults', 'resetAllGlobalDefaults', false, 'resetting all global defaults'],
    ['reset-all-settings', 'resetAllSettings', false, 'resetting all settings'],
    ['is-setting-modified', 'isSettingModified', false, 'checking if setting is modified'],
    ['is-global-default-modified', 'isGlobalDefaultModified', false, 'checking if global default is modified'],
];

const register = (ipcMain) => {
    ipcMain.handle('get-settings', async () => {
        try {
            return settings.loadSettings();
        } catch (error) {
            logger.withCategory('settings').error('Error handling get-settings request:', error);
            return settings.getDefaultSettings();
        }
    });

    ipcMain.handle('get-setting', async (event, key) => {
        try {
            if (typeof key !== 'string') {
                throw new Error('Invalid key type, expected string');
            }
            return settings.getSetting(key);
        } catch (error) {
            logger.withCategory('settings').error(`Error handling get-setting request for key "${key}":`, error);
            const defaultSettings = settings.getDefaultSettings();
            return defaultSettings[key] !== undefined ? defaultSettings[key] : null;
        }
    });

    ipcMain.handle('set-setting', async (event, key, value) => {
        try {
            if (typeof key !== 'string') {
                throw new Error('Invalid key type, expected string');
            }
            return settings.setSetting(key, value);
        } catch (error) {
            logger.withCategory('settings').error(`Error handling set-setting request for key "${key}":`, error);
            return false;
        }
    });

    ipcMain.handle('save-settings', async (event, newSettings) => {
        try {
            if (typeof newSettings !== 'object' || newSettings === null) {
                throw new Error('Invalid settings type, expected object');
            }
            const result = settings.saveSettings(newSettings);

            // Broadcast settings change so every renderer can react.
            if (result) {
                BrowserWindow.getAllWindows().forEach(win => {
                    win.webContents.send('settings-changed', newSettings);
                });
            }

            return result;
        } catch (error) {
            logger.withCategory('settings').error('Error handling save-settings request:', error);
            return false;
        }
    });

    ipcMain.handle('get-environment-info', async () => {
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
            };
        }
    });

    ipcMain.handle('refresh-api', async () => {
        try {
            logger.withCategory('settings').info('🔄 Refreshing API due to settings change');
            apiFactory.refreshApi();
            return {success: true};
        } catch (error) {
            logger.withCategory('api').error('Error handling refresh-api request:', error);
            return {success: false, error: error.message};
        }
    });

    ipcMain.handle('get-boost-threshold', async (event, challengeId) => {
        try {
            return settings.getEffectiveSetting('boostTime', challengeId);
        } catch (error) {
            logger.withCategory('settings').error('Error getting boost threshold:', error);
            return settings.SETTINGS_SCHEMA.boostTime.default;
        }
    });

    ipcMain.handle('set-boost-threshold', async (event, challengeId, threshold) => {
        try {
            settings.setChallengeOverride('boostTime', challengeId.toString(), threshold);
            return {success: true};
        } catch (error) {
            logger.withCategory('settings').error('Error setting boost threshold:', error);
            return {success: false, error: error.message};
        }
    });

    ipcMain.handle('set-default-boost-threshold', async (event, threshold) => {
        try {
            settings.setGlobalDefault('boostTime', threshold);
            return {success: true};
        } catch (error) {
            logger.withCategory('settings').error('Error setting default boost threshold:', error);
            return {success: false, error: error.message};
        }
    });

    ipcMain.handle('get-settings-schema', async () => {
        try {
            const schema = settings.SETTINGS_SCHEMA;
            const serializableSchema = {};
            const defaults = {};
            Object.keys(schema).forEach((key) => {
                serializableSchema[key] = {
                    type: schema[key].type,
                    default: schema[key].default,
                    perChallenge: schema[key].perChallenge,
                    label: schema[key].label,
                    description: schema[key].description,
                    min: schema[key].min,
                    max: schema[key].max,
                    unit: schema[key].unit,
                };
                defaults[key] = settings.getGlobalDefault(key);
            });
            return {schema: serializableSchema, defaults};
        } catch (error) {
            logger.withCategory('settings').error('Error getting settings schema:', error);
            return {schema: {}, defaults: {}};
        }
    });

    THIN_HANDLERS.forEach(([channel, method, fallback, verb]) => {
        ipcMain.handle(channel, async (event, ...args) => {
            try {
                return settings[method](...args);
            } catch (error) {
                logger.withCategory('settings').error(`Error ${verb}:`, error);
                return fallback;
            }
        });
    });

    ipcMain.handle('cleanup-stale-metadata', async (event, activeChallengeIds) => {
        try {
            const metadata = require('../metadata');
            return metadata.cleanupStaleMetadata(activeChallengeIds);
        } catch (error) {
            logger.withCategory('api').error('Error cleaning up stale metadata:', error);
            return false;
        }
    });
};

module.exports = {register};
