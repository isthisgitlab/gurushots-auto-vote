/**
 * Load/save mechanics of the configuration over the storage adapter: read +
 * validation + fill over the defaults, the one-time import of `settings.json`
 * when there is no configuration yet, whole-config save, `app` / `auth` key
 * accessors, window bounds, and the recovery states of a configuration that
 * cannot be used. Sole owner of the load-time re-entry guards; the persisted
 * bytes themselves (and Capacitor's write-behind cache) are owned by storage.ts.
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
import {
    appValueAllowed,
    authValueAllowed,
    dropInvalidValues,
    isAuthKey,
    isPrototypeKey,
    mergeWithDefaults,
} from './loadValidation';
import { importWhenAbsent, retryLegacyImport, startFreshConfig } from './legacyImport';
import type { ImportFailure, ImportOutcome } from './legacyImport';
import { updateImported } from './importedRecord';
import { flushPendingMarkerChanges, isImportMarked, markImportDone } from './importMarker';
import { isPlainObject } from '../plainObject';
import { oneLine } from '../format/logSafe';

import type { ConfigApp, ConfigAuthV2, ConfigV2, ImportRef } from '../types/config';
import type { WindowBounds, WindowType } from '../types/settings';

// The last file text found to hold only valid values, so an unchanged file is
// not re-validated on every read; and the last warning, so an invalid file
// warns once rather than on every read.
let lastCleanRaw: string | null = null;
let lastWarning: string | null = null;

/**
 * Why the stored configuration is not in use, or what a start found worth telling, for a renderer or the CLI to tell
 * the user. `code` is stable; `blocking` says whether saves are refused while it stands (a notice only informs):
 *   - settings-unreadable (blocking): `config.json` cannot be read, or cannot be set aside; `path` is the configuration
 *     file. Saves are refused until it can be read. Every read tries again.
 *   - settings-corrupt (notice): `config.json` is not a parseable configuration; it sits at `path`, set aside, and the
 *     defaults apply. Saves work, and the state stays this one for the process, however often it is read.
 *   - settings-import-failed: there is no `config.json` and the `settings.json` at `path` could not be imported.
 *     Blocking while the failure may pass by itself (the file held by another program, a read or a write that failed
 *     once): nothing was overwritten, and the import is tried again on Retry and at the next start, never on each
 *     setting read. Non-blocking (`detail` names the reason) when the file itself cannot be imported: the defaults
 *     were stored in its place, the marker says the import is done, and the file is left as it is.
 */
type SettingsRecovery = {
    code: 'settings-unreadable' | 'settings-corrupt' | 'settings-import-failed';
    path: string;
    blocking: boolean;
    detail?: string;
};

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

// Set while the stored settings cannot be used and must not be overwritten; cleared by the next load that gets through.
let blocked: (SettingsRecovery & { blocking: true }) | null = null;
// Where the last unparseable configuration went; kept for the rest of the process so a window opened later can still say so.
let corruptBackupPath: string | null = null;
// The unparseable text already moved aside, so a store that keeps handing it back (the Android service's) is not
// moved, and logged, again on every read.
let lastQuarantinedRaw: string | null = null;
// The import that failed, for as long as this process runs: reads answer the defaults and do not try it again (Retry
// and the next start do). `importPermanent` says the file itself cannot be imported: the defaults were then stored and
// the marker written, so saves work and the notice only tells what happened.
let importFailure: ImportFailure | null = null;
let importPermanent = false;
// Whether this process has found out that no import is due (the marker says it has run, or a set-aside configuration
// says it must not run unasked): a read of the defaults then takes no lock and looks at nothing.
let importSettled = false;
// Told when a read clears a block that a window was told of (a state that had to wait came through): what
// getSettingsRecovery answers changed without any write the window would hear of.
let recoveryListener: (() => void) | null = null;
// The last message a blocked state logged, so that a failure tried again on every read is said once.
let lastBlockedLog: string | null = null;

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
    const message = `Settings cannot be used (${code}); saving is refused so the stored settings are not overwritten: ${detail}`;
    if (message !== lastBlockedLog) logger.withCategory('settings').error(message);
    lastBlockedLog = message;
    return _loadDefaults('Loaded default settings with keys');
};

/**
 * Whether a failed import says the file itself cannot be imported (damaged, or the frozen pipeline cannot convert it),
 * rather than that it could not be tried just now (a lock another process held, a read that failed, a write that did
 * not land).
 */
const _importIsPermanent = (failure: ImportFailure): boolean =>
    failure.reason === 'corrupt' || failure.reason === 'migration-failed';

