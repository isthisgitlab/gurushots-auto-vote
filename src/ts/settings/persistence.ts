/**
 * Load/save mechanics of the configuration over the storage adapter: read +
 * validation + fill over the defaults, the import of `settings.json` when there
 * is no configuration yet (and the restoring of a lost one from it), whole-config
 * save followed by the mirror that keeps `settings.json` current, `app` / `auth`
 * key accessors, window bounds, and the recovery states of a configuration that
 * cannot be used. Sole owner of the load-time re-entry guards; the persisted
 * bytes themselves (and Capacitor's write-behind cache) are owned by storage.ts.
 */

import * as logger from '../logger';
import * as runtime from '../runtime';
import { schemaEntry } from './schema';
import { getSaveDroppedCause, isSaveDropped, legacyStorage, onSaveDroppedChange, storage } from './storage';
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
import { importWhenAbsent, reimportLegacyFile, retryLegacyImport, startFreshConfig } from './legacyImport';
import type { ImportFailure, ImportOutcome } from './legacyImport';
import { updateImported } from './importedRecord';
import { mirrorSettings, setAsideLegacy } from './formatOneMirror';
import { forgetUnimportableCopy, keptUnimportableCopy, rememberUnimportableCopy } from './importMarker';
import type { SignInAdoption } from './formatOneMirror';
import { onTitlePinsChange } from './titlePins';
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
 *   - settings-restored (notice): `config.json` was not a parseable configuration; it sits at `path`, set aside, and the
 *     configuration was restored from `settings.json`, which the app keeps current. Saves work.
 *   - settings-corrupt (notice): `config.json` is not a parseable configuration; it sits at `path`, set aside, and there
 *     was no usable `settings.json` to restore from (none, or one that does not import). Defaults apply and saves work,
 *     and the state stays this one for the process, however often it is read. It is never replaced by an import
 *     unasked (`reimportFromV1` is the explicit way). A `settings.json` that does not import is set aside, as
 *     `settings.json.unimportable-<time>`, before the first save mirrors over it: `settingsSetAside` is where it went
 *     (a path on a desktop, the preference key where there is no file), present from then on.
 *   - settings-unreadable (blocking): `config.json` cannot be read, or cannot be set aside; `path` is the configuration
 *     file. Saves are refused until it can be read.
 *   - settings-import-failed (blocking): there is no `config.json` and the `settings.json` at `path` could not be
 *     imported (it cannot be read, is damaged, cannot be converted, or is not loaded yet). Nothing is written and
 *     saves are refused until the import is retried (`retryImport`), a fresh configuration is started (`startFresh`,
 *     which keeps the file as `settings.json.original`) or the file is fixed.
 */
type SettingsRecovery = {
    code: 'settings-restored' | 'settings-corrupt' | 'settings-unreadable' | 'settings-import-failed';
    path: string;
    blocking: boolean;
    settingsSetAside?: string;
};

/**
 * A change the app window made to the settings that could not be saved (Android: the background service kept changing
 * the settings, or the save was refused), so the setting shows its stored value again. Not a recovery of the stored
 * settings, which are in use; `path` is where they live and `cause` why the save was given up. Cleared by the next save
 * that lands.
 */
/** What the import left unresolved: `refsBlocked` holds a reference as the user knows its parts, or the text an earlier build stored. */
type ImportReport = { at: string; refsBlocked: Array<string | ImportRef>; acknowledged: boolean };

type SettingsSaveDropped = { code: 'settings-save-dropped'; path: string; cause: SaveDroppedCause };

