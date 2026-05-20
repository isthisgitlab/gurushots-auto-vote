/**
 * Settings facade. The schema lives in ./settings/schema and the
 * persistence transport / runtime detection in ./settings/storage; this
 * file owns the load/save mechanics, migrations, schema-based accessors,
 * cleanup, and reset helpers. It also re-exports the schema + storage
 * surface so existing call sites keep importing from `./settings` without
 * needing to know the internal split.
 */

const logger = require('./logger');
const { SETTINGS_SCHEMA, validateSetting, getValidationError, getSettingsSchema } = require('./settings/schema');
const {
    storage,
    initializeAsync,
    isAutovoteRunning,
    getDefaultMockSetting,
    getUserDataPath,
    getEnvironmentInfo,
} = require('./settings/storage');

// Default settings with environment-aware mock setting
const getDefaultSettings = () => {
    // Generate global defaults from schema
    const globalDefaults = {};
    Object.keys(SETTINGS_SCHEMA).forEach((key) => {
        globalDefaults[key] = SETTINGS_SCHEMA[key].default;
    });

    return {
        theme: 'light',
        stayLoggedIn: false,
        lastUsername: '',
        mock: getDefaultMockSetting(),
        token: '',
        timezone: 'Europe/Riga',
        customTimezones: [],
        language: 'en', // Default language
        // Timing settings (stored in user-friendly units)
        apiTimeout: 30, // API request timeout in seconds (default: 30 seconds)
        checkFrequencyMin: 3, // Lower bound (minutes). Equal to max → fixed-cadence behavior.
        checkFrequencyMax: 3, // Upper bound (minutes). Each cycle picks a random delay in [min, max].
        // Window position and size settings
        windowBounds: {
            login: { x: undefined, y: undefined, width: 800, height: 960 },
            main: { x: undefined, y: undefined, width: 800, height: 960 },
        },
        // Schema-based challenge settings
        challengeSettings: {
            globalDefaults: globalDefaults,
            perChallenge: {}, // Challenge ID -> setting overrides mapping
        },
        // API headers for randomization (random per user installation)
        apiHeaders: {},
    };
};

// Module-local guards so cleanupObsoleteSettings (which itself calls
// loadSettings) doesn't recurse and doesn't re-run on every read.
let migrationInProgress = false;
let cleanupCompleted = false;

