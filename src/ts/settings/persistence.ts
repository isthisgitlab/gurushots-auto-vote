/**
 * Load/save mechanics of the configuration over the storage adapter: read +
 * validation + fill over the defaults, the one-time import of a 1.x
 * `settings.json` when there is no configuration yet, whole-config save,
 * `app` / `auth` key accessors, window bounds, and the recovery states of a
 * configuration that cannot be used. Sole owner of the load-time re-entry
 * guards; the persisted bytes themselves (and Capacitor's write-behind cache)
 * are owned by storage.ts.
 */

import * as logger from '../logger';
import { schemaEntry } from './schema';
import { getSaveDroppedCause, isSaveDropped, legacyStorage, onSaveDroppedChange, storage } from './storage';
import type { SaveDroppedCause } from './storage';
import { errorMessage } from '../errorMessage';
import { getDefaultSettings } from './defaults';
import {
    appValueAllowed,
    authValueAllowed,
    dropInvalidValues,
    isAuthKey,
    isPrototypeKey,
    mergeWithDefaults,
} from './loadValidation';
import {
    blankLegacyAuthOnce,
    importWhenAbsent,
    reimportLegacyFile,
    retryLegacyImport,
    startFreshConfig,
} from './legacyImport';
import type { ImportFailure, ImportOutcome } from './legacyImport';
import { canonicalLegacyHash, updateImported } from './importedRecord';
import { isPlainObject } from '../plainObject';
import { oneLine } from '../format/logSafe';

import type { ConfigApp, ConfigAuthV2, ConfigV2 } from '../types/config';
import type { WindowBounds, WindowType } from '../types/settings';

// The last file text found to hold only valid values, so an unchanged file is
// not re-validated on every read; and the last warning, so an invalid file
// warns once rather than on every read.
let lastCleanRaw: string | null = null;
let lastWarning: string | null = null;

/**
 * Why the stored configuration is not in use, or what a start found worth telling, for a renderer or the CLI to tell
 * the user. `code` is stable; `blocking` says whether saves are refused while it stands (a notice only informs):
 *   - settings-corrupt (notice): `config.json` is not a parseable configuration; it sits at `path`, set aside. Defaults
 *     apply and saves work. It is never replaced by an import unasked (`reimportFromV1` is the explicit way).
 *   - settings-unreadable (blocking): `config.json` cannot be read, or cannot be set aside; `path` is the configuration
 *     file. Saves are refused until it can be read.
 *   - settings-import-failed (blocking): there is no `config.json` and the 1.x `settings.json` at `path` could not be
 *     imported (it cannot be read, is damaged, cannot be converted, or is not loaded yet). Nothing is written and
 *     saves are refused until the import is retried (`retryImport`), a fresh configuration is started (`startFresh`,
 *     which leaves `settings.json` as a backup) or the file is fixed.
 *   - settings-v1-changed (notice): `settings.json` at `path` is not the file the configuration was imported from.
 *     Saves work. Cleared by `reimportFromV1` (import it again) or `keepCurrentConfig` (it stays as it is).
 */
type SettingsRecovery = {
    code: 'settings-corrupt' | 'settings-unreadable' | 'settings-import-failed' | 'settings-v1-changed';
    path: string;
    blocking: boolean;
};

/**
 * A change the app window made to the settings that could not be saved (Android: the background service kept changing
 * the settings, or the save was refused), so the setting shows its stored value again. Not a recovery of the stored
 * settings, which are in use; `path` is where they live and `cause` why the save was given up. Cleared by the next save
 * that lands.
 */
type SettingsSaveDropped = { code: 'settings-save-dropped'; path: string; cause: SaveDroppedCause };