// Set while the stored settings cannot be used and must not be overwritten; cleared by the next load that gets through.
let blocked: (SettingsRecovery & { blocking: true }) | null = null;
// Where the last unparseable configuration went; kept for the rest of the process so a window opened later can still say so.
let corruptBackupPath: string | null = null;
// The unparseable text already moved aside, so a store that keeps handing it back (the Android service's) is not
// moved, and logged, again on every read.
let lastQuarantinedRaw: string | null = null;
// Whether the damaged configuration set aside at `corruptBackupPath` was restored from `settings.json`.
let restoredFromMirror = false;
// The import that failed for a reason that will not pass by itself: not tried again until `retryImport`, so a
// damaged `settings.json` is not read and converted on every read of a setting. (A 'not-loaded' failure is tried again.)
let importFailure: ImportFailure | null = null;
// Whether this process has found out that no import is due (a set-aside configuration says it must not run unasked,
// or there is no settings.json to restore from): a read of the defaults then takes no lock and looks at nothing.
let importSettled = false;
// Whether this process has made sure `settings.json` is the mirror of the configuration (see _verifyMirror).
let mirrorVerified = false;
// Whether the `settings.json` the configuration could not be restored from is one the import failed on (it is damaged,
// cannot be converted or read), so the mirror must set it aside before it writes over it: it is what the notice tells
// the user to look at.
let legacyUnusable = false;
// Where the unusable `settings.json` was set aside (a path; the preference key where there is no file), once it was
// (in the Android window, once the queued write that does it has landed).
let legacySetAside: string | null = null;
// Whether a sign-out was saved (a token that was stored and is cleared) that the copies kept of the settings files have
// not been cleared of yet: told to the mirror once (see MirrorHooks.takeSignOut). A configuration that merely holds no
// token, as the defaults of a damaged one do, is not a sign-out.
let signOutPending = false;
// Whether the mirror adopted a sign-in an older build changed while _verifyMirror's own mirror ran, which makes the load
// that is answering out of date (set by _adoptSignIn, read and cleared by _verifyMirror; where the mirror is queued
// the answer is never out of date this way, the next read has it).
let signInTakenBack = false;

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
    } catch {
        // The parser's message can quote the text (the token among it): only the class of the failure is reported.
        return { ok: false, reason: 'it is not valid JSON' };
    }
    return isPlainObject(parsed) ? { ok: true, value: parsed } : { ok: false, reason: 'its root is not an object' };
};

/**
 * Configuration text that does not parse is set aside once (see storage.quarantineRaw), and the configuration is restored
 * from `settings.json`, the mirror of it. Without a usable one defaults apply, so the next save writes a new file instead
 * of mixing into a broken one, and the set-aside copy makes an import stand down: it is never replaced by an import
 * unasked. When it cannot be set aside it is left alone and saves are refused.
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
    restoredFromMirror = false;
    // A new episode: the copy an earlier one set aside is not this one's.
    legacySetAside = null;
    forgetUnimportableCopy();
    blocked = null;
    logger
        .withCategory('settings')
        .error(`The stored settings were unusable (${reason}); they were moved to ${moved.path}`);
    const restored = _restoreFromMirror();
    if (restored) {
        restoredFromMirror = true;
        return restored;
    }
    logger.withCategory('settings').warning('There is no usable settings.json to restore them from; defaults apply');
    return _loadDefaults('Loaded default settings with keys');
};

/**
 * The configuration `settings.json` makes, once it is stored (the damaged one was set aside), or null when there is
 * none to make: no usable `settings.json`, or the import is not due.
 */
