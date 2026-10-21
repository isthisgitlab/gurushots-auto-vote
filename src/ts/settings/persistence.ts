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
import { importWhenAbsent, reimportLegacyFile, retryLegacyImport, startFreshConfig } from './legacyImport';
import type { ImportFailure, ImportOutcome } from './legacyImport';
import { updateImported } from './importedRecord';
import {
    finishDeferredScrub,
    mirrorSettings,
    scrubCopiesAfterSignOut,
    scrubOldCopies,
    setAsideLegacy,
} from './formatOneMirror';
import {
    clearLegacyAsideOwed,
    clearSignOutOwed,
    configSource,
    forgetUnimportableCopy,
    keptUnimportableCopy,
    legacyAsideOwedStored,
    markLegacyAsideOwed,
    flushPendingMarkerChanges,
    markSignOutOwed,
    mirroredSignIns,
    rememberUnimportableCopy,
    signOutOwedStored,
} from './importMarker';
import type { OwedSignOut } from './importMarker';
import { signInHeldIn, tokenInSignIns } from './signInFingerprint';
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
 *     (a path on a desktop, the preference key where there is no file), present from then on. `reimportSource` (where
 *     there are files) is the file a Re-import would read: that copy once there is one, else settings.json.
 *   - settings-unreadable (blocking): `config.json` cannot be read, or cannot be set aside; `path` is the configuration
 *     file. Saves are refused until it can be read.
 *   - settings-import-failed (blocking): there is no `config.json` and the `settings.json` at `path` could not be
 *     imported (it cannot be read, is damaged, or cannot be converted). Nothing is written and saves are refused until
 *     the import is retried (`retryImport`), a fresh configuration is started (`startFresh`, which keeps the file as
 *     `settings.json.original`) or the file is fixed.
 *   - settings-import-retrying (blocking): the same, but for a reason that may pass by itself (the file is held by
 *     another program, a read or a write failed once): the app tries again by itself, and nothing was overwritten.
 *     `damagedAt` (when the configuration was damaged and set aside) is where its damaged copy went.
 *   `logoutLost: true` (any code): a logout was not recorded and holds only while the app stays open.
 */
type SettingsRecovery = {
    code:
        | 'settings-restored'
        | 'settings-corrupt'
        | 'settings-unreadable'
        | 'settings-import-failed'
        | 'settings-import-retrying';
    path: string;
    blocking: boolean;
    settingsSetAside?: string;
    reimportSource?: string;
    damagedAt?: string;
    logoutLost?: true;
};

/** What the import left unresolved: `refsBlocked` holds a reference as the user knows its parts, or the text an earlier build stored. */
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
// Whether the damaged configuration set aside at `corruptBackupPath` was restored from `settings.json`.
let restoredFromMirror = false;
// Whether the restore of the damaged configuration could not be tried (or did not land) and is tried again by the next
// read: a `settings.json` found unusable then settles the episode, as it would have at the first try.
let restoreRetryPending = false;
// The numbers import attempts are told apart by (each one prepared has its own, whether or not it starts), and the
// number of the attempt that started last: only it hears of how its queued write ends. An earlier one that fails after
// a later one started says nothing of the state now.
let importIds = 0;
let latestImport = 0;
// Whether the restore of the damaged configuration has been issued and its queued write (the Android app window) has
// neither landed nor failed: the settings in use are shown by the cache, and the notice has nothing to say yet.
let restoreInFlight = false;
// The import that failed for a reason that will not pass by itself: not tried again until `retryImport`, so a
// damaged `settings.json` is not read and converted on every read of a setting. (A 'not-loaded' failure is tried again.)
let importFailure: ImportFailure | null = null;
// When (ms since the epoch) a failure that may pass by itself (a lock another process held, a file busy for a moment)
// may be tried again: a read before it answers the same, without taking the import lock again.
let retryNotBefore = 0;
// The wait grows with each failure in a row (a disk that stays full, a file that stays locked is not asked again every
// second), up to a few minutes, and is short again once a read gets through.
let transientFailures = 0;
const TRANSIENT_RETRY_MS = 1000;
const TRANSIENT_RETRY_MAX_MS = 5 * 60 * 1000;
// A restore that keeps failing for a reason that should pass for this long (the wait is at its ceiling by then) is
// given up as one that will not: settings.json is taken for unusable, as a damaged one is. Counted in time, not in tries:
// a user pressing Retry does not bring it nearer.
const TRANSIENT_GIVE_UP_MS = 510 * 1000;
let firstTransientAt = 0;
// The same for the move of a damaged configuration the Android window could not make: the wait before it is tried again.
let moveFailures = 0;
let moveRetryNotBefore = 0;
// The read that tries a failed import (or move) again once its wait is over, by itself, while a window listens (else
// the next read does).
let retryTimer: ReturnType<typeof setTimeout> | null = null;
// Whether the marker is to be looked at for a sign-out owed to a restore (at the start of the process, and when a restore
// or an import lands): see _applyOwedSignOut.
let owedCheck = true;
// The sign-out owed to a restore that this process made, kept in memory too: it holds in this process even when its record
// could not be stored (and is lost if the process ends first, which has been said).
let owedMemory: OwedSignOut | null = null;
// Whether the user is to be told that a logout was not recorded (see _signOutLost).
let signOutLostNotice = false;
// How long the marker's copy of an unimportable settings.json stays the one a re-import reads.
const REMEMBERED_COPY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
// Told when a read clears a block that a window was told of (a restore that had to wait came through): what
// getSettingsRecovery answers changed without any write the window would hear of.
let recoveryListener: (() => void) | null = null;
// The last message a blocked state logged, so that a failure tried again on every read is said once.
let lastBlockedLog: string | null = null;
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
    code: 'settings-unreadable' | 'settings-import-failed' | 'settings-import-retrying',
    detail: string,
    path: string,
    damagedAt?: string,
): ConfigV2 => {
    blocked = { code, path, blocking: true, ...(damagedAt === undefined ? {} : { damagedAt }) };
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
const _fileIsUnusable = (failure: ImportFailure): boolean =>
    failure.reason === 'corrupt' || failure.reason === 'migration-failed' || failure.reason === 'inaccessible';

/**
 * Clears the block a read had put up (see _blockWrites), and tells the listener, so that a window that was showing the
 * notice for it asks again (and finds it gone, or the restore it came to).
 */
const _unblock = () => {
    if (blocked === null) return;
    blocked = null;
    // Not inside the read that cleared it: the listener reads the settings itself.
    if (recoveryListener) queueMicrotask(recoveryListener);
};

const _cancelRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
};

