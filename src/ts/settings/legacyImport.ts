/**
 * The import of a `settings.json` into `config.json`, and what surrounds it: the lock it runs under, the marker and the
 * title-pin cache it leaves, the restoring of a missing configuration from the mirror, and the explicit recovery paths
 * (start fresh, re-import). The conversion itself is the frozen pipeline in importV1/; this module only decides when it
 * runs and puts down its result. `settings.json` is read as text and never goes through the live load, and is never
 * written here: formatOneMirror.ts keeps it current.
 */

import { errorMessage } from '../errorMessage';
import { isPlainObject } from '../plainObject';
import { getDefaultSettings } from './defaults';
import { attachCloseTimeRules, takeCloseTimeRules } from './closeTimeRules';
import { importV1Settings } from './importV1';
import { withImportedTimezone } from './formatOneTimezone';
import { isImportMarked, isMirrorStarted, keptImportedRecord, markImportDone } from './importMarker';
import { invalidReferences } from './importReport';
import { setAsideLegacy } from './formatOneMirror';
import { schemaEntry } from './schema';
import { acquireSettingsLock } from './settingsLock';
import { legacyStorage, storage } from './storage';
import { importTitlePins } from './titlePins';

import type { ImportedV2 } from '../types/config';
import type { QueuedWriteOutcome } from './storage';

// The lock every import (and every start-fresh or re-import) runs under: two processes sharing the user-data directory
// (the app and the CLI) never import at once. Android has no file lock; there the native compare-and-write of the
// configuration decides which context is first.
const LOCK_WAIT_MS = 2000;

/** Why the `settings.json` could not be put into a configuration. */
type ImportFailureReason =
    | 'busy'
    | 'not-loaded'
    | 'unreadable'
    | 'inaccessible'
    | 'corrupt'
    | 'migration-failed'
    | 'write-failed';

type ImportFailure = { ok: false; reason: ImportFailureReason; detail: string };

/**
 * What an import came to when it did not fail: `imported` (the converted configuration was saved); `recovered` (the
 * configuration was gone and was restored from `settings.json`, the mirror of it); `fresh` (there was no
 * `settings.json`; the marker was written); `adopted` (the configuration is already there, another context or process
 * saved it first); `skipped` (a set-aside configuration says an import must not run unasked). `text` is the
 * configuration now stored; `landed` (the Android app window) says it is only shown by the cache until its queued
 * write lands, which it may not, and tells how that ends.
 */
type ImportDone =
    | { ok: true; kind: 'imported' | 'recovered' | 'adopted'; text: string; landed?: Promise<QueuedWriteOutcome> }
    | { ok: true; kind: 'fresh' | 'skipped'; unreadable?: true };

type ImportOutcome = ImportDone | ImportFailure;

/** What hears of an import that looked done and then failed to be stored (see whenStored). */
type LateFailure = (failure: ImportFailure) => void;

const failure = (reason: ImportFailureReason, detail: string): ImportFailure => ({ ok: false, reason, detail });

// The errors that pass by themselves: a file another program holds for a moment, a read that was interrupted, too many
// files open for the moment, a timeout, an input/output error (a disk or a share that comes back).
const TRANSIENT_ERRNOS = new Set(['EBUSY', 'EAGAIN', 'EINTR', 'EMFILE', 'ENFILE', 'ETIMEDOUT', 'EIO']);

/**
 * A failure to read `settings.json`: `unreadable` when it may pass by itself (a transient errno, or an error with no code
 * to tell), `inaccessible` when the file itself cannot be read (no permission, a directory in its place): no retry
 * helps, so it is as unusable as a damaged file.
 */
const readFailure = (error: unknown): ImportFailure => {
    const code = (error instanceof Error || isPlainObject(error)) && 'code' in error ? error.code : undefined;
    const detail = errorMessage(error) ?? 'unknown error';
    return typeof code === 'string' && !TRANSIENT_ERRNOS.has(code)
        ? failure('inaccessible', detail)
        : failure('unreadable', detail);
};

