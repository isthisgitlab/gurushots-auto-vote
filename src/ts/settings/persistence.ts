/**
 * Load/save mechanics of the configuration over the storage adapter: read +
 * validation + fill over the defaults, the one-time import of `settings.json`
 * when there is no configuration yet, whole-config save, `app` / `auth` key
 * accessors, window bounds, and the recovery states of a configuration that
 * cannot be used. Sole owner of the load-time re-entry guards; the persisted
 * bytes themselves (and Capacitor's write-behind cache) are owned by storage.ts.
 * The guards' state is the object in `persistence/state.ts`, and the load and
 * import writers are its `persistence/` siblings (`types`, `blocking`,
 * `loadText`, `importFlow`) — every caller imports this module only.
 */

import * as logger from '../logger';
import {
    getSaveDroppedCause,
    getSaveDroppedSerial,
    isSaveDropped,
    legacyStorage,
    onSaveDroppedChange,
    storage,
} from './storage';
import type { QueuedWriteOutcome, SaveDroppedCause } from './storage';
import { errorMessage } from '../errorMessage';
import { getDefaultSettings } from './defaults';
import { isAuthKey, isPrototypeKey } from './loadValidation';
import { retryLegacyImport, startFreshConfig } from './legacyImport';
import type { ImportOutcome } from './legacyImport';
import { updateImported } from './importedRecord';
import { flushPendingMarkerChanges } from './importMarker';
import { oneLine } from '../format/logSafe';
import { _blockWrites, _storesLoaded, clearBlocked } from './persistence/blocking';
import { _importFailed, _importFailedLater, _loadWithoutConfig } from './persistence/importFlow';
import { _loadFromText } from './persistence/loadText';
import { _refusedKey } from './persistence/types';
import { state } from './persistence/state';

import type { ConfigApp, ConfigAuthV2, ConfigV2, ImportRef } from '../types/config';
import type { WindowBounds, WindowType } from '../types/settings';
import type { SettingsRecovery } from './persistence/types';

/**
 * What the import left unresolved: `refsBlocked` holds a reference as the user knows its parts, or the text an earlier build stored.
 */
type ImportReport = { at: string; refsBlocked: Array<string | ImportRef>; acknowledged: boolean };

/**
 * A change the app window made to the settings that could not be saved (Android: the background service kept changing
 * the settings, or the save was refused), so the setting shows its stored value again. Not a recovery of the stored
 * settings, which are in use; `path` is where they live, `cause` why the save was given up and `serial` which of the saves
 * given up this was (a window shows a notice again when it changes). Cleared by the next save that lands.
 */
type SettingsSaveDropped = { code: 'settings-save-dropped'; path: string; cause: SaveDroppedCause; serial: number };

/**
 * Load the configuration from the userData directory (on the first load without one, importing `settings.json`).
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
    return settingsData ? _loadFromText(settingsData, storage.isPersisted()) : _loadWithoutConfig();
};

/**
 * Why the stored settings are not in use, or null: see SettingsRecovery.
 */
const getSettingsRecovery = (): SettingsRecovery | null => {
    if (state.blocked) return state.blocked;
    if (state.corruptBackupPath !== null)
        return { code: 'settings-corrupt', path: state.corruptBackupPath, blocking: false };
    if (state.importFailure !== null && state.importPermanent) {
        return {
            code: 'settings-import-failed',
            path: legacyStorage.location(),
            blocking: false,
            detail: state.importFailure.reason,
        };
    }
    return null;
};

/**
 * Tells `listener` when a read clears the block it had put up (the one subscriber is replaced by the next).
 */
const onRecoveryChange = (listener: (() => void) | null): void => {
    state.recoveryListener = listener;
};

/**
 * The change the app window made last that could not be saved, or null: see SettingsSaveDropped.
 */
const getSettingsSaveDropped = (): SettingsSaveDropped | null =>
    isSaveDropped()
        ? {
              code: 'settings-save-dropped',
              path: storage.location(),
              cause: getSaveDroppedCause(),
              serial: getSaveDroppedSerial(),
          }
        : null;

/** What saving the configuration came to: whether it was written, and where the write is only queued (the Android app window) how it ends. */
type Persisted = { ok: boolean; landed?: Promise<QueuedWriteOutcome> };

/**
 * Write the whole configuration, unless the stored settings are not usable (writing then would erase them).
 */
const _persist = (config: ConfigV2): Persisted => {
    if (!_storesLoaded()) {
        // What this was built on is the defaults a read answered before the stored settings were there: saving would replace them.
        logger.withCategory('settings').warning('Not saving settings: the stored settings have not been read yet');
        return { ok: false };
    }
    if (state.blocked) {
        logger
            .withCategory('settings')
            .error(
                `Not saving settings: ${state.blocked.code}; the stored settings at ${state.blocked.path} are left as they are`,
            );
        return { ok: false };
    }
    const written = storage.write(JSON.stringify({ ...config, version: 2 }, null, 2));
    // Changes of the marker that could not be made before are made again.
    if (written.ok) flushPendingMarkerChanges();
    return written;
};