// Set while the stored settings cannot be used and must not be overwritten; cleared by the next load that gets through.
let blocked: (SettingsRecovery & { blocking: true }) | null = null;
// Where the last unparseable configuration went; kept for the rest of the process so a window opened later can still say so.
let corruptBackupPath: string | null = null;
// The unparseable text already moved aside, so a store that keeps handing it back (the Android service's) is not
// moved, and logged, again on every read.
let lastQuarantinedRaw: string | null = null;
// The import that failed for a reason that will not pass by itself: not tried again until `retryImport`, so a
// damaged `settings.json` is not read and converted on every read of a setting. (A 'not-loaded' failure is tried again.)
let importFailure: ImportFailure | null = null;
// Whether this process has found out that no import is due (the marker says it ran, or a set-aside configuration says
// it must not run unasked): a read of the defaults then takes no lock and looks at nothing.
let importSettled = false;
// The path of `settings.json` while the last check found it changed since the import (see checkLegacyDrift).
let legacyChangedPath: string | null = null;

/**
 * Default configuration for a missing or unreadable file, logging which case applied.
 */
const _loadDefaults = (message: string): ConfigV2 => {
    const defaultSettings = getDefaultSettings();
    logger.withCategory('settings').info(`${message}: ${Object.keys(defaultSettings.app).join(', ')}`);
    return defaultSettings;
};

/**
 * A configuration that cannot be used and must not be overwritten: defaults apply for reads, saves are refused until a
 * load gets through, and getSettingsRecovery says why.
 */
const _blockWrites = (
    code: 'settings-unreadable' | 'settings-import-failed',
    detail: string,
    path: string,
): ConfigV2 => {
    blocked = { code, path, blocking: true };
    logger
        .withCategory('settings')
        .error(
            `Settings cannot be used (${code}); saving is refused so the stored settings are not overwritten: ${detail}`,
        );
    return _loadDefaults('Loaded default settings with keys');
};

/**
 * Parse the stored text as a configuration object; the reason it is not one otherwise.
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
 * Configuration text that does not parse is set aside once (see storage.quarantineRaw) and defaults apply, so the next
 * save writes a new file instead of mixing into a broken one. It is never replaced by an import: the set-aside copy
 * makes the import stand down. When it cannot be set aside it is left alone and saves are refused.
 */
const _recoverCorrupt = (raw: string, reason: string): ConfigV2 => {
    if (raw === lastQuarantinedRaw) return _loadDefaults('Loaded default settings with keys');
    const moved = storage.quarantineRaw(raw);
    if (!moved.ok) {
        return _blockWrites(
            'settings-unreadable',
            `the unusable settings (${reason}) could not be set aside: ${moved.error}`,
            storage.location(),
        );
    }
    lastQuarantinedRaw = raw;
    corruptBackupPath = moved.path;
    blocked = null;
    logger
        .withCategory('settings')
        .error(`The stored settings were unusable (${reason}); they were moved to ${moved.path} and defaults apply`);
    return _loadDefaults('Loaded default settings with keys');
};

/**
 * Fill and validate the parsed configuration.
 */
const _interpretSettings = (settingsData: string, parsed: object): ConfigV2 => {
    const config = mergeWithDefaults(parsed);
    if (settingsData !== lastCleanRaw) {
        const dropped = dropInvalidValues(config);
        const warning = `Ignoring stored settings that are not valid (defaults apply): ${oneLine(dropped.join(', ')).slice(0, 500)}`;
        if (dropped.length === 0) {
            lastCleanRaw = settingsData;
        } else if (warning !== lastWarning) {
            lastWarning = warning;
            logger.withCategory('settings').warning(warning);
        }
    }
    blocked = null;
    importFailure = null;
    return config;
};

/**
 * The configuration a stored text holds: parsed, filled and validated, or defaults (the damaged text set aside).
 */
const _loadFromText = (settingsData: string): ConfigV2 => {
    const parsed = _parseSettings(settingsData);
    if (!parsed.ok) return _recoverCorrupt(settingsData, parsed.reason);
    return _interpretSettings(settingsData, parsed.value);
};

/**
 * A failed import blocks saves, with the 1.x settings file as the place to look at. One that will not pass by itself
 * is remembered, so the next read does not try it again.
 */
