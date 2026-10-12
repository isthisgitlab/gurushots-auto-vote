/**
 * Load/save mechanics of the settings blob over the storage adapter: read +
 * merge over defaults + load-time migrations, the once-per-process obsolete
 * key cleanup, whole-blob save, top-level key accessors, and window bounds.
 * Sole owner of the load-time re-entry/cleanup guards; the persisted bytes
 * themselves (and Capacitor's write-behind cache) are owned by storage.ts.
 */

import * as logger from '../logger';
import { schemaEntry } from './schema';
import { getSaveDroppedCause, isSaveDropped, onSaveDroppedChange, storage } from './storage';
import type { SaveDroppedCause } from './storage';
import { errorMessage } from '../errorMessage';
import { getDefaultSettings } from './defaults';
import { dropInvalidValues, isPrototypeKey, mergeWithDefaults, topLevelValueAllowed } from './loadValidation';
import { runMigrations, pruneObsoleteSettings } from './migrations';
import { isPlainObject } from '../plainObject';
import { oneLine } from '../format/logSafe';

import type { AppSettings, WindowBounds, WindowType } from '../types/settings';

// Module-local guards so cleanupObsoleteSettings (which itself calls
// loadSettings) doesn't recurse and doesn't re-run on every read.
let migrationInProgress = false;
let cleanupCompleted = false;

// The last file text found to hold only valid values, so an unchanged file is
// not re-validated on every read; and the last warning, so an invalid file
// warns once rather than on every read.
let lastCleanRaw: string | null = null;
let lastWarning: string | null = null;

/**
 * Why the stored settings are not in use, for a renderer or the CLI to tell the user. `code` is stable:
 *   - settings-corrupt: the file is not a parseable settings object; it sits at `path`, set aside. Defaults apply and
 *     saves work.
 *   - settings-unreadable: the file cannot be read, or cannot be set aside; `path` is the settings file. Saves are
 *     refused until it can be read.
 *   - settings-migration-failed: the file parses but cannot be brought up to date; `path` is the settings file. Saves
 *     are refused until it can be.
 */
type SettingsRecovery = {
    code: 'settings-corrupt' | 'settings-unreadable' | 'settings-migration-failed';
    path: string;
};

/**
 * A change the app window made to the settings that could not be saved (Android: the background service kept changing
 * the settings, or the save was refused), so the setting shows its stored value again. Not a recovery of the stored
 * settings, which are in use; `path` is where they live and `cause` why the save was given up. Cleared by the next save
 * that lands.
 */
type SettingsSaveDropped = { code: 'settings-save-dropped'; path: string; cause: SaveDroppedCause };

// Set while the stored settings cannot be used and must not be overwritten; cleared by the next load that gets through.
let blocked: SettingsRecovery | null = null;
// Where the last unparseable settings went; kept for the rest of the process so a window opened later can still say so.
let corruptBackupPath: string | null = null;
// The unparseable text already moved aside, so a store that keeps handing it back (the Android service's) is not
// moved, and logged, again on every read.
let lastQuarantinedRaw: string | null = null;

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
 */
const _loadDefaults = (message: string): AppSettings => {
    const defaultSettings = getDefaultSettings();
    logger.withCategory('settings').info(`${message}: ${Object.keys(defaultSettings).join(', ')}`);
    return defaultSettings;
};

/**
 * Settings that cannot be used and must not be overwritten: defaults apply for reads, saves are refused until a
 * load gets through, and getSettingsRecovery says why.
 */
const _blockWrites = (code: SettingsRecovery['code'], detail: string): AppSettings => {
    blocked = { code, path: storage.settingsLocation() };
    logger
        .withCategory('settings')
        .error(
            `Settings cannot be used (${code}); saving is refused so the stored settings are not overwritten: ${detail}`,
        );
    return _loadDefaults('Loaded default settings with keys');
};

/**
 * Parse the stored text as a settings object; the reason it is not one otherwise.
 */
const _parseSettings = (raw: string): { ok: true; value: object } | { ok: false; reason: string } => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return { ok: false, reason: `it is not valid JSON (${errorMessage(error)})` };
    }
    return isPlainObject(parsed) ? { ok: true, value: parsed } : { ok: false, reason: 'its root is not an object' };
};

/**
 * Settings text that does not parse is set aside once (see storage.quarantineRaw) and defaults apply, so the next
 * save writes a new file instead of mixing into a broken one. When it cannot be set aside it is left alone and
 * saves are refused.
 */
const _recoverCorrupt = (raw: string, reason: string): AppSettings => {
    if (raw === lastQuarantinedRaw) return _loadDefaults('Loaded default settings with keys');
    const moved = storage.quarantineRaw(raw);
    if (!moved.ok)
        return _blockWrites(
            'settings-unreadable',
            `the unusable settings (${reason}) could not be set aside: ${moved.error}`,
        );
    lastQuarantinedRaw = raw;
    corruptBackupPath = moved.path;
    blocked = null;
    logger
        .withCategory('settings')
        .error(`The stored settings were unusable (${reason}); they were moved to ${moved.path} and defaults apply`);
    return _loadDefaults('Loaded default settings with keys');
};

/**
 * Merge, migrate and validate the parsed settings. Any throw here means the file cannot be brought up to date, which
 * is not the same as it being broken: it is left as it is and saves are refused.
 */
const _interpretSettings = (settingsData: string, parsed: object): AppSettings => {
    const mergedSettings = mergeWithDefaults(parsed);
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
    blocked = null;
    if (migrated) {
        try {
            storage.writeRaw(JSON.stringify(mergedSettings, null, 2));
        } catch (error) {
            logger
                .withCategory('settings')
                .error('Could not save the migrated settings (they are migrated again on the next load):', error);
        }
    }
    return mergedSettings;
};