const _restoreFromMirror = (): ConfigV2 | null => {
    const outcome = importWhenAbsent(_importFailedLater);
    if (!outcome.ok) {
        // Defaults are in use and saves work. That is settled for the process (as a failed import is, see
        // _loadWithoutConfig): a later read answers the same, instead of turning into a blocked import. The
        // settings.json that could not be restored from is what the notice tells the user to look at, so the first
        // save does not mirror over it (see _mirror).
        if (outcome.reason !== 'not-loaded') {
            importFailure = outcome;
            legacyUnusable = true;
        }
        return null;
    }
    if (outcome.kind !== 'recovered' && outcome.kind !== 'adopted') return null;
    const parsed = _parseSettings(outcome.text);
    return parsed.ok ? _interpretSettings(outcome.text, parsed.value) : null;
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
 * A failed import blocks saves, with `settings.json` as the place to look at. One that will not pass by itself
 * is remembered, so the next read does not try it again.
 */
const _importFailed = (failure: ImportFailure): ConfigV2 => {
    if (failure.reason !== 'not-loaded') importFailure = failure;
    return _blockWrites(
        'settings-import-failed',
        `settings.json could not be imported (${failure.reason}): ${failure.detail}`,
        legacyStorage.location(),
    );
};

/**
 * An import that looked done (its configuration shown by the cache) and then was not stored: where the save is only
 * queued, the answer comes later. The cache is back to what is stored, so the next read finds no configuration, and
 * until the import is retried nothing is saved over what `settings.json` still holds.
 */
const _importFailedLater = (failure: ImportFailure): void => {
    _importFailed(failure);
};

/**
 * What a load finds when there is no configuration: the import of `settings.json` the first time, the configuration
 * restored from it once it has been imported (it is current), defaults when there is nothing to restore from.
 */
const _loadWithoutConfig = (): ConfigV2 => {
    if (importFailure) return _loadDefaults('Loaded default settings with keys');
    if (importSettled) {
        blocked = null;
        return _loadDefaults('No settings file found, loaded default settings with keys');
    }
    const outcome = importWhenAbsent(_importFailedLater);
    // Stores not read yet (the Android window before it hydrates): nothing is wrong with the settings, they are just
    // not there to be read; the defaults answer, and the read is made again once they are.
    if (!outcome.ok && outcome.reason === 'not-loaded') return getDefaultSettings();
    if (!outcome.ok) return _importFailed(outcome);
    if (outcome.kind === 'recovered') {
        // A damaged configuration set aside earlier whose restore had to wait (the stores were not read yet) is restored now.
        if (corruptBackupPath !== null) restoredFromMirror = true;
        logger
            .withCategory('settings')
            .warning(
                `config.json was ${corruptBackupPath === null ? 'missing' : 'damaged'}; the configuration was restored from settings.json`,
            );
    }
    if (outcome.kind === 'imported' || outcome.kind === 'recovered' || outcome.kind === 'adopted') {
        return _loadFromText(outcome.text);
    }
    importSettled = true;
    blocked = null;
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
    const config = settingsData ? _loadFromText(settingsData) : _loadWithoutConfig();
    return blocked === null ? _verifyMirror(config) : config;
};

/**
 * Why the stored settings are not in use, or null: see SettingsRecovery.
 */
const getSettingsRecovery = (): SettingsRecovery | null => {
    if (blocked) return blocked;
    if (!corruptBackupPath) return null;
    return {
        code: restoredFromMirror ? 'settings-restored' : 'settings-corrupt',
        path: corruptBackupPath,
        blocking: false,
        ...(!restoredFromMirror && legacySetAside !== null ? { settingsSetAside: legacySetAside } : {}),
    };
};

/**
 * The change the app window made last that could not be saved, or null: see SettingsSaveDropped.
 */
const getSettingsSaveDropped = (): SettingsSaveDropped | null =>
    isSaveDropped() ? { code: 'settings-save-dropped', path: storage.location(), cause: getSaveDroppedCause() } : null;

/**
 * Sets the `settings.json` that does not import aside, once a configuration is stored for the mirror to write over it
 * (as `settings.json.unimportable-<time>`: the file the notice told the user to fix is never overwritten). The
 * background service cannot (it has no files and no keys to list): the app window does it, and the service writes
 * nothing over the file meanwhile.
 *
 * @returns whether the mirror may go on: false when it could not be set aside, and nothing is written over it
 */
const _setAsideUnusableLegacy = (): boolean => {
    if (!storage.peekRaw()) return true;
    if (runtime.isHeadlessService()) {
        logger
            .withCategory('settings')
            .debug('settings.json does not import and only the app window can set it aside, so it is left as it is');
        return false;
    }
    const aside = setAsideLegacy({ asCopy: true });
    if (!aside.ok) {
        logger
            .withCategory('settings')
            .warning(`settings.json could not be set aside, so it is not overwritten: ${aside.error}`);
        return false;
    }
    legacyUnusable = false;
    // Where the write is only queued, the notice says where it went once it has (see _mirror).
    if (!aside.queued) {
        legacySetAside = aside.kept ?? null;
        // Remembered beside the import marker too, so that a re-import in another process, or after a restart, finds it.
        if (legacySetAside !== null) rememberUnimportableCopy(legacySetAside);
    }
    return true;
};

/**
 * What the mirror does when `settings.json` holds a sign-in this build did not write (a logout or an account switch an
 * older build made while this one ran, or before it started): the sign-in is the user's decision, not something an older
 * build's schema can get wrong, so it is saved into the configuration (which the mirror then writes from), and nothing
 * else in `settings.json` is ever taken back. Not while the configuration in use is the defaults of a damaged one.
 */
const _adoptSignIn = (found: Partial<ConfigAuthV2>): SignInAdoption => {
    if (corruptBackupPath !== null && !restoredFromMirror) return { outcome: 'declined' };
    const saved = _saveChangeDetailed((current) => ({ auth: { ...current.auth, ...found } }), false);
    if (!saved.ok) return { outcome: 'failed' };
    signInTakenBack = true;
    // Said once it is stored: where the write is only queued, it may yet fail.
    const say = () =>
        logger.withCategory('settings').info('The sign-in in settings.json was changed by an older build; it is kept');
    if (saved.landed) {
        void saved.landed.then((outcome) => {
            if (outcome !== 'failed') say();
        });
    } else say();
    return { outcome: 'adopted', landed: saved.landed };
};

/**
 * Brings `settings.json` up to date with the configuration, unless the stored settings are not usable: nothing is
 * mirrored from them (and over what they leave in `settings.json`). A `settings.json` that does not import is set aside
 * first.
 */
const _mirror = (landed?: Promise<QueuedWriteOutcome | undefined>) => {
    if (blocked || (legacyUnusable && !_setAsideUnusableLegacy())) return;
    mirrorSettings(landed, {
        adoptSignIn: _adoptSignIn,
        onSetAside: (key) => {
            legacySetAside = key;
            rememberUnimportableCopy(key);
        },
        takeSignOut: () => {
            const pending = signOutPending;
            signOutPending = false;
            return pending;
        },
    });
};

/**
 * Whether what a read of the stored settings answers is what is stored (false in the Android window before it
 * hydrates, and in the service while no bridge answers).
 */
const _storesLoaded = (): boolean => storage.isLoaded() && legacyStorage.isLoaded();

/**
 * Once per process (and again after a recovery action), the first time the stored settings are usable: `settings.json`
 * is made the mirror of the configuration when it is not (a start after an older build wrote it, or after a build that
 * did not keep it current), so no start leaves an older build on stale settings; a sign-in an older build changed in it
 * is adopted first (see _adoptSignIn, which the mirror asks at every write). Where the stores are not read yet (the
 * Android window before it hydrates) it looks again on a later call.
 *
 * @returns the configuration that was loaded, or the one stored after a sign-in was adopted
 */
const _verifyMirror = (config: ConfigV2): ConfigV2 => {
    if (mirrorVerified || !_storesLoaded()) return config;
    mirrorVerified = true;
    signInTakenBack = false;
    _mirror(storage.flush().then(() => undefined));
    if (!signInTakenBack) return config;
    signInTakenBack = false;
    return loadSettings();
};

// A change of the title pins is a change of what settings.json holds.
onTitlePinsChange(() => _mirror());

/** What saving the configuration came to: whether it was written, and where the write is only queued (the Android app window) how it ends. */
type Persisted = { ok: boolean; landed?: Promise<QueuedWriteOutcome> };

/**
 * Write the whole configuration, unless the stored settings are not usable (writing then would erase them); then the
 * mirror, once the write has landed (unless the caller is the mirror itself).
 */
const _persist = (config: ConfigV2, withMirror: boolean): Persisted => {
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
    if (written.ok && withMirror) _mirror(written.landed);
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
 * member, or a value its schema entry or range rejects, refuses the whole save. `withMirror` false is for the mirror's
 * own call, which writes `settings.json` itself once this is stored.
 */
const _saveChangeDetailed = (change: (current: ConfigV2) => Partial<ConfigV2>, withMirror: boolean): Persisted => {
    try {
        const current = loadSettings();
        const changed = change(current);
        const refused = _refusedKey(changed);
        if (refused !== undefined) {
            logger.withCategory('settings').error(`Invalid setting not saved: ${oneLine(refused)}`, null);
            return { ok: false };
        }
        const next = { ...current, ...changed };
        // A token that was stored and is cleared is a sign-out, which the copies kept of the settings files are cleared of.
        const signingOut = current.auth.token !== '' && next.auth.token === '';
        if (signingOut) signOutPending = true;
        // Write via storage adapter (sync fs on Electron/CLI; cache + async write-behind on Capacitor)
        const saved = _persist(next, withMirror);
        if (signingOut && !saved.ok) signOutPending = false;
        return saved;
    } catch (error) {
        logger.withCategory('settings').error('Error saving settings:', error);
        return { ok: false };
    }
};

const _saveChange = (change: (current: ConfigV2) => Partial<ConfigV2>): boolean => _saveChangeDetailed(change, true).ok;

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
            // The episode of a damaged configuration is over (or none was): no copy is the one to fix any more.
            forgetUnimportableCopy();
            importFailure = null;
            importSettled = false;
            mirrorVerified = false;
            legacyUnusable = false;
            legacySetAside = null;
            blocked = null;
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
 * run as the explicit import it is whatever the marker and a set-aside configuration say.
 *
 * @returns whether a configuration is stored now
 */
const retryImport = (): boolean => _recovered(() => retryLegacyImport(_importFailedLater));

/**
 * Begin with a default configuration instead of importing: `settings.json` is kept (as `settings.json.original`, or as
 * `settings.json.unimportable-<time>` when that is taken) before the mirror writes over it, and is not imported later
 * unasked.
 *
 * @returns whether the configuration was written, and where `settings.json` was kept (`keptAt`: null when there was none
 *   to keep); in the Android window, where the copy is written later, `landed` says under which key it was
 */
const startFreshDetailed = (): { ok: boolean; keptAt: string | null; landed?: Promise<string | null> } => {
    let keptAt: string | null = null;
    let landed: Promise<string | null> | undefined;
    const ok = _recovered(() =>
        startFreshConfig(_importFailedLater, (kept) => {
            if (typeof kept === 'string') keptAt = kept;
            else landed = kept;
        }),
    );
    return { ok, keptAt, ...(landed === undefined ? {} : { landed }) };
};

/**
 * `startFreshDetailed`, for the caller that wants to know only whether the configuration was written.
 */
const startFresh = (): boolean => startFreshDetailed().ok;

/**
 * The file to fix, when settings.json did not import: the copy kept of it in the last episode of a damaged configuration,
 * once there is one: this process's, or the one the marker remembers (another process, or an earlier run of the app, set
 * it aside). Where there are no files the key of one is not a path to read, and a copy that is gone is no longer the one
 * to fix. Null without one: settings.json itself is imported.
 */
const _copyToFix = (): string | null => {
    const copy = runtime.isCapacitor() ? null : (legacySetAside ?? keptUnimportableCopy());
    if (copy === null || legacyStorage.hasCopy(copy)) return copy;
    forgetUnimportableCopy();
    legacySetAside = null;
    return null;
};

/**
 * Import `settings.json` again on request: the configuration in use is set aside the way a damaged one is
 * (`config.json.corrupt-<time>`) and the import is saved in its place, the sign-in included. `settings.json` is the
 * mirror of what was in use, unless an older build changed it since.
 *
 * @returns whether the import was saved, and where the configuration that was in use was set aside (null: none was)
 */
const reimportFromV1Detailed = (): { ok: boolean; setAside: string | null } => {
    let setAside: string | null = null;
    const ok = _recovered(() =>
        reimportLegacyFile(
            _importFailedLater,
            (path) => {
                setAside = path;
            },
            _copyToFix(),
        ),
    );
    // The damaged configuration the notice was about is not the one in use any more.
    if (ok) {
        corruptBackupPath = null;
        restoredFromMirror = false;
        legacySetAside = null;
    }
    return { ok, setAside };
};

/**
 * `reimportFromV1Detailed`, for the caller that wants to know only whether the import was saved.
 */
const reimportFromV1 = (): boolean => reimportFromV1Detailed().ok;

/**
 * What the import left unresolved, or null when the configuration was not imported from a `settings.json`. The
 * report stays after it is acknowledged (About and data shows it).
 */
const getImportReport = (): ImportReport | null => {
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
    startFreshDetailed,
    reimportFromV1,
    reimportFromV1Detailed,
    getImportReport,
    acknowledgeImportReport,
};