// Load settings from the userData directory
const loadSettings = () => {
    try {
        // Read raw settings via the storage adapter so the Capacitor cache
        // path is exercised on Android. Electron/CLI hit fs synchronously.
        const settingsData = storage.readRaw();

        // Check if the settings exist
        if (settingsData) {
            const settings = JSON.parse(settingsData);

            // Merge with default settings to ensure all properties exist
            const mergedSettings = { ...getDefaultSettings(), ...settings };

            // Mock setting can be user-controlled, but default to environment if not set
            if (mergedSettings.mock === undefined) {
                mergedSettings.mock = getDefaultMockSetting();
            }

            let migrationChanges = false;

            // Migrate buggy-GUI-encoded time values. Pre-fix (versions
            // v0.7.0 through v0.8.2), SettingInput stored boostTime /
            // turboTime as minutes (h*60+m) while the runtime treated
            // them as seconds. The buggy GUI could only write values in
            // [0, 1439] (max was 23h*60+59); schema defaults (3600, 7200)
            // are above that band, so untouched defaults pass through
            // unchanged.
            if (!mergedSettings._timeUnitMigratedV1) {
                const TIME_KEYS = ['boostTime', 'turboTime'];
                const looksMinuteEncoded = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1440;

                const globalDefaults = mergedSettings.challengeSettings?.globalDefaults || {};
                for (const key of TIME_KEYS) {
                    if (looksMinuteEncoded(globalDefaults[key])) {
                        const before = globalDefaults[key];
                        globalDefaults[key] = before * 60;
                        migrationChanges = true;
                        logger
                            .withCategory('settings')
                            .info(
                                `Migrated ${key} global default from minute-encoded ${before} to ${globalDefaults[key]}s`,
                                null,
                            );
                    }
                }

                const perChallenge = mergedSettings.challengeSettings?.perChallenge || {};
                for (const [challengeId, overrides] of Object.entries(perChallenge)) {
                    for (const key of TIME_KEYS) {
                        if (looksMinuteEncoded(overrides[key])) {
                            const before = overrides[key];
                            overrides[key] = before * 60;
                            migrationChanges = true;
                            logger
                                .withCategory('settings')
                                .info(
                                    `Migrated ${key} override on challenge ${challengeId} from ${before} to ${overrides[key]}s`,
                                    null,
                                );
                        }
                    }
                }

                mergedSettings._timeUnitMigratedV1 = true;
                migrationChanges = true;
            }

            // If migration made changes, save the updated settings
            if (migrationChanges) {
                storage.writeRaw(JSON.stringify(mergedSettings, null, 2));
            }

            // Run obsolete-settings cleanup once per process. The
            // re-entry guard exists because cleanupObsoleteSettings
            // calls back into loadSettings.
            if (!migrationInProgress) {
                migrationInProgress = true;
                try {
                    if (!cleanupCompleted && !isAutovoteRunning()) {
                        cleanupObsoleteSettings();
                        cleanupCompleted = true;
                    } else if (isAutovoteRunning()) {
                        logger
                            .withCategory('settings')
                            .debug('⏸️ Skipping obsolete settings cleanup - autovote is running');
                    }
                } catch (migrationError) {
                    logger.withCategory('settings').warning('Cleanup failed:', migrationError);
                } finally {
                    migrationInProgress = false;
                }
            }

            return mergedSettings;
        }

        // If the file doesn't exist, return default settings
        const defaultSettings = getDefaultSettings();
        logger
            .withCategory('settings')
            .info(
                `No settings file found, loaded default settings with keys: ${Object.keys(defaultSettings).join(', ')}`,
            );
        return defaultSettings;
    } catch (error) {
        logger.withCategory('settings').error('Error loading settings:', error);
        // Return default settings if there's an error
        const defaultSettings = getDefaultSettings();
        logger
            .withCategory('settings')
            .info(`Loaded default settings with keys: ${Object.keys(defaultSettings).join(', ')}`);
        return defaultSettings;
    }
};

// Save settings to the userData directory
const saveSettings = (settings) => {
    try {
        // Merge with existing settings
        const currentSettings = loadSettings();
        const mergedSettings = { ...currentSettings, ...settings };

        // Write via storage adapter (sync fs on Electron/CLI; cache + async write-behind on Capacitor)
        storage.writeRaw(JSON.stringify(mergedSettings, null, 2));

        return true;
    } catch (error) {
        logger.withCategory('settings').error('Error saving settings:', error);
        return false;
    }
};

// Get a specific setting
const getSetting = (key) => {
    const settings = loadSettings();
    if (!settings) {
        logger.withCategory('settings').warning(`Settings not loaded, returning default for key: ${key}`);
        const defaultSettings = getDefaultSettings();
        return defaultSettings[key];
    }
    return settings[key];
};

// Set a specific setting
const setSetting = (key, value) => {
    const settings = loadSettings();
    settings[key] = value;
    return saveSettings(settings);
};

/**
 * Check if a setting requires app reload when changed
 */
const isReloadRequired = (key) => {
    // Only these settings require a reload
    const reloadSettings = ['theme', 'language', 'timezone'];

    // Check if it's a challenge-specific setting
    const isChallengeSetting = SETTINGS_SCHEMA[key] && SETTINGS_SCHEMA[key].perChallenge;

    return reloadSettings.includes(key) || isChallengeSetting;
};

// Save window bounds for a specific window type
const saveWindowBounds = (windowType, bounds) => {
    const settings = loadSettings();
    if (!settings.windowBounds) {
        settings.windowBounds = {};
    }
    settings.windowBounds[windowType] = bounds;
    return saveSettings(settings);
};

// Get window bounds for a specific window type
const getWindowBounds = (windowType) => {
    const settings = loadSettings();
    if (!settings.windowBounds || !settings.windowBounds[windowType]) {
        return getDefaultSettings().windowBounds[windowType];
    }
    return settings.windowBounds[windowType];
};

