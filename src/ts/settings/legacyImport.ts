/**
 * The one-time import of a 1.x `settings.json` into `config.json`, and what surrounds it: the lock it runs under, the
 * marker and the title-pin cache it leaves, the blanking of the sign-in state that `settings.json` still holds, and
 * the explicit recovery paths (start fresh, re-import). The conversion itself is the frozen pipeline in importV1/;
 * this module only decides when it runs and puts down its result. `settings.json` is read as text and never goes
 * through the live load; the only write to it blanks the sign-in state.
 */

import * as logger from '../logger';
import { errorMessage } from '../errorMessage';
import { isPlainObject } from '../plainObject';
import { acquireUnlockLock } from '../joinStateStore';
import { acquireWithin } from '../lockWait';
import { getDefaultSettings } from './defaults';
import { AUTH_KEYS, authValueAllowed } from './loadValidation';
import { importV1Settings } from './importV1';
import { isImportMarked, markImportDone } from './importMarker';
import { invalidReferences } from './importReport';
import { recordImportHash } from './importedRecord';
import { legacyStorage, storage } from './storage';
import { importTitlePins } from './titlePins';

import type { ConfigAuthV2, ImportedV2 } from '../types/config';
import type { QueuedWriteOutcome } from './storage';

// The lock every import (and every start-fresh or re-import) runs under: two processes sharing the user-data directory
// (the app and the CLI) never import at once. Android has no file lock; there the native compare-and-write of the
// configuration decides which context is first.
const IMPORT_LOCK_ID = 'config-import';
const LOCK_WAIT_MS = 2000;

/** Why the 1.x settings could not be put into a configuration. */
type ImportFailureReason = 'busy' | 'not-loaded' | 'unreadable' | 'corrupt' | 'migration-failed' | 'write-failed';

type ImportFailure = { ok: false; reason: ImportFailureReason; detail: string };

/**
 * What an import came to when it did not fail: `imported` (the converted configuration was saved); `fresh` (there was
 * no 1.x file; the marker was written); `adopted` (the configuration is already there, another context or process
 * saved it first); `skipped` (the marker or a set-aside configuration says an import must not run unasked). `text` is
 * the configuration now stored.
 */
type ImportDone = { ok: true; kind: 'imported' | 'adopted'; text: string } | { ok: true; kind: 'fresh' | 'skipped' };

type ImportOutcome = ImportDone | ImportFailure;

/** What hears of an import that looked done and then failed to be stored (see whenStored). */
type LateFailure = (failure: ImportFailure) => void;

const failure = (reason: ImportFailureReason, detail: string): ImportFailure => ({ ok: false, reason, detail });

const underImportLock = (run: () => ImportOutcome): ImportOutcome => {
    const lock = acquireWithin(
        () => acquireUnlockLock(IMPORT_LOCK_ID, { category: 'settings', internal: true }),
        LOCK_WAIT_MS,
    );
    if (lock === 'busy') return failure('busy', 'another process is importing the settings');
    if (lock === 'unavailable') return failure('busy', 'the import lock cannot be taken');
    try {
        return run();
    } catch (error) {
        return failure('unreadable', errorMessage(error) ?? 'unknown error');
    } finally {
        lock.release();
    }
};

const BLANK_AUTH: Readonly<Record<string, unknown>> = {
    token: '',
    apiHeaders: {},
    lastUsername: '',
    chosenPhotosMemberId: '',
};

const isBlank = (value: unknown): boolean => value === '' || (isPlainObject(value) && Object.keys(value).length === 0);

/**
 * Blank the sign-in state `settings.json` still holds (`token`, `apiHeaders`, `lastUsername`, `chosenPhotosMemberId`):
 * the configuration owns it from the import on. Everything else in the file is written back as it was parsed. Nothing
 * is written when there is nothing to blank.
 *
 * @returns whether the file was written
 */
const blankLegacyAuth = (): boolean => {
    const raw = legacyStorage.readRaw();
    if (!raw) return false;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return false; // a file that is not JSON holds no sign-in state to blank
    }
    if (!isPlainObject(parsed)) return false;
    const held = Object.keys(BLANK_AUTH).filter((key) => Object.hasOwn(parsed, key) && !isBlank(parsed[key]));
    if (held.length === 0) return false;
    for (const key of held) parsed[key] = BLANK_AUTH[key];
    return legacyStorage.writeRaw(JSON.stringify(parsed, null, 2));
};

// Whether this process has looked at `settings.json` for sign-in state a 1.x login left (see blankLegacyAuthOnce).
let legacyAuthChecked = false;

