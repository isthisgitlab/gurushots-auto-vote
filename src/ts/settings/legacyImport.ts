/**
 * The import of a `settings.json` into `config.json`, and what surrounds it: the lock it runs under, the marker it
 * writes, and the explicit recovery paths (start fresh, retry). The conversion itself is the frozen pipeline in
 * importV1/; this module only decides when it runs and puts down its result. `settings.json` is read as text and never
 * goes through the live load, and is never written here.
 */

import { errorMessage } from '../errorMessage';
import { isPlainObject } from '../plainObject';
import { getDefaultSettings } from './defaults';
import { importV1Settings } from './importV1';
import { withImportedTimezone } from './formatOneTimezone';
import { isImportMarked, markImportDone } from './importMarker';
import { invalidReferences } from './importReport';
import { schemaEntry } from './schema';
import { acquireSettingsLock } from './settingsLock';
import { legacyStorage, storage } from './storage';
import { importTitlePins } from './titlePins';

import type { ImportedV2 } from '../types/config';
import type { QueuedWriteOutcome } from './storage';

// The lock every import (and every start-fresh or retry) runs under: two processes sharing the user-data directory
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
 * What an import came to when it did not fail: `imported` (the converted configuration was saved); `fresh` (there was
 * no `settings.json`; the marker was written); `adopted` (the configuration is already there, another context or
 * process saved it first); `skipped` (the marker says the import has run, or a set-aside configuration says an import
 * must not run unasked). `text` is the configuration now stored; `landed` (the Android app window) says it is only
 * shown by the cache until its queued write lands, which it may not, and tells how that ends.
 */
type ImportDone =
    | { ok: true; kind: 'imported' | 'adopted'; text: string; landed?: Promise<QueuedWriteOutcome> }
    | { ok: true; kind: 'fresh' | 'skipped' };

type ImportOutcome = ImportDone | ImportFailure;

/** What hears of an import that looked done and then failed to be stored (see whenStored). */
type LateFailure = (failure: ImportFailure) => void;

const failure = (reason: ImportFailureReason, detail: string): ImportFailure => ({ ok: false, reason, detail });

// The errors that pass by themselves: a file another program holds for a moment, a read that was interrupted, too many
// files open for the moment, a timeout, an input/output error (a disk or a share that comes back).
const TRANSIENT_ERRNOS = new Set(['EBUSY', 'EAGAIN', 'EINTR', 'EMFILE', 'ENFILE', 'ETIMEDOUT', 'EIO']);

/**
 * A failure to read `settings.json`: `unreadable` when it may pass by itself (a transient errno, or an error with no code
 * to tell), `inaccessible` when the file itself cannot be read (no permission, a directory in its place).
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

/**
 * Convert the text of `settings.json` and put the result down: the title pins, then `config.json`, and once that is
 * stored the marker. The conversion comes first and touches nothing, so a file that cannot be converted leaves
 * everything as it was.
 */
const importLegacyText = (raw: string, onLateFailure: LateFailure): ImportOutcome => {
    // The keys of the live schema are kept whether or not the frozen one knows them: the file holds what this app wrote.
    const converted = importV1Settings(raw, { keptKey: (key) => schemaEntry(key) !== undefined });
    if (!converted.ok) return failure(converted.code, converted.detail);
    const result = { ...converted, config: withImportedTimezone(converted.config) };
    const { refsBlocked } = result.report;
    const imported: ImportedV2 = {
        at: new Date().toISOString(),
        report: {
            refsBlocked: [...refsBlocked, ...invalidReferences(result.config, refsBlocked, result.titlePins)],
        },
        acknowledged: false,
    };
    const text = JSON.stringify({ ...result.config, imported }, null, 2);
    if (!importTitlePins(result.titlePins)) return failure('write-failed', 'the title pins could not be saved');
    const written = storage.writeIfAbsent(text);
    if (written.outcome === 'failed') return failure('write-failed', 'config.json could not be saved');
    if (written.outcome === 'exists') {
        return written.current
            ? { ok: true, kind: 'adopted', text: written.current }
            : failure('write-failed', 'config.json could not be read');
    }
    whenStored(written, () => markImportDone(), onLateFailure);
    return {
        ok: true,
        kind: 'imported',
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

/**
 * Read `settings.json` and import it, or note that a fresh install has none.
 */
const importFromLegacyFile = (onLateFailure: LateFailure): ImportOutcome => {
    const legacy = readLegacyText();
    if (!legacy.ok) return legacy;
    if (legacy.raw === null) {
        // A settings.json that shows up later must not import silently.
        markImportDone();
        return { ok: true, kind: 'fresh' };
    }
    return importLegacyText(legacy.raw, onLateFailure);
};

/**
 * What a load does when there is no configuration: import `settings.json` the first time, and leave the rest (the
 * marker says the import has run, or a set-aside configuration says it must not run unasked) to the defaults and the
 * user's explicit actions. Runs under the import lock; a configuration another process saved while it waited is
 * adopted.
 */
const importWhenAbsent = (onLateFailure: LateFailure): ImportOutcome =>
    underImportLock(() => {
        const existing = storage.readRaw();
        if (existing) return { ok: true, kind: 'adopted', text: existing };
        if (isImportMarked() || storage.hasQuarantined()) return { ok: true, kind: 'skipped' };
        return importFromLegacyFile(onLateFailure);
    });

/**
 * Write a default configuration and the marker. `settings.json` is left as it is: nothing imports it once the marker
 * says the import is done. A configuration that is there already is left as it is.
 */
const startFreshConfig = (onLateFailure: LateFailure): ImportOutcome =>
    underImportLock(() => {
        const existing = storage.readRaw();
        if (existing) return { ok: true, kind: 'adopted', text: existing };
        const written = storage.writeIfAbsent(JSON.stringify(getDefaultSettings(), null, 2));
        if (written.outcome === 'failed') return failure('write-failed', 'config.json could not be saved');
        if (written.outcome === 'exists') {
            return written.current
                ? { ok: true, kind: 'adopted', text: written.current }
                : failure('write-failed', 'config.json could not be read');
        }
        whenStored(written, () => markImportDone(), onLateFailure);
        return { ok: true, kind: 'fresh' };
    });

/** Import `settings.json` again after an import failed (or a start fresh did not go through), as the explicit import it is. */
const retryLegacyImport = (onLateFailure: LateFailure): ImportOutcome =>
    underImportLock(() => {
        const existing = storage.readRaw();
        if (existing) return { ok: true, kind: 'adopted', text: existing };
        const legacy = readLegacyText();
        if (!legacy.ok) return legacy;
        if (legacy.raw === null) return failure('unreadable', 'settings.json does not exist');
        return importLegacyText(legacy.raw, onLateFailure);
    });

export type { ImportFailure, ImportOutcome };
export { importWhenAbsent, retryLegacyImport, startFreshConfig };