/**
 * Schema-based Settings Helper Functions
 */

/**
 * Get global default value for a setting
 */
const getGlobalDefault = (settingKey) => {
    const settings = loadSettings();
    const challengeSettings = settings.challengeSettings || getDefaultSettings().challengeSettings;

    if (
        challengeSettings.globalDefaults &&
        Object.prototype.hasOwnProperty.call(challengeSettings.globalDefaults, settingKey)
    ) {
        return challengeSettings.globalDefaults[settingKey];
    }

    // Fallback to schema default if not found in settings
    return SETTINGS_SCHEMA[settingKey]?.default;
};

/**
 * Set global default value for a setting
 */
const setGlobalDefault = (settingKey, value) => {
    if (!SETTINGS_SCHEMA[settingKey]) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return false;
    }

    // Get current global defaults for context validation
    const settings = loadSettings();
    const currentGlobalDefaults = settings.challengeSettings?.globalDefaults || {};
    const contextSettings = { ...currentGlobalDefaults, [settingKey]: value };

    // Get detailed validation error information
    const validationError = getValidationError(settingKey, value, contextSettings);
    if (validationError) {
        logger.withCategory('settings').error(`Invalid value for setting ${settingKey}:`, value);
        logger.withCategory('settings').error(validationError, null);
        return false;
    }

    if (!settings.challengeSettings) {
        settings.challengeSettings = getDefaultSettings().challengeSettings;
    }
    if (!settings.challengeSettings.globalDefaults) {
        settings.challengeSettings.globalDefaults = {};
    }

    settings.challengeSettings.globalDefaults[settingKey] = value;
    return saveSettings(settings);
};

/**
 * Get per-challenge override value for a setting
 */
const getChallengeOverride = (settingKey, challengeId) => {
    const settings = loadSettings();
    const challengeSettings = settings.challengeSettings || getDefaultSettings().challengeSettings;

    if (
        challengeSettings.perChallenge &&
        challengeSettings.perChallenge[challengeId] &&
        Object.prototype.hasOwnProperty.call(challengeSettings.perChallenge[challengeId], settingKey)
    ) {
        return challengeSettings.perChallenge[challengeId][settingKey];
    }

    return null;
};

/**
 * Ensures the challengeSettings.perChallenge[challengeId] container
 * exists on the given settings object and returns it.
 */
const _ensureChallengeContainer = (settings, challengeId) => {
    if (!settings.challengeSettings) {
        settings.challengeSettings = getDefaultSettings().challengeSettings;
    }
    if (!settings.challengeSettings.perChallenge) {
        settings.challengeSettings.perChallenge = {};
    }
    if (!settings.challengeSettings.perChallenge[challengeId]) {
        settings.challengeSettings.perChallenge[challengeId] = {};
    }
    return settings.challengeSettings.perChallenge[challengeId];
};

/**
 * Validates a per-challenge override and writes it onto the in-memory
 * settings object. Returns one of: 'invalid' (rejected),
 * 'set' (override stored), 'cleared' (override removed because it
 * matched the global default).
 */
const _applyChallengeOverride = (settings, settingKey, challengeId, value, batchOverrides = null) => {
    if (!SETTINGS_SCHEMA[settingKey]) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return 'invalid';
    }
    if (!SETTINGS_SCHEMA[settingKey].perChallenge) {
        logger.withCategory('settings').error(`Setting ${settingKey} does not support per-challenge overrides`, null);
        return 'invalid';
    }

    const globalDefaults = settings.challengeSettings?.globalDefaults || {};
    const existingOverrides = settings.challengeSettings?.perChallenge?.[challengeId] || {};
    const contextSettings = batchOverrides
        ? { ...globalDefaults, ...existingOverrides, ...batchOverrides }
        : { ...globalDefaults, ...existingOverrides, [settingKey]: value };

    if (!validateSetting(settingKey, value, contextSettings, challengeId)) {
        logger.withCategory('settings').error(`Invalid value for setting ${settingKey}:`, value);
        return 'invalid';
    }

    const container = _ensureChallengeContainer(settings, challengeId);
    // TODO: this is reference-equality so any reference type (e.g. array
    // defaults like mustIncludeTags) never matches and never auto-clears.
    // Out of scope for the tag-rules feature; touches all setting types.
    if (value !== getGlobalDefault(settingKey)) {
        container[settingKey] = value;
        return 'set';
    }
    delete container[settingKey];
    return 'cleared';
};

