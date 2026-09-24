/**
 * Reset helpers (single top-level key, one or all global defaults, the whole
 * blob minus essential user data) and the "modified from default" checks.
 */

const logger = require('../logger');
const { SETTINGS_SCHEMA } = require('./schema');
const { loadSettings, saveSettings, setSetting, cleanupObsoleteSettings } = require('./persistence');
const { getDefaultSettings, ensureChallengeSettings, valuesEqual } = require('./defaults');
const { getGlobalDefault, setGlobalDefault } = require('./challengeOverrides');

/**
 * Reset a single setting to its default value
 */
const resetSetting = (key) => {
    const defaultSettings = getDefaultSettings();

    if (!Object.prototype.hasOwnProperty.call(defaultSettings, key)) {
        logger.withCategory('settings').error(`Invalid setting key: ${key}`, null);
        return false;
    }

    return setSetting(key, defaultSettings[key]);
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
    const settings = loadSettings();
    const challengeSettings = ensureChallengeSettings(settings);

    // Reset all global defaults to schema defaults
    const globalDefaults = {};
    Object.keys(SETTINGS_SCHEMA).forEach((key) => {
        globalDefaults[key] = SETTINGS_SCHEMA[key].default;
    });

    challengeSettings.globalDefaults = globalDefaults;
    return saveSettings(settings);
};

/**
 * Reset all settings to their default values (preserves only essential user data)
 */
const resetAllSettings = () => {
    const currentSettings = loadSettings();

    // Start with defaults, preserving only essential user data. loadSettings
    // merges over the defaults, so these keys are always present.
    const newSettings = { ...getDefaultSettings() };
    for (const key of ['token', 'mock', 'apiHeaders']) {
        newSettings[key] = currentSettings[key];
    }

    // Save the reset settings
    const saveResult = saveSettings(newSettings);

    // Run cleanup to remove any obsolete settings
    if (saveResult) {
        cleanupObsoleteSettings();
    }

    return saveResult;
};

/**
 * Check if a setting has been modified from its default value
 */
const isSettingModified = (key) => {
    const defaultSettings = getDefaultSettings();
    if (!Object.prototype.hasOwnProperty.call(defaultSettings, key)) {
        return false;
    }
    return !valuesEqual(loadSettings()[key], defaultSettings[key]);
};

/**
 * Check if a global default has been modified from its schema default
 */
const isGlobalDefaultModified = (settingKey) => {
    if (!SETTINGS_SCHEMA[settingKey]) {
        return false;
    }
    return !valuesEqual(getGlobalDefault(settingKey), SETTINGS_SCHEMA[settingKey].default);
};

module.exports = {
    resetSetting,
    resetGlobalDefault,
    resetAllGlobalDefaults,
    resetAllSettings,
    isSettingModified,
    isGlobalDefaultModified,
};
