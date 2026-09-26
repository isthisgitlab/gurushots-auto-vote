/**
 * Load/save mechanics of the settings blob over the storage adapter: read +
 * merge over defaults + load-time migrations, the once-per-process obsolete
 * key cleanup, whole-blob save, top-level key accessors, and window bounds.
 * Sole owner of the load-time re-entry/cleanup guards; the persisted bytes
 * themselves (and Capacitor's write-behind cache) are owned by storage.js.
 */

import * as logger from '../logger';
import { schemaEntry } from './schema';
import { storage } from './storage';
import { getDefaultSettings } from './defaults';
import { runMigrations, pruneObsoleteSettings } from './migrations';
import { isPlainObject } from '../plainObject';
import { oneLine } from '../format/logSafe';

/** @import { AppSettings, WindowBounds, WindowType } from '../types/settings' */

// Module-local guards so cleanupObsoleteSettings (which itself calls
// loadSettings) doesn't recurse and doesn't re-run on every read.
let migrationInProgress = false;
let cleanupCompleted = false;

// The last file text found to hold only valid values, so an unchanged file is
// not re-validated on every read; and the last warning, so an invalid file
// warns once rather than on every read.
/** @type {string | null} */
let lastCleanRaw = null;
/** @type {string | null} */
let lastWarning = null;

/**
 * Merge parsed persisted settings over the defaults so all properties
 * exist, and resolve the environment-aware mock default.
 *
 * @param {unknown} settings - the parsed persisted blob
 * @returns {AppSettings}
 */
const mergeWithDefaults = (settings) =>
    // Defaults carry the environment-aware mock value, so a persisted blob
    // without `mock` (JSON never holds `undefined`) inherits it here.
    ({ ...getDefaultSettings(), .../** @type {Partial<AppSettings>} */ (settings) });

/**
 * Whether a stored top-level value has its default's type. The only list
 * default is customTimezones, a list of zone names.
 *
 * @param {unknown} value
 * @param {unknown} fallback
 */
const hasDefaultsType = (value, fallback) =>
    Array.isArray(fallback)
        ? Array.isArray(value) && value.every((item) => typeof item === 'string')
        : typeof value === typeof fallback;

/**
 * Remove the values of `values` (a globalDefaults or per-challenge map) that
 * their key's schema validation rejects. Keys the schema does not know are
 * left to pruneObsoleteSettings.
 *
 * @param {Record<string, unknown>} values
 * @param {string} path
 * @param {string[]} dropped
 */
const dropInvalidSchemaValues = (values, path, dropped) => {
    for (const [key, value] of Object.entries(values)) {
        const entry = schemaEntry(key);
        if (entry && !entry.validation.safeParse(value).success) {
            delete values[key];
            dropped.push(`${path}.${key}`);
        }
    }
};

/**
 * Drop the stored values whose type a read would otherwise misreport: a
 * top-level value of the wrong type goes back to its default, and a schema
 * value its validation rejects is removed, so the schema default applies.
 * The nested maps other modules own (window bounds, title rules, profiles,
 * scenarios, pins) are checked by their readers.
 * Mutates `settings`; returns the paths it dropped.
 *
 * @param {AppSettings} settings
 * @returns {string[]}
 */
const dropInvalidValues = (settings) => {
    /** @type {string[]} */
    const dropped = [];
    for (const [key, fallback] of Object.entries(getDefaultSettings())) {
        if (!isPlainObject(fallback) && !hasDefaultsType(settings[key], fallback)) {
            settings[key] = fallback;
            dropped.push(key);
        }
    }
    const challengeSettings = /** @type {unknown} */ (settings.challengeSettings);
    if (!isPlainObject(challengeSettings)) {
        settings.challengeSettings = getDefaultSettings().challengeSettings;
        dropped.push('challengeSettings');
        return dropped;
    }
    // The containers every challengeSettings block carries, by kind; the modules
    // that own them validate their contents.
    for (const [key, fallback] of Object.entries(getDefaultSettings().challengeSettings)) {
        const value = challengeSettings[key];
        if (Array.isArray(fallback) ? !Array.isArray(value) : !isPlainObject(value)) {
            if (value !== undefined) dropped.push(`challengeSettings.${key}`);
            challengeSettings[key] = fallback;
        }
    }
    const { globalDefaults, perChallenge } = settings.challengeSettings;
    dropInvalidSchemaValues(globalDefaults, 'challengeSettings.globalDefaults', dropped);
    for (const [challengeId, values] of Object.entries(perChallenge)) {
        if (isPlainObject(values)) {
            dropInvalidSchemaValues(values, `challengeSettings.perChallenge.${challengeId}`, dropped);
        } else {
            delete perChallenge[challengeId];
            dropped.push(`challengeSettings.perChallenge.${challengeId}`);
        }
    }
    return dropped;
};