/**
 * Clears the block a read had put up (see _blockWrites), and tells the listener, so that a window that was showing the
 * notice for it asks again (and finds it gone).
 */
const _unblock = () => {
    if (blocked === null) return;
    blocked = null;
    // Not inside the read that cleared it: the listener reads the settings itself.
    if (recoveryListener) queueMicrotask(recoveryListener);
};

/**
 * Parse the stored text as a configuration object; the reason it is not one otherwise.
 */
const _parseSettings = (raw: string): { ok: true; value: object } | { ok: false; reason: string } => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // The parser's message can quote the text (the token among it): only the class of the failure is reported.
        return { ok: false, reason: 'it is not valid JSON' };
    }
    return isPlainObject(parsed) ? { ok: true, value: parsed } : { ok: false, reason: 'its root is not an object' };
};

/**
 * Configuration text that does not parse is set aside once (see storage.quarantineRaw), and the defaults apply, so the
 * next save writes a new file instead of mixing into a broken one. When it cannot be set aside it is left alone and
 * saves are refused. The block is lifted when the move is known to have landed — at once where it is made in one step,
 * when the queued one (the Android app window) has.
 */
const _recoverCorrupt = (raw: string, reason: string): ConfigV2 => {
    if (raw === lastQuarantinedRaw) {
        return _loadDefaults('Loaded default settings with keys');
    }
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
    logger
        .withCategory('settings')
        .error(`The stored settings were unusable (${reason}); they were moved to ${moved.path}`);
    if (moved.moved) {
        void moved.moved.then((made) => {
            if (made) {
                _unblock();
            } else {
                // The damaged text is still what is stored: the next read tries the move again.
                lastQuarantinedRaw = null;
                corruptBackupPath = null;
                _blockWrites(
                    'settings-unreadable',
                    'the unusable settings could not be set aside: Preferences refused the copy',
                    storage.location(),
                );
                // (A block set after a read answered is told on its own: _blockWrites does not announce.)
                if (recoveryListener) queueMicrotask(recoveryListener);
            }
        });
    } else {
        _unblock();
    }
    return _loadDefaults('Loaded default settings with keys');
};

/**
 * Fill and validate the parsed configuration.
 */
const _interpretSettings = (settingsData: string, parsed: object, stored: boolean): ConfigV2 => {
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
    // A configuration only shown by the cache until its queued write lands (an import in the Android window) is no proof
    // that anything works: the block stands until it is stored, and so does a failure the defaults were stored for —
    // they carry the failure in their import record, and the notice says so until the user acts or the process ends.
    if (stored) {
        _unblock();
        if (!importPermanent) {
            importFailure = null;
            lastBlockedLog = null;
        }
    }
    return config;
};

/**
 * The configuration a stored text holds: parsed, filled and validated, or defaults (the damaged text set aside).
 */
const _loadFromText = (settingsData: string, stored: boolean): ConfigV2 => {
    const parsed = _parseSettings(settingsData);
    if (!parsed.ok) return _recoverCorrupt(settingsData, parsed.reason);
    return _interpretSettings(settingsData, parsed.value, stored);
};

/**
 * What the persistence layer answers to a failed import: one the file itself cannot make up for (it is damaged, or the
 * frozen pipeline cannot convert it) is settled — the defaults are written with the failure in their import record and
 * the marker says the import is done, so no start tries it again; the file is left as it is, and the notice names the
 * reason. Where the defaults could not be written nothing is settled: the failure is treated as one that may pass, and
 * the next start tries the import again. The others block saves until the import is retried (Retry, or the next start).
 */
const _importFailed = (failure: ImportFailure): ConfigV2 => {
    importFailure = failure;
    if (!_importIsPermanent(failure)) {
        return _blockWrites(
            'settings-import-failed',
            `settings.json could not be imported (${failure.reason}): ${failure.detail}`,
            legacyStorage.location(),
        );
    }
    logger
        .withCategory('settings')
        .error(
            `settings.json could not be imported (${failure.reason}): ${failure.detail}; the default settings were stored in its place and the file is left as it is`,
        );
    const imported = {
        at: new Date().toISOString(),
        report: { refsBlocked: [] as ImportRef[] },
        acknowledged: true,
        failure: { reason: failure.reason, detail: failure.detail },
    };
    let written: ReturnType<typeof storage.write>;
    try {
        written = storage.write(JSON.stringify({ ...getDefaultSettings(), imported, version: 2 }, null, 2));
    } catch (error) {
        logger.withCategory('settings').error('The default settings could not be saved:', error);
        written = { ok: false };
    }
    if (!written.ok) {
        return _blockWrites(
            'settings-import-failed',
            `settings.json could not be imported (${failure.reason}): ${failure.detail}, and the default settings could not be saved`,
            legacyStorage.location(),
        );
    }
    // The marker is written once the defaults are stored: a write that did not land stored nothing, and the next
    // start tries the import again.
    if (written.landed) {
        void written.landed.then((outcome) => {
            if (outcome === 'failed') {
                logger
                    .withCategory('settings')
                    .error(
                        'The default settings could not be saved; the import of settings.json is tried again at the next start',
                    );
            } else {
                markImportDone();
            }
        });
    } else {
        markImportDone();
    }
    importPermanent = true;
    importSettled = true;
    lastBlockedLog = null;
    return _loadDefaults('Loaded default settings with keys');
};