/**
 * Once per process, while the marker says the import has run: blank the sign-in state `settings.json` holds again,
 * which covers a token a 1.x login wrote after a downgrade and an Android crash between the two writes of an import.
 * A file that cannot be read yet (Android, before the window has hydrated) is looked at on a later call.
 */
const blankLegacyAuthOnce = (): void => {
    if (legacyAuthChecked || !legacyStorage.isLoaded() || !isImportMarked()) return;
    legacyAuthChecked = true;
    try {
        if (blankLegacyAuth()) logger.withCategory('settings').info('Cleared the sign-in state left in settings.json');
    } catch (error) {
        logger.withCategory('settings').error('Could not clear the sign-in state left in settings.json:', error);
    }
};

/**
 * What to do once the configuration of an import is stored: at once where the save is synchronous, and where it is only
 * queued (the Android app window) once it has landed. If it does not land (the store refuses it, it is past the size
 * the native store takes, the WebView is gone before the write), `onLateFailure` hears of it, and nothing that says
 * "the import is done" has been written, so the next start imports again. A write the compare-and-write declined (the
 * background service saved its import first) leaves that configuration in place, which is as good as having landed.
 */
const whenStored = (
    written: { landed?: Promise<QueuedWriteOutcome> },
    onStored: () => void,
    onLateFailure: LateFailure,
): void => {
    if (!written.landed) {
        onStored();
        return;
    }
    void written.landed.then((outcome) => {
        if (outcome === 'failed') onLateFailure(failure('write-failed', 'config.json could not be saved'));
        else onStored();
    });
};

/**
 * What an import leaves once the configuration is stored: the marker, the hash of the `settings.json` it was made from,
 * then the legacy sign-in state blanked.
 */
const markImported = (raw: string): void => {
    carriedAuth = null;
    markImportDone();
    void recordImportHash(raw);
    try {
        blankLegacyAuth();
    } catch (error) {
        // The configuration is saved and the marker written: the next start blanks it again.
        logger.withCategory('settings').error('Could not clear the sign-in state left in settings.json:', error);
    }
};

/**
 * Convert the text of `settings.json` and put the result down: the title pins, then `config.json`, and once that is
 * stored the marker and the blanking of the legacy sign-in state. The conversion comes first and touches nothing, so a
 * file that cannot be converted leaves everything as it was; `replacing` runs once it has converted (it may refuse).
 */
const importLegacyText = (
    raw: string,
    onLateFailure: LateFailure,
    replacing?: () => ImportFailure | null,
): ImportOutcome => {
    const result = importV1Settings(raw);
    if (!result.ok) return failure(result.code, result.detail);
    const { refsBlocked } = result.report;
    // The hash is filled once the configuration is stored (markImported); the rest of the record is known now.
    const imported: ImportedV2 = {
        at: new Date().toISOString(),
        sha256: '',
        report: { refsBlocked: [...refsBlocked, ...invalidReferences(result.config, refsBlocked)] },
        acknowledged: false,
    };
    const refused = replacing?.() ?? null;
    if (refused) return refused;
    // A re-import keeps the sign-in state of the configuration it replaces: the file holds none.
    if (carriedAuth) Object.assign(result.config.auth, carriedAuth);
    const text = JSON.stringify({ ...result.config, imported }, null, 2);
    if (!importTitlePins(result.titlePins)) return failure('write-failed', 'the title pins could not be saved');
    const written = storage.writeIfAbsent(text);
    if (written.outcome === 'failed') return failure('write-failed', 'config.json could not be saved');
    if (written.outcome === 'exists') {
        return written.current
            ? { ok: true, kind: 'adopted', text: written.current }
            : failure('write-failed', 'config.json could not be read');
    }
    whenStored(written, () => markImported(raw), onLateFailure);
    return { ok: true, kind: 'imported', text };
};

/**
 * The text of `settings.json`: null when there is none, or a failure when it cannot be read (or the stored settings
 * have not been read yet).
 */
const readLegacyText = (): { ok: true; raw: string | null } | ImportFailure => {
    if (!legacyStorage.isLoaded() || !storage.isLoaded()) {
        return failure('not-loaded', 'the stored settings have not been read yet');
    }
    try {
        return { ok: true, raw: legacyStorage.readRaw() || null };
    } catch (error) {
        return failure('unreadable', errorMessage(error) ?? 'unknown error');
    }
};

/**
 * Read `settings.json` and import it, or note that a fresh install has none.
 */