// Run obsolete-settings cleanup once per process. The re-entry guard exists
// because cleanupObsoleteSettings calls back into loadSettings.
const _cleanupOnce = () => {
    if (migrationInProgress) return;
    migrationInProgress = true;
    try {
        if (!cleanupCompleted) {
            cleanupObsoleteSettings();
            cleanupCompleted = true;
        }
    } finally {
        migrationInProgress = false;
    }
};

/**
 * Default settings for a missing or unreadable file, logging which case applied.
 *
 * @param {string} message
 * @returns {AppSettings}
 */
const _loadDefaults = (message) => {
    const defaultSettings = getDefaultSettings();
    logger.withCategory('settings').info(`${message}: ${Object.keys(defaultSettings).join(', ')}`);
    return defaultSettings;
};

/**
 * Load settings from the userData directory
 *
 * @returns {AppSettings}
 */
const loadSettings = () => {
    try {
        // Read via the storage adapter so the Capacitor cache path is exercised
        // on Android; Electron/CLI hit fs synchronously. Falsy when no file exists.
        const settingsData = storage.readRaw();

        if (settingsData) {
            const mergedSettings = mergeWithDefaults(JSON.parse(settingsData));
            const migrated = runMigrations(mergedSettings);
            if (settingsData !== lastCleanRaw) {
                const dropped = dropInvalidValues(mergedSettings);
                const warning = `Ignoring stored settings that are not valid (defaults apply): ${oneLine(dropped.join(', ')).slice(0, 500)}`;
                if (dropped.length === 0) {
                    lastCleanRaw = settingsData;
                } else if (warning !== lastWarning) {
                    lastWarning = warning;
                    logger.withCategory('settings').warning(warning);
                }
            }
            if (migrated) {
                storage.writeRaw(JSON.stringify(mergedSettings, null, 2));
            }
            _cleanupOnce();
            return mergedSettings;
        }

        return _loadDefaults('No settings file found, loaded default settings with keys');
    } catch (error) {
        logger.withCategory('settings').error('Error loading settings:', error);
        return _loadDefaults('Loaded default settings with keys');
    }
};

/**
 * Save settings to the userData directory
 *
 * @param {Partial<AppSettings>} settings
 * @returns {boolean}
 */
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

/**
 * Clean up obsolete settings that are no longer used
 */
const cleanupObsoleteSettings = () => {
    try {
        const settings = loadSettings();
        if (pruneObsoleteSettings(settings)) {
            logger.withCategory('settings').debug('Settings cleanup completed - saving cleaned settings');
            // Write the full cleaned blob directly: saveSettings merges over the
            // on-disk settings, which would resurrect deleted top-level keys.
            storage.writeRaw(JSON.stringify(settings, null, 2));
        }
    } catch (error) {
        logger.withCategory('settings').error('Error during settings cleanup:', error);
    }
};

/**
 * Get a specific setting
 *
 * @template {string} K
 * @param {K} key
 * @returns {AppSettings[K]}
 */
const getSetting = (key) => {
    return loadSettings()[key];
};

/**
 * Set a specific setting
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {boolean}
 */
const setSetting = (key, value) => {
    const settings = loadSettings();
    settings[key] = value;
    return saveSettings(settings);
};

/**
 * Check if a setting requires app reload when changed
 *
 * @param {string} key
 * @returns {boolean|undefined}
 */
const isReloadRequired = (key) => {
    // Only these settings require a reload
    const reloadSettings = ['theme', 'language', 'timezone'];

    // Check if it's a challenge-specific setting
    const entry = schemaEntry(key);
    const isChallengeSetting = entry && entry.perChallenge;

    return reloadSettings.includes(key) || isChallengeSetting;
};

/**
 * Save window bounds for a specific window type
 *
 * @param {WindowType} windowType
 * @param {WindowBounds} bounds
 * @returns {boolean}
 */
const saveWindowBounds = (windowType, bounds) => {
    const settings = loadSettings();
    if (!settings.windowBounds) {
        settings.windowBounds = /** @type {AppSettings['windowBounds']} */ ({});
    }
    settings.windowBounds[windowType] = bounds;
    return saveSettings(settings);
};

/**
 * Get window bounds for a specific window type
 *
 * @param {WindowType} windowType
 * @returns {WindowBounds}
 */
const getWindowBounds = (windowType) => {
    const settings = loadSettings();
    if (!settings.windowBounds || !settings.windowBounds[windowType]) {
        return getDefaultSettings().windowBounds[windowType];
    }
    return settings.windowBounds[windowType];
};

export {
    loadSettings,
    saveSettings,
    cleanupObsoleteSettings,
    getSetting,
    setSetting,
    isReloadRequired,
    saveWindowBounds,
    getWindowBounds,
};