const _importFailed = (failure: ImportFailure): ConfigV2 => {
    if (failure.reason !== 'not-loaded') importFailure = failure;
    return _blockWrites(
        'settings-import-failed',
        `the 1.x settings could not be imported (${failure.reason}): ${failure.detail}`,
        legacyStorage.location(),
    );
};

/**
 * An import that looked done (its configuration shown by the cache) and then was not stored: where the save is only
 * queued, the answer comes later. The cache is back to what is stored, so the next read finds no configuration, and
 * until the import is retried nothing is saved over what the 1.x file still holds.
 */
const _importFailedLater = (failure: ImportFailure): void => {
    _importFailed(failure);
};

/**
 * What a load finds when there is no configuration: the import of `settings.json` the first time, defaults after.
 */
const _loadWithoutConfig = (): ConfigV2 => {
    if (importFailure) return _loadDefaults('Loaded default settings with keys');
    if (importSettled) {
        blocked = null;
        return _loadDefaults('No settings file found, loaded default settings with keys');
    }
    const outcome = importWhenAbsent(_importFailedLater);
    if (!outcome.ok) return _importFailed(outcome);
    if (outcome.kind === 'imported' || outcome.kind === 'adopted') return _loadFromText(outcome.text);
    importSettled = true;
    blocked = null;
    return _loadDefaults('No settings file found, loaded default settings with keys');
};

/**
 * Load the configuration from the userData directory (on the first load without one, importing the 1.x settings).
 */
const loadSettings = (): ConfigV2 => {
    let settingsData: string | null;
    try {
        // Read via the storage adapter so the Capacitor cache path is exercised
        // on Android; Electron/CLI hit fs synchronously. Falsy when no file exists.
        settingsData = storage.readRaw();
    } catch (error) {
        return _blockWrites('settings-unreadable', errorMessage(error) ?? 'unknown error', storage.location());
    }
    const config = settingsData ? _loadFromText(settingsData) : _loadWithoutConfig();
    if (blocked === null) blankLegacyAuthOnce();
    return config;
};

/**
 * Why the stored settings are not in use, or null: see SettingsRecovery.
 */
const getSettingsRecovery = (): SettingsRecovery | null => {
    if (blocked) return blocked;
    if (corruptBackupPath) return { code: 'settings-corrupt', path: corruptBackupPath, blocking: false };
    return legacyChangedPath ? { code: 'settings-v1-changed', path: legacyChangedPath, blocking: false } : null;
};

/**
 * The change the app window made last that could not be saved, or null: see SettingsSaveDropped.
 */
const getSettingsSaveDropped = (): SettingsSaveDropped | null =>
    isSaveDropped() ? { code: 'settings-save-dropped', path: storage.location(), cause: getSaveDroppedCause() } : null;

/**
 * Write the whole configuration, unless the stored settings are not usable (writing then would erase them).
 */
const _persist = (config: ConfigV2): boolean => {
    if (blocked) {
        logger
            .withCategory('settings')
            .error(`Not saving settings: ${blocked.code}; the stored settings at ${blocked.path} are left as they are`);
        return false;
    }
    return storage.writeRaw(JSON.stringify({ ...config, version: 2 }, null, 2));
};

/**
 * The key of the first value in a partial configuration that may not be saved: an `app` key that names an
 * Object.prototype member, or an `app` or `auth` value its schema entry or range rejects.
 */
const _refusedKey = (settings: Partial<ConfigV2>): string | undefined => {
    const { app, auth } = settings;
    const appKey = app && Object.keys(app).find((key) => isPrototypeKey(key) || !appValueAllowed(key, app[key]));
    if (appKey !== undefined) return appKey;
    return auth && Object.keys(auth).find((key) => !isAuthKey(key) || !authValueAllowed(key, auth[key]));
};

/**
 * Save what `change` makes of the configuration as it is stored now: it is loaded once, here, and the change is made on
 * it, so what another writer saved between two reads is not written back over. A key that names an Object.prototype
 * member, or a value its schema entry or range rejects, refuses the whole save.
 */
