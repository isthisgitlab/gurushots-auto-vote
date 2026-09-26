/**
 * Reset helpers (single top-level key, one or all global defaults, the whole
 * blob minus essential user data) and the "modified from default" checks.
 */

import * as logger from '../logger';
import { SETTINGS_SCHEMA, schemaEntry } from './schema';
import { loadSettings, saveSettings, setSetting, cleanupObsoleteSettings } from './persistence';
import { getDefaultSettings, valuesEqual } from './defaults';
import { getGlobalDefault, setGlobalDefault } from './challengeOverrides';

/** @import { AppSettings, ChallengeValues } from '../types/settings' */

/**
 * Reset a single setting to its default value
 *
 * @param {string} key
 * @returns {boolean}
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
 *
 * @param {string} settingKey
 * @returns {boolean}
 */
const resetGlobalDefault = (settingKey) => {
    const entry = schemaEntry(settingKey);
    if (!entry) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return false;
    }

    const defaultValue = entry.default;
    return setGlobalDefault(settingKey, defaultValue);
};

/**
 * Reset all global defaults for schema-based settings
 *
 * @returns {boolean}
 */
const resetAllGlobalDefaults = () => {
    const settings = loadSettings();
    const challengeSettings = settings.challengeSettings;

    // Reset all global defaults to schema defaults
    /** @type {ChallengeValues} */
    const globalDefaults = {};
    Object.keys(SETTINGS_SCHEMA).forEach((key) => {
        globalDefaults[key] = schemaEntry(key)?.default;
    });

    challengeSettings.globalDefaults = globalDefaults;
    return saveSettings(settings);
};

/**
 * Reset all settings to their default values (preserves only essential user data)
 *
 * @returns {boolean}
 */
const resetAllSettings = () => {
    const currentSettings = loadSettings();

    // Start with defaults, preserving only essential user data. loadSettings
    // merges over the defaults, so these keys are always present.
    /** @type {AppSettings} */
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
 *
 * @param {string} key
 * @returns {boolean}
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
 *
 * @param {string} settingKey
 * @returns {boolean}
 */
const isGlobalDefaultModified = (settingKey) => {
    const entry = schemaEntry(settingKey);
    if (!entry) {
        return false;
    }
    return !valuesEqual(getGlobalDefault(settingKey), entry.default);
};

export {
    resetSetting,
    resetGlobalDefault,
    resetAllGlobalDefaults,
    resetAllSettings,
    isSettingModified,
    isGlobalDefaultModified,
};