/**
 * Save what `change` makes of the configuration as it is stored now: it is loaded once, here, and the change is made on
 * it, so what another writer saved between two reads is not written back over. A key that names an Object.prototype
 * member, or a value its schema entry or range rejects, refuses the whole save.
 */
const _saveChangeDetailed = (change: (current: ConfigV2) => Partial<ConfigV2>): Persisted => {
    try {
        const current = loadSettings();
        const changed = change(current);
        const refused = _refusedKey(changed);
        if (refused !== undefined) {
            logger.withCategory('settings').error(`Invalid setting not saved: ${oneLine(refused)}`, null);
            return { ok: false };
        }
        const next = { ...current, ...changed };
        // The saved user name goes with the choice to stay logged in: turning that off forgets the name in the same
        // write, whoever changes it (the form, the CLI, a script).
        if (current.app.stayLoggedIn === true && next.app.stayLoggedIn !== true && next.auth.lastUsername !== '') {
            next.auth = { ...next.auth, lastUsername: '' };
        }
        // Write via storage adapter (sync fs on Electron/CLI; cache + async write-behind on Capacitor)
        return _persist(next);
    } catch (error) {
        logger.withCategory('settings').error('Error saving settings:', error);
        return { ok: false };
    }
};

const _saveChange = (change: (current: ConfigV2) => Partial<ConfigV2>): boolean => _saveChangeDetailed(change).ok;

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
 * Get a specific setting: an `auth` key (`token`, `apiHeaders`, `lastUsername`) from the
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
const _recovered = (run: () => ImportOutcome, after?: (outcome: ImportOutcome) => void): boolean => {
    try {
        const outcome = run();
        if (outcome.ok) {
            state.importFailure = null;
            state.importPermanent = false;
            state.importSettled = false;
            state.lastBlockedLog = null;
            clearBlocked();
            after?.(outcome);
            return true;
        }
        logger
            .withCategory('settings')
            .error(`settings.json could not be imported (${outcome.reason}): ${outcome.detail}`);
        if (storage.readRaw() === null) _importFailed(outcome);
    } catch (error) {
        logger
            .withCategory('settings')
            .error(`settings.json could not be imported: ${errorMessage(error) ?? 'unknown error'}`);
    }
    return false;
};

/**
 * Import `settings.json` again after it failed (the file was fixed, or has loaded since): the operation that failed,
 * run as the explicit import it is whatever the marker says.
 *
 * @returns whether a configuration is stored now, and `adopted` when one was in place already: nothing was imported
 */
const retryImportDetailed = (): { ok: boolean; adopted?: true } => {
    let adopted = false;
    const ok = _recovered(
        () => {
            const outcome = retryLegacyImport(_importFailedLater);
            adopted = outcome.ok && outcome.kind === 'adopted';
            return outcome;
        },
        () => {
            // Either retry outcome puts a configuration in use, so the corrupt notice no longer applies.
            state.corruptBackupPath = null;
        },
    );
    return { ok, ...(adopted ? { adopted: true } : {}) };
};

/**
 * `retryImportDetailed`, for the caller that wants to know only whether a configuration is stored now.
 */
const retryImport = (): boolean => retryImportDetailed().ok;

/**
 * Begin with a default configuration instead of importing: `settings.json` is not imported, now or later unasked, and
 * is left as it is. A configuration that is there already is left as it is too.
 *
 * @returns whether the configuration was written, and `adopted` when one was in place already (another context saved
 *   it meanwhile): nothing was reset
 */
const startFreshDetailed = (): { ok: boolean; adopted?: true } => {
    let adopted = false;
    const ok = _recovered(() => {
        const outcome = startFreshConfig(_importFailedLater);
        adopted = outcome.ok && outcome.kind === 'adopted';
        return outcome;
    });
    return { ok, ...(adopted ? { adopted: true } : {}) };
};

/**
 * `startFreshDetailed`, for the caller that wants to know only whether the configuration was written.
 */
const startFresh = (): boolean => startFreshDetailed().ok;

/**
 * What the import left unresolved, or null when the configuration was not imported from a `settings.json` (an import
 * that failed is not an import). The report stays after it is acknowledged (About and data shows it).
 */
const getImportReport = (): ImportReport | null => {
    const { imported } = loadSettings();
    return imported && imported.failure === undefined
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
    onRecoveryChange as onSettingsRecoveryChange,
    onSaveDroppedChange as onSettingsSaveDroppedChange,
    isPrototypeKey,
    loadSettings,
    saveSettings,
    saveAppSettings,
    getSetting,
    setSetting,
    saveWindowBounds,
    getWindowBounds,
    retryImport,
    retryImportDetailed,
    startFresh,
    startFreshDetailed,
    getImportReport,
    acknowledgeImportReport,
};
