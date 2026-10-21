/**
 * The marker of the import (`v2-import.json`): it says that the import of `settings.json` has run — or that there was
 * nothing to import — so it runs once, and a `settings.json` that shows up later is not imported unasked. It lives in
 * a store of its own, outside `config.json`, so that deleting or setting aside the configuration never makes the next
 * start import `settings.json` again without being asked.
 *
 * The Android service writes it too, so every change is made on the marker as it is stored when the write is made
 * (see createJsonStore `shared`), never on the app window's cache.
 */

import * as logger from '../logger';
import * as runtime from '../runtime';
import { fileErrorMessage } from '../errorMessage';
import { isPlainObject } from '../plainObject';
import { underSettingsLock } from './settingsLock';
import { createJsonStore } from './storage';

const importMarkerStore = createJsonStore({
    fileName: 'v2-import.json',
    prefKey: 'gs_v2_import',
    atomic: true,
    shared: true,
});

const parseMarker = (raw: string | null): Record<string, unknown> | null => {
    if (raw === null) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        return isPlainObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

// Whether a marker that could not be read (no permission, a directory in its place) was said so already.
let unreadableSaid = false;

/** The stored marker text, or `unreadable` when the file cannot be read: said once, and read again each time. */
const readMarkerText = (): { text: string | null; unreadable: boolean } => {
    try {
        const text = importMarkerStore.readRaw();
        unreadableSaid = false;
        return { text, unreadable: false };
    } catch (error) {
        if (!unreadableSaid) {
            unreadableSaid = true;
            logger
                .withCategory('settings')
                .warning(
                    `The import marker could not be read, so it counts as done: ${fileErrorMessage(error) ?? 'unknown error'}`,
                );
        }
        return { text: null, unreadable: true };
    }
};

const MARKER_LOCK_WAIT_MS = 2000;
const MARKER_PENDING =
    'A change to the import marker could not be made yet (another process holds it, or the write was refused); it is tried again with the next save while the app runs, and not kept if the app is closed first';

/**
 * Runs a change of the marker. On a desktop, where two processes (the app and the CLI) share the file, it is made under
 * the settings lock, which an import holds for its own; `busy` is the answer when the other process held it
 * for the whole wait. Where the platform has no file lock (Android) the native compare-and-write decides.
 */
const underMarkerLock = <T>(run: () => T, busy: T): T =>
    runtime.isCapacitor() || runtime.isHeadlessService() ? run() : underSettingsLock(MARKER_LOCK_WAIT_MS, run, busy);

/**
 * Whether the import has run (or had nothing to import) on this device: the marker holds `importedAt` (or, from a
 * build that also kept the mirror's records, `mirrorStartedAt`). One that cannot be read is kept as the mark it
 * was: `settings.json` is not imported unasked over it.
 */
const isImportMarked = (): boolean => {
    const { text: raw, unreadable } = readMarkerText();
    if (unreadable) return true;
    if (raw === null) return false;
    const marker = parseMarker(raw);
    return marker === null || typeof marker.importedAt === 'string' || typeof marker.mirrorStartedAt === 'string';
};

type MarkerChange = (marker: Record<string, unknown> | null) => Record<string, unknown> | null;

/** What became of a change of the marker: `done` (made, or nothing to change), `queued` (the Android window's write is on its way), `failed` (not made). */
type MarkerResult = 'done' | 'queued' | 'failed';

// Changes that could not be made (the lock was held for the whole wait, the write was refused), in the order they were asked
// for, made again by flushPendingMarkerChanges at the next save while the app runs (they are not kept if it is
// closed first, which is said). Each one guards itself by the condition it served (it answers null, no change, when that
// has gone), so a replay never undoes what has been decided since.
const pendingChanges: MarkerChange[] = [];

const toText = (change: MarkerChange) => (current: string | null) => {
    const next = change(parseMarker(current));
    return next === null ? null : JSON.stringify(next, null, 2);
};

const attempt = (change: MarkerChange, firstTime: boolean): MarkerResult => {
    const update = toText(change);
    const keep = () => {
        pendingChanges.push(change);
        // Said once per change, not at every replay.
        if (firstTime) logger.withCategory('settings').warning(MARKER_PENDING);
    };
    const done = underMarkerLock(() => importMarkerStore.updateNow(update), 'failed' as const);
    if (done === 'failed') {
        keep();
        return 'failed';
    }
    if (done !== null) return 'done';
    // Queued (the Android app window): the outcome comes later.
    void importMarkerStore.updateThrough(update).then((outcome) => {
        if (outcome !== 'failed') return;
        keep();
    });
    return 'queued';
};

/**
 * Saves the marker `change` makes of the one stored when the write is made (`change` may run more than once and makes
 * the same change each time; it answers null to write nothing), and says what became of it. A change that could not be
 * made is kept (the default) and made again with the next save while the app runs, and said so in the log.
 */
const changeMarker = (change: MarkerChange): MarkerResult => attempt(change, true);

/**
 * Makes the changes of the marker that could not be made before, in order. Asked at each save.
 */
const flushPendingMarkerChanges = (): void => {
    for (const change of pendingChanges.splice(0)) attempt(change, false);
};

/**
 * Records that the import has run (or that there was nothing to import), keeping nothing else: the marker is the one
 * fact from then on. A marker that already says so is left as it is.
 */
const markImportDone = (): void => {
    const importedAt = new Date().toISOString();
    changeMarker((marker) => (marker !== null && typeof marker.importedAt === 'string' ? null : { importedAt }));
};

export { flushPendingMarkerChanges, importMarkerStore, isImportMarked, markImportDone };