/**
 * Has the read that tries again made once `delayMs` is over (only while a window listens for what the read finds: it is
 * what tells the user, and the next read of the settings does the same without it).
 */
const _scheduleRetry = (delayMs: number) => {
    if (recoveryListener === null) return;
    _cancelRetry();
    retryTimer = setTimeout(
        () => {
            retryTimer = null;
            // (A timer's throw would end the main process.)
            try {
                loadSettings();
            } catch (error) {
                logger
                    .withCategory('settings')
                    .error(
                        `The scheduled retry of the settings import failed: ${errorMessage(error) ?? 'unknown error'}`,
                    );
            }
        },
        Math.max(delayMs, 0) + 50,
    );
    // A pending retry never keeps a process alive.
    (retryTimer as { unref?: () => void }).unref?.();
};

/**
 * The state of a failed import that may pass by itself, once a read or a restore finds the configuration stored.
 */
const _clearTransientFailure = () => {
    _cancelRetry();
    _unblock();
    importFailure = null;
    transientFailures = 0;
    lastBlockedLog = null;
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
 * The damaged configuration could not be set aside after all (the move was queued, in the Android app window): it is
 * still what is stored, so no restore of it is one, and nothing is saved over it, as when a move fails at once. The
 * restore that was queued behind it is given up (it would only be declined over the damaged text), and the window is
 * told.
 */
const _notMoved = (reason: string): void => {
    latestImport = ++importIds;
    restoreInFlight = false;
    restoreRetryPending = false;
    restoredFromMirror = false;
    corruptBackupPath = null;
    // The move is tried again by a later read, after a wait that doubles (the damaged text is still what is stored).
    const wait = Math.min(TRANSIENT_RETRY_MS * 2 ** moveFailures, TRANSIENT_RETRY_MAX_MS);
    moveRetryNotBefore = Date.now() + wait;
    moveFailures++;
    lastQuarantinedRaw = null;
    _blockWrites(
        'settings-unreadable',
        `the unusable settings (${reason}) could not be set aside: Preferences refused the copy`,
        storage.location(),
    );
    _scheduleRetry(wait);
    if (recoveryListener) queueMicrotask(recoveryListener);
};

const NO_USABLE_MIRROR = 'There is no usable settings.json to restore them from; defaults apply';

/**
 * Configuration text that does not parse is set aside once (see storage.quarantineRaw), and the configuration is restored
 * from `settings.json`, the mirror of it. Without a usable one defaults apply, so the next save writes a new file instead
 * of mixing into a broken one, and the set-aside copy makes an import stand down: it is never replaced by an import
 * unasked. When it cannot be set aside it is left alone and saves are refused.
 */
const _recoverCorrupt = (raw: string, reason: string): ConfigV2 => {
    if (raw === lastQuarantinedRaw || Date.now() < moveRetryNotBefore) {
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
    restoredFromMirror = false;
    restoreRetryPending = false;
    // Where the move is only queued, it may yet fail (see _notMoved).
    if (moved.moved) {
        void moved.moved.then((made) => {
            if (made) moveFailures = 0;
            else _notMoved(reason);
        });
    }
    // A new episode: the copy an earlier one set aside is not this one's.
    legacySetAside = null;
    forgetUnimportableCopy();
    _unblock();
    logger
        .withCategory('settings')
        .error(`The stored settings were unusable (${reason}); they were moved to ${moved.path}`);
    const restored = _restoreFromMirror();
    if (restored && 'ok' in restored) {
        restoreRetryPending = true;
        return _importFailed(restored);
    }
    if (restored) return restored;
    logger.withCategory('settings').warning(NO_USABLE_MIRROR);
    return _loadDefaults('Loaded default settings with keys');
};

/**
 * The configuration `settings.json` makes, once it is stored (the damaged one was set aside), or null when there is
 * none to make: no usable `settings.json`, or the import is not due.
 */
const _restoreFromMirror = (): ConfigV2 | ImportFailure | null => {
    const { outcome, mine } = _runImport(importWhenAbsent);
    if (!outcome.ok) {
        // A failure that may pass by itself (a lock another process held, a file busy for a moment) says nothing of
        // settings.json: it is not settled, saves are refused meanwhile, and the next read tries again.
        if (outcome.reason !== 'not-loaded' && !_fileIsUnusable(outcome)) return outcome;
        // The file itself cannot be imported. Defaults are in use and saves work. That is settled for the process (as a
        // failed import is, see _loadWithoutConfig): a later read answers the same, instead of turning into a blocked
        // import. The settings.json that could not be restored from is what the notice tells the user to look at, so
        // the first save does not mirror over it (see _mirror).
        if (outcome.reason !== 'not-loaded') {
            importFailure = outcome;
            legacyUnusable = true;
        }
        return null;
    }
    if (outcome.kind !== 'recovered' && outcome.kind !== 'adopted') return null;
    const parsed = _parseSettings(outcome.text);
    if (!parsed.ok) return null;
    const restored = _interpretSettings(outcome.text, parsed.value, outcome.landed === undefined);
    // (The defaults of another process's Start fresh, found there, are not a restore.)
    if (outcome.kind === 'recovered' || configSource() !== 'fresh') _awaitRestore(outcome.landed, mine, restored);
    return restored;
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
    // that anything works: the block, the failure and the wait before the next try stand until it is stored.
    if (stored) _clearTransientFailure();
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
 * settings.json is taken for unusable: a failure that will not pass, or one that kept failing (see TRANSIENT_GIVE_UP_MS). A
 * restore settles as it does when `settings.json` is found damaged at the first try: defaults, saves allowed, the file
 * set aside before the first save mirrors over it. Any late failure of the attempts before says nothing more.
 */
const _settleUnusable = (failure: ImportFailure): ConfigV2 => {
    importFailure = failure;
    legacyUnusable = true;
    restoreRetryPending = false;
    restoreInFlight = false;
    latestImport = ++importIds;
    lastBlockedLog = null;
    owedCheck = true;
    _cancelRetry();
    _unblock();
    logger.withCategory('settings').warning(NO_USABLE_MIRROR);
    return _loadDefaults('Loaded default settings with keys');
};

/**
 * A failed import blocks saves, with `settings.json` as the place to look at. One that will not pass by itself
 * is remembered, so the next read does not try it again; the others are tried again after a wait (and given up
 * after many, where a damaged configuration waits to be restored from it).
 */
const _importFailed = (failure: ImportFailure): ConfigV2 => {
    const transient = !_fileIsUnusable(failure);
    // Only a settings.json that cannot be imported at all stays failed; the others are tried again (see retryNotBefore).
    if (!transient) importFailure = failure;
    else if (
        corruptBackupPath !== null &&
        transientFailures > 0 &&
        Date.now() - firstTransientAt >= TRANSIENT_GIVE_UP_MS
    ) {
        return _settleUnusable(failure);
    } else {
        if (transientFailures === 0) firstTransientAt = Date.now();
        const wait = Math.min(TRANSIENT_RETRY_MS * 2 ** transientFailures, TRANSIENT_RETRY_MAX_MS);
        retryNotBefore = Date.now() + wait;
        transientFailures++;
        _scheduleRetry(wait);
    }
    return _blockWrites(
        transient ? 'settings-import-retrying' : 'settings-import-failed',
        `settings.json could not be imported (${failure.reason}): ${failure.detail}`,
        legacyStorage.location(),
        transient && corruptBackupPath !== null ? corruptBackupPath : undefined,
    );
};

/**
 * An import that looked done (its configuration shown by the cache) and then was not stored: where the save is only
 * queued, the answer comes later. The cache is back to what is stored, so the next read finds no configuration, and
 * until the import is retried nothing is saved over what `settings.json` still holds.
 */
const _importFailedLater = (failure: ImportFailure): void => {
    // A restore that did not land restored nothing: it is tried again (see restoreRetryPending). An import that is not
    // a restore (Start fresh, a re-import) leaves the restore's state as it is.
    if (restoreInFlight) {
        restoreInFlight = false;
        restoreRetryPending = true;
    }
    const wasBlocked = blocked !== null;
    _importFailed(failure);
    // Nothing else tells the window of a block that comes after its save was given up (a dropped save reports once): the
    // notice asks again, and shows it.
    if (!wasBlocked && recoveryListener) queueMicrotask(recoveryListener);
};

/**
 * Prepares an import attempt: the number that will tell it from the ones before it, and what it does when its write
 * does not land (nothing, when a later attempt has started since). The attempt takes the place of the ones before it
 * only once it has `started`: an attempt that failed at once (a file that cannot be converted, a lock that is held),
 * or found the configuration there already, put no write down and leaves an earlier attempt's alone.
 */
const _beginImport = (): {
    mine: number;
    onLate: (failure: ImportFailure) => void;
    started: (outcome: ImportOutcome) => void;
} => {
    const mine = ++importIds;
    return {
        mine,
        onLate: (failure) => {
            if (mine === latestImport) _importFailedLater(failure);
        },
        started: (outcome) => {
            if (!outcome.ok || outcome.kind === 'adopted' || outcome.kind === 'skipped') return;
            latestImport = mine;
            // A restore still in flight when another attempt starts did not come through (the cache only shows the
            // attempt again when it was not stored): this one is its retry.
            if (restoreInFlight) restoreRetryPending = true;
            restoreInFlight = false;
        },
    };
};

/**
 * Runs an import as an attempt of its own (the automatic one, or one the user asked for: Retry, Start fresh,
 * Re-import), and says which attempt it was.
 */
const _runImport = (
    run: (onLate: (failure: ImportFailure) => void) => ImportOutcome,
): { outcome: ImportOutcome; mine: number } => {
    const attempt = _beginImport();
    const outcome = run(attempt.onLate);
    attempt.started(outcome);
    return { outcome, mine: attempt.mine };
};

/**
 * The restore that `mine` made counts as one when its own write has landed (at once where the write is synchronous):
 * the notice says restored then, and a block an earlier try of the restore left is lifted. A later attempt makes this
 * one moot.
 */
const _awaitRestore = (landed: Promise<QueuedWriteOutcome> | undefined, mine: number, restored: ConfigV2): void => {
    // The mirror holds a sign-out an older build made (or the user never signed in): the copies kept of the settings
    // files lose the sign-in they hold, as after any sign-out.
    if (restored.auth.token === '') scrubCopiesAfterSignOut(landed);
    owedCheck = true;
    if (!landed) {
        restoredFromMirror = true;
        return;
    }
    restoreInFlight = true;
    void landed.then((outcome) => {
        if (mine !== latestImport || outcome === 'failed') return;
        restoreInFlight = false;
        restoreRetryPending = false;
        restoredFromMirror = true;
        _clearTransientFailure();
        // The notice may be showing the failed try: it asks again, and finds the restore.
        if (recoveryListener) queueMicrotask(recoveryListener);
    });
};

/**
 * What a load finds when there is no configuration: the import of `settings.json` the first time, the configuration
 * restored from it once it has been imported (it is current), defaults when there is nothing to restore from.
 */
const _loadWithoutConfig = (): ConfigV2 => {
    if (importFailure || Date.now() < retryNotBefore) return _loadDefaults('Loaded default settings with keys');
    if (importSettled) {
        _unblock();
        return _loadDefaults('No settings file found, loaded default settings with keys');
    }
    const { outcome, mine } = _runImport(importWhenAbsent);
    // Stores not read yet (the Android window before it hydrates): nothing is wrong with the settings, they are just
    // not there to be read; the defaults answer, and the read is made again once they are.
    if (!outcome.ok && outcome.reason === 'not-loaded') return getDefaultSettings();
    // (A restore still in flight when the cache shows no configuration did not come through: it is what is retried.)
    if (!outcome.ok && (restoreRetryPending || restoreInFlight) && _fileIsUnusable(outcome)) {
        // The restore of a damaged configuration, tried again after it could not be tried, finds settings.json itself
        // unusable: settled as the first try would have, not as a blocked import (see _restoreFromMirror). The late
        // failure of the try that was retried says nothing more.
        return _settleUnusable(outcome);
    }
    if (!outcome.ok) return _importFailed(outcome);
    if (outcome.kind === 'recovered') {
        restoreRetryPending = false;
        logger
            .withCategory('settings')
            .warning(
                `config.json was ${corruptBackupPath === null ? 'missing' : 'damaged'}; the configuration was restored from settings.json`,
            );
    }
    if (outcome.kind === 'imported' || outcome.kind === 'recovered' || outcome.kind === 'adopted') {
        const config = _loadFromText(outcome.text, outcome.landed === undefined);
        // A damaged configuration set aside earlier whose restore had to wait (the stores were not read yet, or it was
        // busy) is restored now: by this attempt, or by another process that did it first (`adopted`), as at the first try.
        const restoring =
            outcome.kind === 'recovered' ||
            (outcome.kind === 'adopted' && restoreRetryPending && configSource() !== 'fresh');
        if (restoring && corruptBackupPath !== null && !restoredFromMirror) {
            restoreRetryPending = false;
            _awaitRestore(outcome.landed, mine, config);
        } else if (outcome.kind === 'adopted') {
            // Found there, but not made by a restore: the restore is no longer waited for, and not claimed.
            restoreRetryPending = false;
        }
        return config;
    }
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
    // A text only the cache shows (an import or a save of the Android window not landed yet) proves nothing: nothing is
    // cleared, logged or mirrored on it until it is stored.
    const config = settingsData ? _loadFromText(settingsData, storage.isPersisted()) : _loadWithoutConfig();
    if (owedCheck && blocked === null && storage.isPersisted() && !restoreInFlight && _storesLoaded()) {
        const signedOut = _applyOwedSignOut(config);
        if (signedOut !== null) return signedOut;
    }
    return blocked === null && storage.isPersisted() ? _verifyMirror(config) : config;
};

/**
 * The record of a sign-out owed to a restore was queued (the Android app window) and then not stored: the logout would be
 * lost without a word, so it is logged and shown as a change that was not saved.
 */
const _signOutLost = (record: OwedSignOut): void => {
    logger
        .withCategory('settings')
        .error(
            'A logout made while the settings could not be loaded was not recorded; you may still be logged in',
            null,
        );
    // It holds only while this process stays: said plainly, as its own notice, until it is applied or made again.
    signOutLostNotice = true;
    if (recoveryListener) queueMicrotask(recoveryListener);
    owedMemory = record;
    owedCheck = true;
};

/**
 * The sign-out made while a restore was pending (recorded in the marker, so that it holds in whichever process the
 * restore lands) is applied to the configuration that has come through: the token and the API headers go, in the
 * configuration and the mirror, and the copies kept lose the sign-in as after any sign-out. The record names the sign-in
 * it signs out by fingerprint, so a sign-in that is another (a login made since, in any process) is never touched, and the
 * order the stores land in cannot matter.
 *
 * @returns the configuration read after the sign-out was applied; null when nothing was applied to the configuration
 *   (nothing owed, the sign-in it holds is another, or the sign-out could not be saved yet)
 */
const _applyOwedSignOut = (config: ConfigV2): ConfigV2 | null => {
    owedCheck = false;
    const record = signOutOwedStored() ?? owedMemory;
    if (record === null) return null;
    // It is being applied: the logout is no longer one that was only in memory.
    signOutLostNotice = false;
    // The copies kept lose the sign-in the record names (a settings.json still to be set aside is a copy to come: it is
    // cleared at the moment it is made, see _scrubAsideIfOwed).
    scrubCopiesAfterSignOut(undefined, record.fingerprints);
    if (config.auth.token !== '' && tokenInSignIns(record.fingerprints, config.auth.token)) {
        if (!_saveChange((current) => ({ auth: { ...current.auth, token: '', apiHeaders: {} } }))) {
            owedCheck = true;
            return null;
        }
        _settleOwedSignOut(record);
        return loadSettings();
    }
    _settleOwedSignOut(record);
    return null;
};

/**
 * Removes the owed sign-out once nothing that holds the sign-in it names remains to be cleared: not while a settings.json
 * is still to be set aside (a copy to come), and at the latest when the copies set aside are cleared by age. A record that
 * could not be removed is harmless: it applies to nothing once the sign-in it names is gone.
 */
const _settleOwedSignOut = (record: OwedSignOut): void => {
    const expired = !(Date.now() - Date.parse(record.at) <= REMEMBERED_COPY_MAX_AGE_MS);
    if (!expired && (legacyUnusable || legacyAsideOwedStored() !== null)) return;
    clearSignOutOwed(record.id);
    if (owedMemory?.id === record.id) owedMemory = null;
};

/**
 * Whether a sign-out is owed to a restore that has not come through yet (it holds when it does).
 */
const isSignOutOwed = (): boolean =>
    (restoreInFlight || blocked !== null) && (signOutOwedStored() ?? owedMemory) !== null;

/**
 * Why the stored settings are not in use, or null: see SettingsRecovery.
 */
const getSettingsRecovery = (): SettingsRecovery | null => {
    const recovery = _recoveryState();
    // A logout that was not recorded is told whatever else stands, not hidden behind it.
    return recovery !== null && signOutLostNotice ? { ...recovery, logoutLost: true } : recovery;
};

const _recoveryState = (): SettingsRecovery | null => {
    if (blocked) return blocked;
    // A restore on its way has no verdict yet; the window is told when it has (see _awaitRestore).
    if (!corruptBackupPath || restoreInFlight) return null;
    return {
        code: restoredFromMirror ? 'settings-restored' : 'settings-corrupt',
        path: corruptBackupPath,
        blocking: false,
        ...(!restoredFromMirror && legacySetAside !== null ? { settingsSetAside: legacySetAside } : {}),
        ...(!restoredFromMirror && !runtime.isCapacitor() ? { reimportSource: _reimportSource() } : {}),
    };
};

/**
 * Tells `listener` when a read clears the block it had put up (the one subscriber is replaced by the next).
 */
const onRecoveryChange = (listener: (() => void) | null): void => {
    recoveryListener = listener;
    if (listener === null) _cancelRetry();
};

/**
 * The change the app window made last that could not be saved, or null: see SettingsSaveDropped.
 */
const getSettingsSaveDropped = (): SettingsSaveDropped | null =>
    signOutLostNotice
        ? {
              code: 'settings-save-dropped',
              path: storage.location(),
              cause: 'logout-lost',
              serial: getSaveDroppedSerial(),
          }
        : isSaveDropped()
          ? {
                code: 'settings-save-dropped',
                path: storage.location(),
                cause: getSaveDroppedCause(),
                serial: getSaveDroppedSerial(),
            }
          : null;

/**
 * A sign-out applied while the `settings.json` was still to be set aside: the copy it has become is cleared of the
 * sign-in it held, once.
 */
const _scrubAsideIfOwed = (): void => {
    const record = signOutOwedStored() ?? owedMemory;
    if (record === null) return;
    scrubCopiesAfterSignOut(undefined, record.fingerprints);
    _settleOwedSignOut(record);
};

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
    const owedAside = legacyAsideOwedStored();
    if (owedAside !== null) clearLegacyAsideOwed(owedAside);
    // Where the write is only queued, the notice says where it went once it has (see _mirror).
    if (!aside.queued) {
        // The copy just made holds whatever sign-in the file held: a sign-out applied meanwhile clears it now.
        _scrubAsideIfOwed();
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
    // A settings.json that Start fresh could not read and left as it is stays owed a set-aside, in whichever process.
    if (blocked || ((legacyUnusable || legacyAsideOwedStored()) && !_setAsideUnusableLegacy())) return;
    mirrorSettings(landed, {
        adoptSignIn: _adoptSignIn,
        onSetAside: (key) => {
            legacySetAside = key;
            rememberUnimportableCopy(key);
            _scrubAsideIfOwed();
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
    // What the background service could not clear of a sign-out it saved (the copies in Preferences) is cleared now.
    flushPendingMarkerChanges();
    finishDeferredScrub(true);
    scrubOldCopies();
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
    // Changes of the marker that could not be made before are made again.
    if (written.ok) flushPendingMarkerChanges();
    if (written.ok && withMirror) _mirror(written.landed);
    // The background service may have signed out since the window started: what it left to the window is done now.
    if (written.ok) finishDeferredScrub();
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
        // The saved user name goes with the choice to stay logged in: turning that off forgets the name in the same
        // write, whoever changes it (the form, the CLI, a script).
        if (current.app.stayLoggedIn === true && next.app.stayLoggedIn !== true && next.auth.lastUsername !== '') {
            next.auth = { ...next.auth, lastUsername: '' };
        }
        // Write via storage adapter (sync fs on Electron/CLI; cache + async write-behind on Capacitor)
        const saved = _persist(next, withMirror);
        // A token that was stored and is cleared is a sign-out, which the copies kept of the settings files are cleared
        // of at once (a configuration that merely holds no token is not one).
        if (saved.ok && current.auth.token !== '' && next.auth.token === '') scrubCopiesAfterSignOut(saved.landed);
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
    // A sign-out made while a restore is on its way or waiting to be retried must hold when it lands: the restored
    // configuration is signed out too (see loadSettings).
    const owed = key === 'token' && value === '' && (restoreInFlight || blocked?.code === 'settings-import-retrying');
    // Recorded where every process can find it; when that cannot be, the sign-out is refused, not taken for made.
    if (owed && !_recordOwedSignOut()) return false;
    const saved = _saveChange((current) =>
        isAuthKey(key) ? { auth: { ...current.auth, [key]: value } } : { app: { ...current.app, [key]: value } },
    );
    if (saved && key === 'token' && value === '') signOutLostNotice = false;
    return saved || owed;
};

/**
 * Records the sign-out that is owed to the settings a restore is bringing, naming the sign-in it signs out: the one the
 * mirror last wrote to settings.json, and the one settings.json holds now (an older build may have written it).
 *
 * @returns false when the sign-out cannot be made to hold: its record could not be stored, or settings.json cannot be
 *   read and the mirror never wrote a sign-in to name
 */
const _recordOwedSignOut = (): boolean => {
    const held = signInHeldIn(legacyStorage.peekRaw());
    const fingerprints = held === null ? mirroredSignIns() : [...new Set([...mirroredSignIns(), held])];
    // Nothing to sign out: a restore brings no sign-in. (A settings.json that cannot be read just now may hold one: not known.)
    if (fingerprints.length === 0) return blocked?.code !== 'settings-import-retrying';
    const record = markSignOutOwed(fingerprints, _signOutLost);
    if (record === null) return false;
    owedMemory = record;
    owedCheck = true;
    return true;
};

/**
 * The record that a settings.json left as it is is to be set aside could not be stored (the Android window queued it):
 * only this process keeps that promise, which is said.
 */
const _asideOwedLost = (): void => {
    logger
        .withCategory('settings')
        .warning(
            'settings.json was left as it is, but that could not be recorded: it is set aside before a mirror write by this run only',
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
 * An action that ended the wait of a restore (Retry, or Start fresh that found a configuration stored meanwhile) ends the
 * episode of the damaged configuration as the automatic path does: what it put in place is the restore, and counts once it
 * has landed. Start fresh that wrote defaults leaves the episode as it was (defaults are in use, the damaged copy kept).
 */
const _finishRestore = (outcome: ImportOutcome, mine: number): void => {
    if (!outcome.ok || corruptBackupPath === null || restoredFromMirror || restoreInFlight) return;
    if (outcome.kind !== 'imported' && outcome.kind !== 'recovered' && outcome.kind !== 'adopted') return;
    // A configuration found there already is the restore (or what a process went on to save over it), not the defaults of
    // another process's Start fresh: that is reported as what it is, and the damaged copy keeps the sign-in it holds.
    if (outcome.kind === 'adopted' && configSource() === 'fresh') return;
    const parsed = _parseSettings(outcome.text);
    if (!parsed.ok) return;
    _awaitRestore(outcome.landed, mine, mergeWithDefaults(parsed.value));
};

/**
 * What a recovery action came to: the failure it ran into leaves the state as it was, except that a configuration
 * that is no longer there blocks saves (the import is what is missing). Never throws.
 */
const _recovered = (
    run: () => { outcome: ImportOutcome; mine: number },
    after?: (outcome: ImportOutcome, mine: number) => void,
): boolean => {
    try {
        const { outcome, mine } = run();
        if (outcome.ok) {
            // The episode of a damaged configuration is over (or none was): no copy is the one to fix any more.
            forgetUnimportableCopy();
            importFailure = null;
            retryNotBefore = 0;
            transientFailures = 0;
            lastBlockedLog = null;
            importSettled = false;
            mirrorVerified = false;
            legacyUnusable = false;
            legacySetAside = null;
            restoreRetryPending = false;
            owedCheck = true;
            _cancelRetry();
            blocked = null;
            after?.(outcome, mine);
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
 * @returns whether a configuration is stored now, and `adopted` when one was in place already (a restore that came
 *   through meanwhile): nothing was imported
 */
const retryImportDetailed = (): { ok: boolean; adopted?: true } => {
    let adopted = false;
    const ok = _recovered(() => {
        const run = _runImport(retryLegacyImport);
        adopted = run.outcome.ok && run.outcome.kind === 'adopted';
        return run;
    }, _finishRestore);
    return { ok, ...(adopted ? { adopted } : {}) };
};

/**
 * `retryImportDetailed`, for the caller that wants to know only whether a configuration is stored now.
 */
const retryImport = (): boolean => retryImportDetailed().ok;

/**
 * Begin with a default configuration instead of importing: `settings.json` is kept (as `settings.json.original`, or as
 * `settings.json.unimportable-<time>` when that is taken) before the mirror writes over it, and is not imported later
 * unasked.
 *
 * @returns whether the configuration was written, and where `settings.json` was kept (`keptAt`: null when there was none
 *   to keep); in the Android window, where the copy is written later, `landed` says under which key it was; `adopted`
 *   when a configuration was there already (a restore on its way), which is kept: nothing was reset; `unreadable` when
 *   settings.json could not be read, so it was left as it is and nothing was kept
 */
const startFreshDetailed = (): {
    ok: boolean;
    keptAt: string | null;
    landed?: Promise<string | null>;
    adopted?: true;
    unreadable?: true;
} => {
    let keptAt: string | null = null;
    let landed: Promise<string | null> | undefined;
    let adopted = false;
    let unreadable = false;
    let recordedAside: string | null = null;
    let configWritten = false;
    const ok = _recovered(() => {
        const run = _runImport((onLate) =>
            startFreshConfig(
                onLate,
                (kept) => {
                    if (typeof kept === 'string') keptAt = kept;
                    else landed = kept;
                },
                () => {
                    recordedAside = markLegacyAsideOwed(_asideOwedLost);
                    return recordedAside !== null;
                },
            ),
        );
        // A configuration was there already (a restore on its way, or one another context saved): nothing was reset.
        adopted = run.outcome.ok && run.outcome.kind === 'adopted';
        // A settings.json that could not be read was left as it is, not kept as a copy.
        unreadable = run.outcome.ok && run.outcome.kind === 'fresh' && run.outcome.unreadable === true;
        configWritten = run.outcome.ok;
        return run;
    }, _finishRestore);
    // Left as it is, it is set aside before anything is mirrored over it once it can be read (recorded, for any process).
    if (ok && unreadable) legacyUnusable = true;
    // A Start fresh that did not happen promises nothing: the record of the set-aside it was going to owe goes. Not when a
    // configuration was written (the mirror then owes the set-aside, whatever failed after).
    if (!ok && !configWritten && recordedAside !== null) clearLegacyAsideOwed(recordedAside);
    return {
        ok,
        keptAt,
        ...(landed === undefined ? {} : { landed }),
        ...(adopted ? { adopted } : {}),
        ...(unreadable ? { unreadable } : {}),
    };
};

/**
 * `startFreshDetailed`, for the caller that wants to know only whether the configuration was written.
 */
const startFresh = (): boolean => startFreshDetailed().ok;

/**
 * The copy kept of the settings.json that did not import in the last episode of a damaged configuration: this process's,
 * or the one the marker remembers (another process, or an earlier run of the app, set it aside) if it is a path where a
 * copy is kept (beside settings.json, named as one: the marker is a file the user can edit). Where there are no files the
 * key of one is not a path to read. Null without one.
 */
const _rememberedCopy = (): string | null => {
    if (runtime.isCapacitor()) return null;
    const remembered = keptUnimportableCopy();
    if (legacySetAside !== null) return legacySetAside;
    const kept = remembered === null ? null : legacyStorage.keptCopyPath(remembered);
    if (kept === null) return null;
    // An episode is not left open for ever: a copy made long ago is not the file the user was told to fix (a save in
    // another process does not end the episode, so this is what bounds it; a re-import and Start fresh end it at once).
    const madeAt = legacyStorage.keptCopyMadeAt(kept);
    return madeAt !== null && Date.now() - madeAt > REMEMBERED_COPY_MAX_AGE_MS ? null : kept;
};

/**
 * The file to fix, when settings.json did not import: the copy of the last episode (see _rememberedCopy), unless it is
 * gone, which ends the episode. Null without one: settings.json itself is imported.
 */
const _copyToFix = (): string | null => {
    const copy = _rememberedCopy();
    if (copy === null || legacyStorage.hasCopy(copy)) return copy;
    forgetUnimportableCopy();
    legacySetAside = null;
    return null;
};

/** The file a re-import would read now: the copy to fix, or settings.json. */
const _reimportSource = (): string => {
    const copy = _rememberedCopy();
    return copy !== null && legacyStorage.hasCopy(copy) ? copy : legacyStorage.location();
};

/**
 * Import `settings.json` again on request: the configuration in use is set aside the way a damaged one is
 * (`config.json.corrupt-<time>`) and the import is saved in its place, the sign-in included. `settings.json` is the
 * mirror of what was in use, unless an older build changed it since.
 *
 * @returns whether the import was saved, where the configuration that was in use was set aside (null: none was), and
 *   the file that was read (a path; the key of settings.json where there are no files)
 */
const reimportFromV1Detailed = (): { ok: boolean; setAside: string | null; source: string } => {
    let setAside: string | null = null;
    let source = legacyStorage.location();
    const ok = _recovered(() => {
        const copy = _copyToFix();
        source = copy ?? legacyStorage.location();
        return _runImport((onLate) =>
            reimportLegacyFile(
                onLate,
                (path) => {
                    setAside = path;
                },
                copy,
            ),
        );
    });
    // The damaged configuration the notice was about is not the one in use any more.
    if (ok) {
        corruptBackupPath = null;
        restoredFromMirror = false;
        legacySetAside = null;
    }
    return { ok, setAside, source };
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
    isSignOutOwed,
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
    reimportFromV1,
    reimportFromV1Detailed,
    getImportReport,
    acknowledgeImportReport,
};