const importFromLegacyFile = (onLateFailure: LateFailure): ImportOutcome => {
    const legacy = readLegacyText();
    if (!legacy.ok) return legacy;
    if (legacy.raw === null) {
        // A 1.x file that shows up later must not import silently.
        markImportDone();
        return { ok: true, kind: 'fresh' };
    }
    return importLegacyText(legacy.raw, onLateFailure);
};

/**
 * What a load does when there is no configuration: import `settings.json`, unless the marker or a set-aside
 * configuration says it has already been dealt with. Runs under the import lock; a configuration another process
 * saved while it waited is adopted.
 */
const importWhenAbsent = (onLateFailure: LateFailure): ImportOutcome =>
    underImportLock(() => {
        const existing = storage.readRaw();
        if (existing) return { ok: true, kind: 'adopted', text: existing };
        if (isImportMarked() || storage.hasQuarantined()) return { ok: true, kind: 'skipped' };
        return importFromLegacyFile(onLateFailure);
    });

/**
 * Write a default configuration and the marker, and leave `settings.json` as the backup. A configuration that is there
 * already is left as it is.
 */
const startFreshConfig = (onLateFailure: LateFailure): ImportOutcome =>
    underImportLock(() => {
        const existing = storage.readRaw();
        if (existing) return { ok: true, kind: 'adopted', text: existing };
        const written = storage.writeIfAbsent(JSON.stringify(getDefaultSettings(), null, 2));
        if (written.outcome === 'failed') return failure('write-failed', 'config.json could not be saved');
        whenStored(
            written.outcome === 'saved' ? written : {},
            () => {
                carriedAuth = null; // a fresh start keeps nothing of what was set aside
                markImportDone();
            },
            onLateFailure,
        );
        return { ok: true, kind: 'fresh' };
    });

// The sign-in state of the configuration a re-import set aside, until a configuration is stored again: a re-import that
// fails after setting the configuration aside is retried without it, and must not sign the user out.
let carriedAuth: Partial<ConfigAuthV2> | null = null;

/**
 * The sign-in state of a stored configuration that `settings.json` no longer holds (the first import blanked it): the
 * values a configuration can hold, whatever else is wrong with it.
 */
const authOfConfig = (current: string): Partial<ConfigAuthV2> => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(current);
    } catch {
        return {}; // a configuration that cannot be read has no sign-in state to keep
    }
    const auth = isPlainObject(parsed) ? parsed.auth : null;
    const kept: Partial<ConfigAuthV2> = {};
    if (!isPlainObject(auth)) return kept;
    for (const key of AUTH_KEYS) {
        if (Object.hasOwn(auth, key) && authValueAllowed(key, auth[key])) Object.assign(kept, { [key]: auth[key] });
    }
    return kept;
};

/**
 * Import `settings.json` on request, whatever the marker and a set-aside configuration say (the automatic import ran,
 * or was refused, and this is the user's call). With `replacing` the configuration in use is kept apart the way a
 * damaged one is (`config.json.corrupt-<time>`) once `settings.json` has converted, and its sign-in state goes into the
 * import; without it a configuration that is there is left as it is. A `settings.json` that cannot be converted
 * leaves the configuration as it is.
 */
const importOnRequest = (onLateFailure: LateFailure, replacing: boolean): ImportOutcome =>
    underImportLock(() => {
        const existing = storage.readRaw();
        if (existing && !replacing) return { ok: true, kind: 'adopted', text: existing };
        const legacy = readLegacyText();
        if (!legacy.ok) return legacy;
        if (legacy.raw === null) return failure('unreadable', 'settings.json does not exist');
        return importLegacyText(
            legacy.raw,
            onLateFailure,
            existing
                ? () => {
                      carriedAuth = authOfConfig(existing);
                      const moved = storage.quarantineRaw(existing);
                      return moved.ok ? null : failure('unreadable', moved.error);
                  }
                : undefined,
        );
    });

/** Import `settings.json` again after an import (or a re-import) failed, as the explicit import it was. */
const retryLegacyImport = (onLateFailure: LateFailure): ImportOutcome => importOnRequest(onLateFailure, false);

/** Import `settings.json` again over the configuration in use. */
const reimportLegacyFile = (onLateFailure: LateFailure): ImportOutcome => importOnRequest(onLateFailure, true);

export type { ImportFailure, ImportOutcome };
export { blankLegacyAuthOnce, importWhenAbsent, reimportLegacyFile, retryLegacyImport, startFreshConfig };