/**
 * Set per-challenge override value for a setting.
 */
const setChallengeOverride = (settingKey, challengeId, value) => {
    const settings = loadSettings();
    const result = _applyChallengeOverride(settings, settingKey, challengeId, value);
    if (result === 'invalid') return false;

    // If the cleared override left the challenge container empty, drop it.
    const container = settings.challengeSettings?.perChallenge?.[challengeId];
    if (container && Object.keys(container).length === 0) {
        delete settings.challengeSettings.perChallenge[challengeId];
    }
    return saveSettings(settings);
};

/**
 * Set multiple per-challenge overrides efficiently, only saving values
 * that differ from global defaults.
 */
const setChallengeOverrides = (challengeId, overrides) => {
    const settings = loadSettings();
    _ensureChallengeContainer(settings, challengeId);

    const savedOverrides = [];
    const removedOverrides = [];
    let hasChanges = false;

    for (const [settingKey, value] of Object.entries(overrides)) {
        const result = _applyChallengeOverride(settings, settingKey, challengeId, value, overrides);
        if (result === 'set') {
            savedOverrides.push(`${settingKey}=${value}`);
            hasChanges = true;
        } else if (result === 'cleared') {
            removedOverrides.push(settingKey);
            hasChanges = true;
        }
    }

    if (Object.keys(settings.challengeSettings.perChallenge[challengeId]).length === 0) {
        delete settings.challengeSettings.perChallenge[challengeId];
        logger.withCategory('settings').debug(`🗑️ Removed empty challenge settings for challenge ${challengeId}`);
        hasChanges = true;
    }

    if (savedOverrides.length > 0) {
        logger
            .withCategory('general')
            .debug(`💾 Saved overrides for challenge ${challengeId}:`, savedOverrides.join(', '));
    }
    if (removedOverrides.length > 0) {
        logger
            .withCategory('general')
            .debug(`🗑️ Removed overrides for challenge ${challengeId}:`, removedOverrides.join(', '));
    }

    return hasChanges ? saveSettings(settings) : true;
};

/**
 * Remove per-challenge override for a setting
 */
const removeChallengeOverride = (settingKey, challengeId) => {
    const settings = loadSettings();
    if (
        !settings.challengeSettings ||
        !settings.challengeSettings.perChallenge ||
        !settings.challengeSettings.perChallenge[challengeId]
    ) {
        return true; // Nothing to remove
    }

    delete settings.challengeSettings.perChallenge[challengeId][settingKey];

    // If challenge has no more overrides, remove the challenge entry
    if (Object.keys(settings.challengeSettings.perChallenge[challengeId]).length === 0) {
        delete settings.challengeSettings.perChallenge[challengeId];
    }

    return saveSettings(settings);
};

/**
 * Returns a per-challenge exposure-threshold resolver. Falls back to the
 * schema default if a corrupt override would otherwise stall the cycle.
 * Single source so the IPC handlers and middleware agree.
 */
const getExposureResolver = () => (challengeId) => {
    try {
        return getEffectiveSetting('exposure', challengeId);
    } catch (error) {
        logger.withCategory('settings').warning(`Error getting exposure setting for challenge ${challengeId}:`, error);
        return SETTINGS_SCHEMA.exposure.default;
    }
};

/**
 * Get the effective value for a setting (per-challenge override or global default)
 */
const getEffectiveSetting = (settingKey, challengeId = null) => {
    if (!SETTINGS_SCHEMA[settingKey]) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return SETTINGS_SCHEMA[settingKey]?.default;
    }

    // If challengeId is provided and the setting supports per-challenge overrides, check for override
    if (challengeId && SETTINGS_SCHEMA[settingKey].perChallenge) {
        const override = getChallengeOverride(settingKey, challengeId);
        if (override !== null) {
            return override;
        }
    }

    // Return global default
    return getGlobalDefault(settingKey);
};

