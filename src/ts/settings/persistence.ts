/**
 * Load/save mechanics of the settings blob over the storage adapter: read +
 * merge over defaults + load-time migrations, the once-per-process obsolete
 * key cleanup, whole-blob save, top-level key accessors, and window bounds.
 * Sole owner of the load-time re-entry/cleanup guards; the persisted bytes
 * themselves (and Capacitor's write-behind cache) are owned by storage.ts.
 */

import * as logger from '../logger';
import { schemaEntry, validateSetting } from './schema';
import { storage } from './storage';
import { API_MAX_RETRIES_MAX, API_TIMEOUT_MAX_SEC, API_TIMEOUT_MIN_SEC } from './limits';
import { errorMessage } from '../errorMessage';
import { getDefaultSettings } from './defaults';
import { runMigrations, pruneObsoleteSettings } from './migrations';
import { isPlainObject } from '../plainObject';
import { oneLine } from '../format/logSafe';
import { isUnsafeChallengeKey } from '../metadata/validation';

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
 *   - settings-corrupt: the file did not parse (or was no object) and was moved to `path`; defaults apply and saves work.
 *   - settings-unreadable: the file could not be read, or could not be moved aside; `path` is the settings file.
 *     Saves are refused until it can be read.
 *   - settings-migration-failed: the file parsed but could not be brought up to date; `path` is the settings file.
 *     Saves are refused until it can be.
 */
type SettingsRecovery = {
    code: 'settings-corrupt' | 'settings-unreadable' | 'settings-migration-failed';
    path: string;
};

// Set while the stored settings cannot be used and must not be overwritten; cleared by the next load that gets through.
let blocked: SettingsRecovery | null = null;
// Where the last unparseable settings went; kept for the rest of the process so a window opened later can still say so.
let corruptBackupPath: string | null = null;
// The unparseable text already moved aside, so a store that keeps handing it back (the Android service's) is not
// moved, and logged, again on every read.
let lastQuarantinedRaw: string | null = null;

/**
 * Merge parsed persisted settings over the defaults so all properties
 * exist, and resolve the environment-aware mock default.
 *
 * @param settings - the parsed persisted blob
 */
const mergeWithDefaults = (settings: unknown): AppSettings => {
    const defaults = getDefaultSettings();
    // Defaults carry the environment-aware mock value, so a persisted blob
    // without `mock` (JSON never holds `undefined`) inherits it here.
    const merged: AppSettings = { ...defaults, ...(settings as Partial<AppSettings>) };
    // A stored challengeSettings block that predates one of its containers gets
    // the default container here, on every read: dropInvalidValues is skipped
    // for unchanged file text, so it cannot be the one to fill it.
    if (isPlainObject(merged.challengeSettings)) {
        merged.challengeSettings = { ...defaults.challengeSettings, ...merged.challengeSettings };
    }
    return merged;
};

/**
 * Whether a stored top-level value has its default's type. The only list
 * default is customTimezones, a list of zone names.
 */
const hasDefaultsType = (value: unknown, fallback: unknown) =>
    Array.isArray(fallback)
        ? Array.isArray(value) && value.every((item) => typeof item === 'string')
        : typeof value === typeof fallback;

// The top-level numbers with a range narrower than their type: the API client and the cadence trust them. The
// retry delay and the check frequency have the range the settings form offers.
const NUMERIC_BOUNDS: Record<string, { min: number; max: number; integer: boolean }> = {
    apiTimeout: { min: API_TIMEOUT_MIN_SEC, max: API_TIMEOUT_MAX_SEC, integer: false },
    apiMaxRetries: { min: 0, max: API_MAX_RETRIES_MAX, integer: true },
    apiRetryBaseDelayMs: { min: 100, max: 10_000, integer: true },
    checkFrequencyMin: { min: 1, max: 60, integer: false },
    checkFrequencyMax: { min: 1, max: 60, integer: false },
};

/**
 * Whether a top-level setting's value is inside its range (a key without one always is).
 */
const withinNumericBounds = (key: string, value: unknown): boolean => {
    if (!Object.hasOwn(NUMERIC_BOUNDS, key)) return true;
    const { min, max, integer } = NUMERIC_BOUNDS[key];
    return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= min &&
        value <= max &&
        (!integer || Number.isInteger(value))
    );
};

/**
 * Whether a top-level value is one its key allows: a top-level setting with a schema entry (the app-state flags such
 * as autovoteRunning or noticeAcknowledgedVersion) must pass the entry's validation, and a number with a range stays
 * inside it. Keys the schema does not know are the facade's to keep as they are.
 */
const topLevelValueAllowed = (key: string, value: unknown): boolean =>
    withinNumericBounds(key, value) && validateSetting(key, value);

/**
 * Whether a key addresses an Object.prototype member (`constructor`, `toString`, `__proto__`, ...) rather than a
 * setting: stored under such a name it would shadow the member for every plain-object lookup.
 */
const isPrototypeKey = (key: string): boolean => key in Object.prototype;

/**
 * Remove the values of `values` (a globalDefaults or per-challenge map) that
 * their key's schema validation rejects. Keys the schema does not know are
 * left to pruneObsoleteSettings.
 */
const dropInvalidSchemaValues = (values: Record<string, unknown>, path: string, dropped: string[]) => {
    for (const [key, value] of Object.entries(values)) {
        const entry = schemaEntry(key);
        if (entry?.validation && !entry.validation.safeParse(value).success) {
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
 */
const dropInvalidValues = (settings: AppSettings): string[] => {
    const dropped: string[] = [];
    for (const [key, fallback] of Object.entries(getDefaultSettings())) {
        if (!isPlainObject(fallback) && !hasDefaultsType(settings[key], fallback)) {
            settings[key] = fallback;
            dropped.push(key);
        }
    }
    for (const key of Object.keys(settings).filter(isPrototypeKey)) {
        delete settings[key];
        dropped.push(oneLine(key));
    }
    for (const key of Object.keys(NUMERIC_BOUNDS)) {
        if (!withinNumericBounds(key, settings[key])) {
            settings[key] = getDefaultSettings()[key];
            dropped.push(key);
        }
    }
    // A top-level app-state flag that its schema entry rejects is removed; readers treat it as never set.
    for (const key of Object.keys(settings)) {
        if (schemaEntry(key) && !validateSetting(key, settings[key])) {
            delete settings[key];
            dropped.push(key);
        }
    }
    const challengeSettings = settings.challengeSettings as unknown;
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
            dropped.push(`challengeSettings.${key}`);
            challengeSettings[key] = fallback;
        }
    }
    const { globalDefaults, perChallenge } = settings.challengeSettings;
    dropInvalidSchemaValues(globalDefaults, 'challengeSettings.globalDefaults', dropped);
    for (const [challengeId, values] of Object.entries(perChallenge)) {
        if (isPlainObject(values) && !isUnsafeChallengeKey(challengeId)) {
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
    const settings = loadSettings();
    settings[key] = value;
    return saveSettings(settings);
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