const underImportLock = (run: () => ImportOutcome): ImportOutcome => {
    const lock = acquireSettingsLock(LOCK_WAIT_MS);
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

/** What `importLegacyText` is told besides the text. */
type ImportMode = {
    /** runs once the text has converted; answers a failure to refuse the import (it may set the configuration in use aside) */
    replacing?: () => ImportFailure | null;
    /** the configuration was lost and `settings.json` is the mirror of it: the import record is the one the marker kept, if any */
    recovering?: true;
};

/**
 * Convert the text of `settings.json` and put the result down: the title pins, then `config.json`, and once that is
 * stored the marker. The conversion comes first and touches nothing, so a file that cannot be converted leaves
 * everything as it was.
 */
const importLegacyText = (
    raw: string,
    onLateFailure: LateFailure,
    { replacing, recovering }: ImportMode = {},
): ImportOutcome => {
    // The keys of the live schema are kept whether or not the frozen one knows them: the file holds what this app wrote.
    // The rules the mirror carries beside `titleRules` are taken out before the frozen importer sees the text, and put back
    // where they stood (before the report is made, so it covers them too).
    const { raw: mirrored, carried } = takeCloseTimeRules(raw);
    const converted = importV1Settings(mirrored, { keptKey: (key) => schemaEntry(key) !== undefined });
    if (!converted.ok) return failure(converted.code, converted.detail);
    const result = { ...converted, config: withImportedTimezone(converted.config) };
    if (carried.length > 0) result.config.rules = attachCloseTimeRules(result.config.rules, carried);
    const { refsBlocked } = result.report;
    const imported: ImportedV2 | undefined = recovering
        ? (keptImportedRecord() ?? undefined)
        : {
              at: new Date().toISOString(),
              report: {
                  refsBlocked: [...refsBlocked, ...invalidReferences(result.config, refsBlocked, result.titlePins)],
              },
              acknowledged: false,
          };
    const refused = replacing?.() ?? null;
    if (refused) return refused;
    const text = JSON.stringify({ ...result.config, ...(imported ? { imported } : {}) }, null, 2);
    if (!importTitlePins(result.titlePins)) return failure('write-failed', 'the title pins could not be saved');
    const written = storage.writeIfAbsent(text);
    if (written.outcome === 'failed') return failure('write-failed', 'config.json could not be saved');
    if (written.outcome === 'exists') {
        return written.current
            ? { ok: true, kind: 'adopted', text: written.current }
            : failure('write-failed', 'config.json could not be read');
    }
    // The marker keeps a copy of the record (a recovery leaves the one it has): a lost configuration gets its report back.
    whenStored(
        written,
        () => markImportDone(recovering ? undefined : imported, recovering ? 'restore' : 'import'),
        onLateFailure,
    );
    return {
        ok: true,
        kind: recovering ? 'recovered' : 'imported',
        text,
        ...(written.landed ? { landed: written.landed } : {}),
    };
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
        return readFailure(error);
    }
};

/** Whether `settings.json` can be read (it may not exist: that is readable as nothing). */
const canRead = (): boolean => {
    try {
        legacyStorage.readRaw();
        return true;
    } catch {
        return false;
    }
};

/**
 * Read `settings.json` and import it, or note that a fresh install has none.
 */
const importFromLegacyFile = (onLateFailure: LateFailure): ImportOutcome => {
    const legacy = readLegacyText();
    if (!legacy.ok) return legacy;
    if (legacy.raw === null) {
        // A settings.json that shows up later must not import silently.
        markImportDone(null);
        return { ok: true, kind: 'fresh' };
    }
    return importLegacyText(legacy.raw, onLateFailure);
};

/**
 * What a load does when the configuration is gone although the import has run and the mirror has written
 * `settings.json` since: that file is current, so the configuration is restored from it (without a report: it is no
 * news to the user). There is nothing to do when there is no `settings.json` either.
 */
const recoverFromMirror = (onLateFailure: LateFailure): ImportOutcome => {
    const legacy = readLegacyText();
    if (!legacy.ok) return legacy;
    if (legacy.raw === null) return { ok: true, kind: 'skipped' };
    return importLegacyText(legacy.raw, onLateFailure, { recovering: true });
};

/**
 * What a load does when there is no configuration: import `settings.json` the first time, restore the configuration
 * from it once the import has run and the mirror has written it (a missing configuration; a damaged one is set aside
 * first, see `recoverFromMirror`), and leave the rest (a set-aside configuration, or a marker with no mirror yet) to
 * the user's explicit import. Runs under the import lock; a configuration another process saved while it waited is
 * adopted.
 */
const importWhenAbsent = (onLateFailure: LateFailure): ImportOutcome =>
    underImportLock(() => {
        const existing = storage.readRaw();
        if (existing) return { ok: true, kind: 'adopted', text: existing };
        if (isImportMarked())
            return isMirrorStarted() ? recoverFromMirror(onLateFailure) : { ok: true, kind: 'skipped' };
        if (storage.hasQuarantined()) return { ok: true, kind: 'skipped' };
        return importFromLegacyFile(onLateFailure);
    });

