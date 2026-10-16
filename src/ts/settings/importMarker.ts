/**
 * The marker of the import (`v2-import.json`): it exists once the import has run, or once there was no `settings.json`
 * to import. It lives in a store of its own, outside `config.json`, so that deleting or setting aside the
 * configuration never makes the next start import `settings.json` again without being asked. It also says whether the
 * mirror has started writing `settings.json`: from then on the file is the app's own output, and no copy of it is kept
 * as `settings.json.original`; and it keeps a fingerprint of the sign-in the mirror last wrote there (never the
 * sign-in itself), so a sign-in an older build changed in `settings.json` can be told from one the app wrote.
 *
 * The Android service writes it too, so every change is made on the marker as it is stored when the write is made
 * (see createJsonStore `shared`), never on the app window's cache.
 */

import { isPlainObject } from '../plainObject';
import { isImportedRecord } from './loadValidation';
import { createJsonStore } from './storage';

import type { ImportedV2 } from '../types/config';

const importMarkerStore = createJsonStore({
    fileName: 'v2-import.json',
    prefKey: 'gs_v2_import',
    atomic: true,
    shared: true,
});

/** Whether the import has run (or had nothing to import) on this device. */
const isImportMarked = (): boolean => importMarkerStore.readRaw() !== null;

const parseMarker = (raw: string | null): Record<string, unknown> | null => {
    if (raw === null) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        return isPlainObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

const readMarker = (): Record<string, unknown> | null => parseMarker(importMarkerStore.readRaw());

/**
 * Saves the marker `change` makes of the one stored when the write is made (`change` may run more than once and makes
 * the same change each time; it answers null to write nothing). A write that fails is logged by the store.
 */
const changeMarker = (change: (marker: Record<string, unknown> | null) => Record<string, unknown> | null): void => {
    void importMarkerStore.updateThrough((current) => {
        const next = change(parseMarker(current));
        return next === null ? null : JSON.stringify(next, null, 2);
    });
};

/**
 * Records that the import has run, keeping what the marker already says (that the mirror has started). `imported` is the
 * record of the import the marker keeps a copy of, so a configuration restored from `settings.json` has its report
 * back: a record sets it, `null` says there is none, and leaving it out keeps the one that is there.
 */
const markImportDone = (imported?: ImportedV2 | null): void => {
    const importedAt = new Date().toISOString();
    changeMarker((marker) => {
        const { importedRecord, ...rest } = marker ?? {};
        const record = imported === undefined ? importedRecord : (imported ?? undefined);
        return { ...rest, importedAt, ...(record === undefined ? {} : { importedRecord: record }) };
    });
};

/** The record of the import the marker keeps a copy of, or null. */
const keptImportedRecord = (): ImportedV2 | null => {
    const record = readMarker()?.importedRecord;
    return isImportedRecord(record) ? record : null;
};

/** Keeps a copy of the import record that changed (the report was acknowledged); nothing when there is no marker. */
const keepImportedRecord = (record: ImportedV2): void =>
    changeMarker((marker) => (marker === null ? null : { ...marker, importedRecord: record }));

/** Whether the mirror has written `settings.json` on this device (see formatOneMirror.ts). */
const isMirrorStarted = (): boolean => typeof readMarker()?.mirrorStartedAt === 'string';

/** `isMirrorStarted` for the Android app window, whose cache may be behind the marker the service wrote. */
const isMirrorStartedNow = async (): Promise<boolean> =>
    typeof parseMarker(await importMarkerStore.peekStored())?.mirrorStartedAt === 'string';

/**
 * Where the `settings.json` that did not import was set aside in the last episode of a damaged configuration (a path; the
 * preference key on Android): the file the user is told to fix, which a re-import in another process, or after a
 * restart, must find again. Null when none is recorded.
 */
const keptUnimportableCopy = (): string | null => {
    const location = readMarker()?.unimportableCopy;
    return typeof location === 'string' ? location : null;
};

/** Records where the unimportable `settings.json` was set aside; nothing when there is no marker to record it in. */
const rememberUnimportableCopy = (location: string): void =>
    changeMarker((marker) => (marker === null ? null : { ...marker, unimportableCopy: location }));

/** Forgets the recorded copy (the episode is over: it was re-imported, a fresh start was made, or another began). */
const forgetUnimportableCopy = (): void =>
    changeMarker((marker) => {
        if (marker === null || !Object.hasOwn(marker, 'unimportableCopy')) return null;
        return Object.fromEntries(Object.entries(marker).filter(([key]) => key !== 'unimportableCopy'));
    });

/** The fingerprints a marker holds of the sign-in this build wrote to `settings.json`: the one it was about to write, and the last that landed. */
const signInsOf = (marker: Record<string, unknown> | null): string[] =>
    [marker?.signInPending, marker?.signInConfirmed].filter((fingerprint) => typeof fingerprint === 'string');

/**
 * The fingerprints of the sign-in this build wrote to `settings.json`, or was about to: `pending` is recorded right
 * before a mirror write and `confirmed` once it landed, so a `settings.json` that matches either was written by this
 * build, whichever of the two records failed.
 */
const mirroredSignIns = (): string[] => signInsOf(readMarker());

/** `mirroredSignIns` for the Android app window, whose cache may be behind the marker the service wrote. */
const mirroredSignInsNow = async (): Promise<string[]> => signInsOf(parseMarker(await importMarkerStore.peekStored()));

const pendingUpdate =
    (signInPending: string, held: string | null) =>
    (current: string | null): string | null => {
        const marker = parseMarker(current);
        // What `settings.json` holds now, when this build wrote it, stays known as the last that landed: it is not
        // forgotten when the one about to be written fails to land.
        return marker === null
            ? null
            : JSON.stringify(
                  { ...marker, signInPending, ...(held === null ? {} : { signInConfirmed: held }) },
                  null,
                  2,
              );
    };

/**
 * Records, right before the mirror writes `settings.json`, the sign-in it is about to write there; where the write is
 * made at once (a desktop, the background service).
 *
 * @param held - the fingerprint of the sign-in `settings.json` holds now, when this build wrote it (it becomes the confirmed one)
 * @returns false when it could not be recorded (the mirror then does not write); true also when there is no marker to record it in
 */
const markMirrorPending = (signInPending: string, held: string | null): boolean =>
    importMarkerStore.updateNow(pendingUpdate(signInPending, held)) !== 'failed';

/** `markMirrorPending` for the Android app window, which says once it is stored. */
const markMirrorPendingQueued = async (signInPending: string, held: string | null): Promise<boolean> =>
    (await importMarkerStore.updateThrough(pendingUpdate(signInPending, held))) !== 'failed';

/**
 * Records that the mirror has written `settings.json` (when it first did), and the fingerprint of the sign-in it holds
 * there, as the confirmed one. The pending record is cleared only when it is the one confirmed: another context's
 * (the Android service's, or the window's) is its own, and is not dropped by this one's confirmation. Nothing when
 * there is no marker to record it in, or when it says so already.
 */
const markMirrored = (signIn: string): void => {
    const mirrorStartedAt = new Date().toISOString();
    changeMarker((marker) => {
        if (marker === null) return null;
        if (
            typeof marker.mirrorStartedAt === 'string' &&
            marker.signInConfirmed === signIn &&
            marker.signInPending !== signIn
        )
            return null;
        const { signInPending, ...rest } = marker;
        return {
            ...rest,
            mirrorStartedAt: typeof marker.mirrorStartedAt === 'string' ? marker.mirrorStartedAt : mirrorStartedAt,
            ...(signInPending === undefined || signInPending === signIn ? {} : { signInPending }),
            signInConfirmed: signIn,
        };
    });
};

export {
    importMarkerStore,
    isImportMarked,
    isMirrorStarted,
    forgetUnimportableCopy,
    isMirrorStartedNow,
    keepImportedRecord,
    keptUnimportableCopy,
    keptImportedRecord,
    markImportDone,
    markMirrored,
    markMirrorPending,
    markMirrorPendingQueued,
    mirroredSignIns,
    rememberUnimportableCopy,
    mirroredSignInsNow,
};