/**
 * Cleanup stale challenge settings for challenges that no longer exist
 */
const cleanupStaleChallengeSetting = (activeChallengeIds) => {
    const settings = loadSettings();
    if (!settings.challengeSettings || !settings.challengeSettings.perChallenge) {
        return true; // Nothing to cleanup
    }

    const storedChallengeIds = Object.keys(settings.challengeSettings.perChallenge);
    const staleChallengeIds = storedChallengeIds.filter((id) => !activeChallengeIds.includes(id));

    if (staleChallengeIds.length === 0) {
        return true; // Nothing to cleanup
    }

    logger
        .withCategory('settings')
        .debug(`Cleaning up settings for ${staleChallengeIds.length} stale challenges:`, staleChallengeIds);

    staleChallengeIds.forEach((challengeId) => {
        delete settings.challengeSettings.perChallenge[challengeId];
    });

    return saveSettings(settings);
};

/**
 * Clean up obsolete settings that are no longer used
 */
const cleanupObsoleteSettings = () => {
    try {
        const settings = loadSettings();
        let hasChanges = false;

        if (settings.boostConfig) {
            logger.withCategory('settings').debug('Removing legacy boostConfig', null);
            delete settings.boostConfig;
            hasChanges = true;
        }

        // Clean up challengeSettings structure
        if (settings.challengeSettings) {
            // Ensure globalDefaults only contains valid schema keys
            if (settings.challengeSettings.globalDefaults) {
                const validSchemaKeys = Object.keys(SETTINGS_SCHEMA);
                const globalDefaultKeys = Object.keys(settings.challengeSettings.globalDefaults);
                const invalidGlobalKeys = globalDefaultKeys.filter((key) => !validSchemaKeys.includes(key));

                if (invalidGlobalKeys.length > 0) {
                    logger
                        .withCategory('settings')
                        .debug(`Removing invalid global default keys: ${invalidGlobalKeys.join(', ')}`);
                    invalidGlobalKeys.forEach((key) => {
                        delete settings.challengeSettings.globalDefaults[key];
                        hasChanges = true;
                    });
                }
            }

            // Clean up perChallenge overrides
            if (settings.challengeSettings.perChallenge) {
                const validSchemaKeys = Object.keys(SETTINGS_SCHEMA);
                const challengeIds = Object.keys(settings.challengeSettings.perChallenge);

                for (const challengeId of challengeIds) {
                    const challengeOverrides = settings.challengeSettings.perChallenge[challengeId];
                    const invalidKeys = Object.keys(challengeOverrides).filter((key) => !validSchemaKeys.includes(key));

                    if (invalidKeys.length > 0) {
                        logger
                            .withCategory('settings')
                            .debug(`Removing invalid override keys for challenge ${challengeId}:`, invalidKeys);
                        invalidKeys.forEach((key) => {
                            delete challengeOverrides[key];
                            hasChanges = true;
                        });
                    }

                    if (Object.keys(challengeOverrides).length === 0) {
                        delete settings.challengeSettings.perChallenge[challengeId];
                        hasChanges = true;
                    }
                }
            }
        }

        // Save cleaned settings if any changes were made
        if (hasChanges) {
            logger.withCategory('settings').debug('Settings cleanup completed - saving cleaned settings');
            saveSettings(settings);
        }
    } catch (error) {
        logger.withCategory('settings').error('Error during settings cleanup:', error);
    }
};

/**
 * Reset Functionality
 */

/**
 * Reset a single setting to its default value
 */
const resetSetting = (key) => {
    try {
        const defaultSettings = getDefaultSettings();

        if (!Object.prototype.hasOwnProperty.call(defaultSettings, key)) {
            logger.withCategory('settings').error(`Invalid setting key: ${key}`, null);
            return false;
        }

        const defaultValue = defaultSettings[key];
        return setSetting(key, defaultValue);
    } catch (error) {
        logger.withCategory('settings').error(`Error resetting setting ${key}:`, error);
        return false;
    }
};