/**
 * An import that looked done (its configuration shown by the cache) and then was not stored: the cache is back to what
 * is stored, so the next read finds no configuration, and until the import is retried nothing is saved. The window is
 * told — nothing else announces a block that comes after a read has answered.
 */
const _importFailedLater = (failure: ImportFailure): void => {
    _importFailed(failure);
    if (recoveryListener) queueMicrotask(recoveryListener);
};

/**
 * Whether what a read of the stored settings answers is what is stored (false in the Android window before it
 * hydrates, and in the service while no bridge answers).
 */
const _storesLoaded = (): boolean => storage.isLoaded() && legacyStorage.isLoaded();

/**
 * What a load finds when there is no configuration: the import of `settings.json` the first time (once, on Retry or at
 * a start after a failure), and defaults from then on.
 */
const _loadWithoutConfig = (): ConfigV2 => {
    // Stores not read yet (the Android window before it hydrates): nothing is wrong with the settings, they are just
    // not there to be read; the defaults answer, and the read is made again once they are.
    if (!_storesLoaded()) return getDefaultSettings();
    // A failure this process has seen stands until it is retried (Retry, or the next start): a read of a setting does
    // not try the import again.
    if (importFailure !== null) return _loadDefaults('Loaded default settings with keys');
    // Nothing to import: the marker says the import has run, or this process has settled it. Defaults, silently.
    // (A marker that cannot be looked at at all counts as done, as one that cannot be read does.)
    let marked: boolean;
    try {
        marked = isImportMarked();
    } catch (error) {
        logger
            .withCategory('settings')
            .error(
                `The import marker could not be looked at, so it counts as done: ${errorMessage(error) ?? 'unknown error'}`,
            );
        marked = true;
    }
    if (importSettled || marked) {
        importSettled = true;
        _unblock();
        return _loadDefaults('No settings file found, loaded default settings with keys');
    }
    const outcome = importWhenAbsent(_importFailedLater);
    if (!outcome.ok) return _importFailed(outcome);
    if (outcome.kind === 'imported' || outcome.kind === 'adopted') {
        return _loadFromText(outcome.text, outcome.landed === undefined);
    }
    // `fresh` (there is no settings.json) or `skipped` (a set-aside configuration says the import must not run
    // unasked): defaults, silently.
    importSettled = true;
    _unblock();
    return _loadDefaults('No settings file found, loaded default settings with keys');
};

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
    if (blocked) return blocked;
    if (corruptBackupPath !== null) return { code: 'settings-corrupt', path: corruptBackupPath, blocking: false };
    if (importFailure !== null && importPermanent) {
        return {
            code: 'settings-import-failed',
            path: legacyStorage.location(),
            blocking: false,
            detail: importFailure.reason,
        };
    }
    return null;
};

/**
 * Tells `listener` when a read clears the block it had put up (the one subscriber is replaced by the next).
 */
const onRecoveryChange = (listener: (() => void) | null): void => {
    recoveryListener = listener;
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
    if (blocked) {
        logger
            .withCategory('settings')
            .error(`Not saving settings: ${blocked.code}; the stored settings at ${blocked.path} are left as they are`);
        return { ok: false };
    }
    const written = storage.write(JSON.stringify({ ...config, version: 2 }, null, 2));
    // Changes of the marker that could not be made before are made again.
    if (written.ok) flushPendingMarkerChanges();
    return written;
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
            importFailure = null;
            importPermanent = false;
            importSettled = false;
            lastBlockedLog = null;
            blocked = null;
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
            // (A retry's outcomes are an import or an adoption: either way a configuration is in use, and replaces
            // the damaged one the notice was about.)
            corruptBackupPath = null;
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