const _saveChange = (change: (current: ConfigV2) => Partial<ConfigV2>): boolean => {
    try {
        const current = loadSettings();
        const changed = change(current);
        const refused = _refusedKey(changed);
        if (refused !== undefined) {
            logger.withCategory('settings').error(`Invalid setting not saved: ${oneLine(refused)}`, null);
            return false;
        }
        // Write via storage adapter (sync fs on Electron/CLI; cache + async write-behind on Capacitor)
        return _persist({ ...current, ...changed });
    } catch (error) {
        logger.withCategory('settings').error('Error saving settings:', error);
        return false;
    }
};

/**
 * Save the configuration: the containers given replace the stored ones whole, the others stay. Callers load, change
 * what they mean to and save the loaded configuration back.
 */
const saveSettings = (settings: Partial<ConfigV2>): boolean => _saveChange(() => settings);

/**
 * Set several `app` keys at once on the configuration as it is stored now (the settings form's payload).
 */
const saveAppSettings = (settings: Partial<ConfigApp>): boolean =>
    _saveChange((current) => ({ app: { ...current.app, ...settings } }));

/**
 * Get a specific setting: an `auth` key (`token`, `apiHeaders`, `lastUsername`, `chosenPhotosMemberId`) from the
 * sign-in state, any other key from `app`.
 */
const getSetting = <K extends string>(key: K): (ConfigApp & ConfigAuthV2)[K] => {
    const config = loadSettings();
    return (isAuthKey(key) ? config.auth[key] : config.app[key]) as (ConfigApp & ConfigAuthV2)[K];
};

/**
 * Set a specific setting: an `auth` key in the sign-in state, any other key in `app`. Only the changed key is
 * written, on the configuration as it is stored now.
 */