/**
 * Load settings from the userData directory
 */
const loadSettings = (): AppSettings => {
    let settingsData: string | null;
    try {
        // Read via the storage adapter so the Capacitor cache path is exercised
        // on Android; Electron/CLI hit fs synchronously. Falsy when no file exists.
        settingsData = storage.readRaw();
    } catch (error) {
        return _blockWrites('settings-unreadable', errorMessage(error) ?? 'unknown error');
    }

    if (!settingsData) {
        blocked = null;
        return _loadDefaults('No settings file found, loaded default settings with keys');
    }

    const parsed = _parseSettings(settingsData);
    if (!parsed.ok) return _recoverCorrupt(settingsData, parsed.reason);

    let settings: AppSettings;
    try {
        settings = _interpretSettings(settingsData, parsed.value);
    } catch (error) {
        return _blockWrites('settings-migration-failed', errorMessage(error) ?? 'unknown error');
    }
    _cleanupOnce();
    return settings;
};

/**
 * Why the stored settings are not in use, or null: see SettingsRecovery.
 */
const getSettingsRecovery = (): SettingsRecovery | null =>
    blocked ?? (corruptBackupPath ? { code: 'settings-corrupt', path: corruptBackupPath } : null);

/**
 * The change the app window made last that could not be saved, or null: see SettingsSaveDropped.
 */
const getSettingsSaveDropped = (): SettingsSaveDropped | null =>
    isSaveDropped()
        ? { code: 'settings-save-dropped', path: storage.settingsLocation(), cause: getSaveDroppedCause() }
        : null;

/**
 * Write the whole settings blob, unless the stored settings are not usable (writing then would erase them).
 */
const _persist = (settings: object): boolean => {
    if (blocked) {
        logger
            .withCategory('settings')
            .error(`Not saving settings: ${blocked.code}; the stored settings at ${blocked.path} are left as they are`);
        return false;
    }
    return storage.writeRaw(JSON.stringify(settings, null, 2));
};

/**
 * Save settings to the userData directory
 */
const saveSettings = (settings: Partial<AppSettings>): boolean => {
    try {
        // A key that names an Object.prototype member, or a value its schema entry or range rejects, is refused whole.
        const refused = Object.keys(settings).find(
            (key) => isPrototypeKey(key) || !topLevelValueAllowed(key, settings[key]),
        );
        if (refused !== undefined) {
            logger.withCategory('settings').error(`Invalid setting not saved: ${oneLine(refused)}`, null);
            return false;
        }

        // Merge with existing settings
        const currentSettings = loadSettings();
        const mergedSettings = { ...currentSettings, ...settings };

        // Write via storage adapter (sync fs on Electron/CLI; cache + async write-behind on Capacitor)
        return _persist(mergedSettings);
    } catch (error) {
        logger.withCategory('settings').error('Error saving settings:', error);
        return false;
    }
};

/**
 * Prune keys the schema does not define from the stored settings and write the
 * result back when anything was removed.
 */
const cleanupObsoleteSettings = () => {
    try {
        const settings = loadSettings();
        if (pruneObsoleteSettings(settings)) {
            logger.withCategory('settings').debug('Settings cleanup completed - saving cleaned settings');
            // Write the full cleaned blob directly: saveSettings merges over the
            // on-disk settings, which would resurrect deleted top-level keys.
            _persist(settings);
        }
    } catch (error) {
        logger.withCategory('settings').error('Error during settings cleanup:', error);
    }
};

/**
 * Get a specific setting
 */
const getSetting = <K extends string>(key: K): AppSettings[K] => {
    return loadSettings()[key];
};

/**
 * Set a specific setting
 */
const setSetting = (key: string, value: unknown): boolean => {
    if (isPrototypeKey(key)) {
        logger.withCategory('settings').error(`Invalid setting key: ${oneLine(key)}`, null);
        return false;
    }
    // Only the changed key: saveSettings merges it onto the settings it loads itself, so what another writer saved
    // between two reads is not written back over.
    return saveSettings({ [key]: value });
};

/**
 * Check if a setting requires app reload when changed
 */
const isReloadRequired = (key: string): boolean | undefined => {
    // Only these settings require a reload
    const reloadSettings = ['theme', 'language', 'timezone'];

    // Check if it's a challenge-specific setting
    const entry = schemaEntry(key);
    const isChallengeSetting = entry && entry.perChallenge;

    return reloadSettings.includes(key) || isChallengeSetting;
};

/**
 * Save window bounds for a specific window type
 */
const saveWindowBounds = (windowType: WindowType, bounds: WindowBounds): boolean => {
    const settings = loadSettings();
    if (!settings.windowBounds) {
        settings.windowBounds = {} as AppSettings['windowBounds'];
    }
    settings.windowBounds[windowType] = bounds;
    return saveSettings(settings);
};

/**
 * Get window bounds for a specific window type
 */
const getWindowBounds = (windowType: WindowType): WindowBounds => {
    const settings = loadSettings();
    if (!settings.windowBounds || !settings.windowBounds[windowType]) {
        return getDefaultSettings().windowBounds[windowType];
    }
    return settings.windowBounds[windowType];
};

export type { SettingsRecovery };
export {
    getSettingsRecovery,
    getSettingsSaveDropped,
    onSaveDroppedChange as onSettingsSaveDroppedChange,
    isPrototypeKey,
    loadSettings,
    saveSettings,
    cleanupObsoleteSettings,
    getSetting,
    setSetting,
    isReloadRequired,
    saveWindowBounds,
    getWindowBounds,
};