/**
 * Reset global default for a schema-based setting
 */
const resetGlobalDefault = (settingKey) => {
    if (!SETTINGS_SCHEMA[settingKey]) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return false;
    }

    const defaultValue = SETTINGS_SCHEMA[settingKey].default;
    return setGlobalDefault(settingKey, defaultValue);
};

/**
 * Reset all global defaults for schema-based settings
 */
const resetAllGlobalDefaults = () => {
    try {
        const settings = loadSettings();
        if (!settings.challengeSettings) {
            settings.challengeSettings = getDefaultSettings().challengeSettings;
        }

        // Reset all global defaults to schema defaults
        const globalDefaults = {};
        Object.keys(SETTINGS_SCHEMA).forEach((key) => {
            globalDefaults[key] = SETTINGS_SCHEMA[key].default;
        });

        settings.challengeSettings.globalDefaults = globalDefaults;
        return saveSettings(settings);
    } catch (error) {
        logger.withCategory('settings').error('Error resetting all global defaults:', error);
        return false;
    }
};

/**
 * Reset all settings to their default values (preserves only essential user data)
 */
const resetAllSettings = () => {
    try {
        const currentSettings = loadSettings();
        const defaultSettings = getDefaultSettings();

        // Settings to preserve (only essential user data that shouldn't be reset)
        const preserveKeys = ['token', 'mock', 'apiHeaders'];

        // Start with defaults
        const newSettings = { ...defaultSettings };

        // Preserve specified user data
        preserveKeys.forEach((key) => {
            if (currentSettings[key] !== undefined) {
                newSettings[key] = currentSettings[key];
            }
        });

        // Save the reset settings
        const saveResult = saveSettings(newSettings);

        // Run cleanup to remove any obsolete settings
        if (saveResult) {
            cleanupObsoleteSettings();
        }

        return saveResult;
    } catch (error) {
        logger.withCategory('settings').error('Error resetting all settings:', error);
        return false;
    }
};

/**
 * Check if a setting has been modified from its default value
 */
const isSettingModified = (key) => {
    try {
        const currentSettings = loadSettings();
        const defaultSettings = getDefaultSettings();

        if (!Object.prototype.hasOwnProperty.call(defaultSettings, key)) {
            return false;
        }

        const currentValue = currentSettings[key];
        const defaultValue = defaultSettings[key];

        return JSON.stringify(currentValue) !== JSON.stringify(defaultValue);
    } catch (error) {
        logger.withCategory('settings').error(`Error checking if setting ${key} is modified:`, error);
        return false;
    }
};

/**
 * Check if a global default has been modified from its schema default
 */
const isGlobalDefaultModified = (settingKey) => {
    try {
        if (!SETTINGS_SCHEMA[settingKey]) {
            return false;
        }

        const currentValue = getGlobalDefault(settingKey);
        const schemaDefault = SETTINGS_SCHEMA[settingKey].default;

        return JSON.stringify(currentValue) !== JSON.stringify(schemaDefault);
    } catch (error) {
        logger.withCategory('settings').error(`Error checking if global default ${settingKey} is modified:`, error);
        return false;
    }
};

module.exports = {
    initializeAsync,
    loadSettings,
    saveSettings,
    getSetting,
    setSetting,
    isReloadRequired,
    getDefaultSettings,
    getUserDataPath,
    saveWindowBounds,
    getWindowBounds,

    // Environment detection functions
    getEnvironmentInfo,

    // Challenge-specific settings
    getGlobalDefault,
    setGlobalDefault,
    getChallengeOverride,
    setChallengeOverride,
    setChallengeOverrides,
    removeChallengeOverride,
    getEffectiveSetting,
    getExposureResolver,

    // Cleanup functions
    cleanupStaleChallengeSetting,
    cleanupObsoleteSettings,

    // Reset functions
    resetSetting,
    resetGlobalDefault,
    resetAllGlobalDefaults,
    resetAllSettings,

    // Validation functions
    getValidationError,

    // Utility functions
    getSettingsSchema,
    isSettingModified,
    isGlobalDefaultModified,

    // Schema
    SETTINGS_SCHEMA,
};