const setSetting = (key: string, value: unknown): boolean => {
    if (isPrototypeKey(key)) {
        logger.withCategory('settings').error(`Invalid setting key: ${oneLine(key)}`, null);
        return false;
    }
    return _saveChange((current) =>
        isAuthKey(key) ? { auth: { ...current.auth, [key]: value } } : { app: { ...current.app, [key]: value } },
    );
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
const saveWindowBounds = (windowType: WindowType, bounds: WindowBounds): boolean =>
    // A file that holds no (or a broken) bounds container gets one.
    _saveChange((current) => ({
        app: { ...current.app, windowBounds: { ...current.app.windowBounds, [windowType]: bounds } },
    }));

/**
 * Get window bounds for a specific window type
 */
const getWindowBounds = (windowType: WindowType): WindowBounds => {
    const { windowBounds } = loadSettings().app;
    if (!windowBounds || !windowBounds[windowType]) {
        return getDefaultSettings().app.windowBounds[windowType];
    }
    return windowBounds[windowType];
};

/**
 * What a recovery action came to: the failure it ran into leaves the state as it was, except that a configuration
 * that is no longer there blocks saves (the import is what is missing). Never throws.
 */
const _recovered = (run: () => ImportOutcome): boolean => {
    try {
        const outcome = run();
        if (outcome.ok) {
            importFailure = null;
            importSettled = false;
            blocked = null;
            return true;
        }
        logger
            .withCategory('settings')
            .error(`The 1.x settings could not be imported (${outcome.reason}): ${outcome.detail}`);
        if (storage.readRaw() === null) _importFailed(outcome);
    } catch (error) {
        logger
            .withCategory('settings')
            .error(`The 1.x settings could not be imported: ${errorMessage(error) ?? 'unknown error'}`);
    }
    return false;
};

/**
 * Import `settings.json` again after it failed (the file was fixed, or has loaded since): the operation that failed,
 * run as the explicit import it is whatever the marker and a set-aside configuration say.
 *
 * @returns whether a configuration is stored now
 */
const retryImport = (): boolean => _recovered(() => retryLegacyImport(_importFailedLater));

/**
 * Begin with a default configuration instead of importing: `settings.json` stays where it is, as a backup, and is
 * not imported later unasked.
 *
 * @returns whether the configuration was written
 */
const startFresh = (): boolean => _recovered(() => startFreshConfig(_importFailedLater));

/**
 * Import `settings.json` again on request: the configuration in use is set aside the way a damaged one is
 * (`config.json.corrupt-<time>`) and the import is saved in its place, keeping the sign-in state.
 *
 * @returns whether the import was saved
 */
const reimportFromV1 = (): boolean => {
    const recovered = _recovered(() => reimportLegacyFile(_importFailedLater));
    // The damaged configuration the notice was about is not the one in use any more, and the file it imports is the
    // one it was compared with.
    if (recovered) {
        corruptBackupPath = null;
        legacyChangedPath = null;
    }
    return recovered;
};

/**
 * The hash of the 1.x `settings.json` as it is now, or null when there is none to compare (missing, not loaded yet or
 * not a JSON object): such a file is no drift, since there is nothing to import from.
 */
const _legacyHash = async (): Promise<string | null> => {
    const raw = legacyStorage.readRaw();
    return raw ? canonicalLegacyHash(raw) : null;
};

/**
 * Compare `settings.json` with the one the configuration was imported from (the hash in `imported.sha256`) and, when
 * they differ (edited after a downgrade, or by a 1.x command line sharing the user data), raise the
 * settings-v1-changed notice; saves stay allowed. A record without a hash (the process that imported ended before
 * it was written) takes the hash of the file as it is, without a notice. Run once per start by the shell after its
 * settings are hydrated; never throws.
 */
const checkLegacyDrift = async (): Promise<void> => {
    try {
        legacyChangedPath = null;
        const { imported } = loadSettings();
        if (blocked || !imported) return;
        const hash = await _legacyHash();
        if (hash === null) return;
        if (imported.sha256 === '') {
            updateImported((record) => ({ ...record, sha256: hash }));
        } else if (imported.sha256 !== hash) {
            legacyChangedPath = legacyStorage.location();
        }
    } catch (error) {
        logger.withCategory('settings').error('Could not compare settings.json with the import:', error);
    }
};

/**
 * Keep the settings as they are after `settings.json` changed: the hash of the file as it is now is recorded, so the
 * notice goes away and the next start compares with this file.
 *
 * @returns whether the notice was cleared
 */
const keepCurrentConfig = async (): Promise<boolean> => {
    try {
        const hash = await _legacyHash();
        if (hash !== null && !updateImported((record) => ({ ...record, sha256: hash }))) return false;
        legacyChangedPath = null;
        return true;
    } catch (error) {
        logger.withCategory('settings').error('Could not record the current settings.json:', error);
        return false;
    }
};

/**
 * What the 1.x import left unresolved, or null when the configuration was not imported from a `settings.json`. The
 * report stays after it is acknowledged (About and data shows it).
 */
const getImportReport = (): { at: string; refsBlocked: string[]; acknowledged: boolean } | null => {
    const { imported } = loadSettings();
    return imported
        ? { at: imported.at, refsBlocked: [...imported.report.refsBlocked], acknowledged: imported.acknowledged }
        : null;
};

/**
 * Mark the import report as seen.
 *
 * @returns whether it is recorded as acknowledged
 */
const acknowledgeImportReport = (): boolean =>
    updateImported((record) => (record.acknowledged ? null : { ...record, acknowledged: true }));

export type { SettingsRecovery };
export {
    getSettingsRecovery,
    getSettingsSaveDropped,
    onSaveDroppedChange as onSettingsSaveDroppedChange,
    isPrototypeKey,
    loadSettings,
    saveSettings,
    saveAppSettings,
    getSetting,
    setSetting,
    isReloadRequired,
    saveWindowBounds,
    getWindowBounds,
    retryImport,
    startFresh,
    reimportFromV1,
    checkLegacyDrift,
    keepCurrentConfig,
    getImportReport,
    acknowledgeImportReport,
};