/**
 * Write a default configuration and the marker. `settings.json` is set aside first (as `settings.json.original`, or where
 * that is taken as a copy of its own named by the time; `onKept` is told where, or in the Android window, where it will
 * be, once it has landed), before anything is mirrored over it;
 * where it cannot be set aside nothing is written. A configuration that is there already is left as it is.
 */
const startFreshConfig = (
    onLateFailure: LateFailure,
    onKept: (kept: string | Promise<string | null>) => void,
    onUnreadable: () => boolean,
): ImportOutcome =>
    underImportLock(() => {
        const existing = storage.readRaw();
        if (existing) return { ok: true, kind: 'adopted', text: existing };
        // A settings.json that cannot be read cannot be kept either: nothing is set aside, and the defaults are written
        // (the mirror never writes over a file it cannot read).
        const readable = canRead();
        // Left as it is, it must be set aside before anything is mirrored over it once it can be read, in any process: if that
        // cannot be recorded, nothing is started (a promise only this process remembers is not one).
        if (!readable && !onUnreadable()) {
            return failure('write-failed', 'the set-aside of settings.json could not be recorded');
        }
        const aside: ReturnType<typeof setAsideLegacy> = readable ? setAsideLegacy() : { ok: true };
        if (!aside.ok) return failure('write-failed', `settings.json could not be set aside: ${aside.error}`);
        // (Nothing is kept when there was no settings.json.)
        const kept = aside.landed ?? aside.kept;
        if (kept !== undefined) onKept(kept);
        const written = storage.writeIfAbsent(JSON.stringify(getDefaultSettings(), null, 2));
        if (written.outcome === 'failed') return failure('write-failed', 'config.json could not be saved');
        whenStored(written.outcome === 'saved' ? written : {}, () => markImportDone(null, 'fresh'), onLateFailure);
        return { ok: true, kind: 'fresh', ...(readable ? {} : { unreadable: true as const }) };
    });

/** The text of the copy kept of the settings.json that did not import (see importOnRequest). */
const readCopyText = (copy: string): { ok: true; raw: string | null } | ImportFailure => {
    try {
        return { ok: true, raw: legacyStorage.readCopy(copy) };
    } catch (error) {
        return readFailure(error);
    }
};

/**
 * Import `settings.json` on request, whatever the marker and a set-aside configuration say (the automatic import ran,
 * or was refused, and this is the user's call). With `setAside` the configuration in use is kept apart the way a
 * damaged one is (`config.json.corrupt-<time>`, and `setAside` is told where) once `settings.json` has converted;
 * without it a configuration that is there is left as it is. A `settings.json` that cannot be converted leaves the
 * configuration as it is. `copy`: the path of the copy kept of an unimportable `settings.json` in this episode (the
 * file the user was told to fix): the text comes from it, else from `settings.json`.
 */
const importOnRequest = (
    onLateFailure: LateFailure,
    setAside: ((path: string) => void) | null,
    copy: string | null,
): ImportOutcome =>
    underImportLock(() => {
        const existing = storage.readRaw();
        if (existing && !setAside) return { ok: true, kind: 'adopted', text: existing };
        const legacy = copy === null ? readLegacyText() : readCopyText(copy);
        if (!legacy.ok) return legacy;
        if (legacy.raw === null) return failure('unreadable', 'settings.json does not exist');
        return importLegacyText(legacy.raw, onLateFailure, {
            replacing:
                existing && setAside
                    ? () => {
                          const moved = storage.quarantineRaw(existing);
                          if (moved.ok) setAside(moved.path);
                          return moved.ok ? null : failure('unreadable', moved.error);
                      }
                    : undefined,
        });
    });

/** Import `settings.json` again after an import (or a re-import) failed, as the explicit import it was. */
const retryLegacyImport = (onLateFailure: LateFailure): ImportOutcome => importOnRequest(onLateFailure, null, null);

/**
 * Import `settings.json` again over the configuration in use, which is set aside (`setAside` is told where). `copy`: the
 * path of the copy kept of the settings.json that did not import in this episode, which the user fixed in place and is
 * the one to import; a copy of an earlier episode is never taken for it.
 */
const reimportLegacyFile = (
    onLateFailure: LateFailure,
    setAside: (path: string) => void,
    copy: string | null,
): ImportOutcome => importOnRequest(onLateFailure, setAside, copy);

export type { ImportFailure, ImportOutcome };
export { importWhenAbsent, reimportLegacyFile, retryLegacyImport, startFreshConfig };
