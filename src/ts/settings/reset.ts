/**
 * Reset helpers (single app key, one or all global defaults, the whole
 * configuration minus essential user data) and the "modified from default" checks.
 */

import * as logger from '../logger';
import { schemaEntry } from './schema';
import { loadSettings, saveSettings, setSetting } from './persistence';
import { getDefaultSettings, valuesEqual } from './defaults';
import { getGlobalDefault, setGlobalDefault } from './challengeOverrides';
import { clearTitlePins } from './titlePins';

/**
 * Reset a single setting to its default value
 */
const resetSetting = (key: string): boolean => {
    const { app } = getDefaultSettings();

    if (!Object.prototype.hasOwnProperty.call(app, key)) {
        logger.withCategory('settings').error(`Invalid setting key: ${key}`, null);
        return false;
    }

    return setSetting(key, app[key]);
};

/**
 * Reset global default for a schema-based setting
 */
const resetGlobalDefault = (settingKey: string): boolean => {
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
 */
const resetAllGlobalDefaults = (): boolean => {
    const settings = loadSettings();
    // A global default that is not stored is the schema default.
    settings.defaults = {};
    return saveSettings(settings);
};

/**
 * Reset all settings to their default values (preserves only essential user data: the whole sign-in state, the mock
 * mode, and the record of the settings.json import), and forget the title pins
 */
const resetAllSettings = (): boolean => {
    const currentSettings = loadSettings();

    // Start with defaults, preserving only essential user data. loadSettings
    // fills what a file lacks, so the sign-in state and `mock` are always present.
    const newSettings = getDefaultSettings();
    newSettings.auth = currentSettings.auth;
    newSettings.app.mock = currentSettings.app.mock;
    if (currentSettings.imported) newSettings.imported = currentSettings.imported;

    if (!saveSettings(newSettings)) return false;
    // The pins the cache holds go with the rest, as `titlePins` of settings format 1 did. The configuration is reset
    // whether or not they are: a pin store that cannot be written is said, not reported as a reset that failed.
    if (!clearTitlePins()) {
        logger
            .withCategory('settings')
            .warning('The settings were reset, but the saved title pins could not be cleared');
    }
    return true;
};

/**
 * Check if a setting has been modified from its default value
 */
const isSettingModified = (key: string): boolean => {
    const { app } = getDefaultSettings();
    if (!Object.prototype.hasOwnProperty.call(app, key)) {
        return false;
    }
    return !valuesEqual(loadSettings().app[key], app[key]);
};

/**
 * Check if a global default has been modified from its schema default
 */
const isGlobalDefaultModified = (settingKey: string): boolean => {
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
