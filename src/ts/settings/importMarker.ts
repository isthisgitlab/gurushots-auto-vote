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

import * as logger from '../logger';
import * as runtime from '../runtime';
import { isPlainObject } from '../plainObject';
import { isImportedRecord } from './loadValidation';
import { underSettingsLock } from './settingsLock';
import { createJsonStore } from './storage';

import type { ImportedV2 } from '../types/config';

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

const readMarker = (): Record<string, unknown> | null => parseMarker(importMarkerStore.readRaw());

const MARKER_LOCK_WAIT_MS = 2000;
const MARKER_PENDING =
    'A change to the import marker could not be made yet (another process holds it, or the write was refused); it is tried again with the next save or start while the app runs, and not kept if the app is closed first';

/**
 * Runs a change of the marker. On a desktop, where two processes (the app and the CLI) share the file, it is made under
 * the settings lock, which the mirror and the import hold for theirs; `busy` is the answer when the other process held it
 * for the whole wait. Where the platform has no file lock (Android) the native compare-and-write decides.
 */
const underMarkerLock = <T>(run: () => T, busy: T): T =>
    runtime.isCapacitor() || runtime.isHeadlessService() ? run() : underSettingsLock(MARKER_LOCK_WAIT_MS, run, busy);
/**
 * Whether the import has run (or had nothing to import) on this device. A marker made only to hold a record of a sign-out
 * says nothing of it (a never-imported install still imports); one that cannot be read as a marker is kept as the mark it
 * was.
 */
const isImportMarked = (): boolean => {
    const raw = importMarkerStore.readRaw();
    if (raw === null) return false;
    const marker = parseMarker(raw);
    return marker === null || typeof marker.importedAt === 'string';
};

type MarkerChange = (marker: Record<string, unknown> | null) => Record<string, unknown> | null;

/** What became of a change of the marker: `done` (made, or nothing to change), `queued` (the Android window's write is on its way), `failed` (not made). */
type MarkerResult = 'done' | 'queued' | 'failed';

// Changes that could not be made (the lock was held for the whole wait, the write was refused), in the order they were asked
// for, made again by flushPendingMarkerChanges at the next save or start while the app runs (they are not kept if it is
// closed first, which is said). Each one guards itself by the condition it served (it answers null, no change, when that
// has gone), so a replay never undoes what has been decided since.
type PendingChange = { change: MarkerChange; onLost?: () => void };
const pendingChanges: PendingChange[] = [];

const toText = (change: MarkerChange) => (current: string | null) => {
    const next = change(parseMarker(current));
    return next === null ? null : JSON.stringify(next, null, 2);
};

const attempt = (entry: PendingChange, keepPending: boolean, firstTime: boolean): MarkerResult => {
    const { change, onLost } = entry;
    const update = toText(change);
    const keep = () => {
        if (!keepPending) return;
        pendingChanges.push(entry);
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
        onLost?.();
    });
    return 'queued';
};

/**
 * Saves the marker `change` makes of the one stored when the write is made (`change` may run more than once and makes
 * the same change each time; it answers null to write nothing), and says what became of it. A change that could not be
 * made is kept (`keepPending`, the default) and made again with the next save or start while the app runs, and said so in
 * the log; one that is not (a sign-out the caller then refuses) is only reported. A queued write that fails later is
 * handled the same.
 *
 * @param onLost - told if a queued write fails afterwards
 */
const changeMarker = (
    change: MarkerChange,
    { keepPending = true, onLost }: { keepPending?: boolean; onLost?: () => void } = {},
): MarkerResult => attempt({ change, onLost }, keepPending, true);

/**
 * Makes the changes of the marker that could not be made before, in order. Asked at each save and at the start.
 */
const flushPendingMarkerChanges = (): void => {
    for (const entry of pendingChanges.splice(0)) attempt(entry, true, false);
};

/**
 * Records that the import has run, keeping what the marker already says (that the mirror has started). `imported` is the
 * record of the import the marker keeps a copy of, so a configuration restored from `settings.json` has its report
 * back: a record sets it, `null` says there is none, and leaving it out keeps the one that is there.
 */
const markImportDone = (imported?: ImportedV2 | null, from?: ConfigSource): void => {
    const importedAt = new Date().toISOString();
    changeMarker((marker) => {
        const { importedRecord, ...rest } = marker ?? {};
        const record = imported === undefined ? importedRecord : (imported ?? undefined);
        return {
            ...rest,
            importedAt,
            ...(record === undefined ? {} : { importedRecord: record }),
            ...(from === undefined ? {} : { configFrom: from }),
        };
    });
};

/** What made the configuration last written by an import: the import of settings.json, a restore of a lost configuration from it, or a fresh start. */
type ConfigSource = 'import' | 'restore' | 'fresh';

/** What made the stored configuration, as the marker records it (null: not recorded). */
const configSource = (): ConfigSource | null => {
    const from = readMarker()?.configFrom;
    return from === 'import' || from === 'restore' || from === 'fresh' ? from : null;
};

/** The record of the import the marker keeps a copy of, or null. */
const keptImportedRecord = (): ImportedV2 | null => {
    const record = readMarker()?.importedRecord;
    return isImportedRecord(record) ? record : null;
};

/** Keeps a copy of the import record that changed (the report was acknowledged); nothing when there is no marker. */
const keepImportedRecord = (record: ImportedV2): void =>
    void changeMarker((marker) => (marker === null ? null : { ...marker, importedRecord: record }));

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
    void changeMarker((marker) => (marker === null ? null : { ...marker, unimportableCopy: location }));

/** Forgets the recorded copy (the episode is over: it was re-imported, a fresh start was made, or another began). */
const forgetUnimportableCopy = (): void => {
    // Only the copy that is recorded now: a change that is made later (a replay) forgets that one and no newer.
    const seen = readMarker()?.unimportableCopy;
    if (seen === undefined) return;
    dropFieldIf('unimportableCopy', seen);
};

/**
 * Records that a sign-out was saved and the copies kept of the settings files are to lose the sign-in they hold: written
 * before they are rewritten and kept until every one has been (a rewrite that fails is retried at the next start or save);
 * where the background service saved it, until the app window has cleared the copies in Preferences the service cannot
 * list (`gurushots-config_corrupt-…`, …). Each sign-out records a record of its own (a new value), so that whoever clears
 * it clears exactly the one it saw to. A missing marker is made, holding only this record.
 *
 * @returns the record
 */
const markSignOutScrubPending = (): string => {
    const record = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Not kept pending: the copies are cleared right after, and a replay later would only record a clearing already done.
    changeMarker((marker) => ({ ...marker, signOutScrubPending: record }), { keepPending: false });
    return record;
};

/**
 * Forgets the record `seen` (what the app window read, and cleared the copies for), and no other: a sign-out the service
 * recorded since is still owed. Where the change is made on the marker as it is stored (a desktop, the service) a marker
 * that does not hold `seen` is left alone. In the app window the change is first made on its cache of the marker, which
 * may be behind the service: a change that declines there never sees what is stored, so it leaves the marker as it is
 * (a write of the same text), and the compare-and-write finds the stored one and makes the change again on it.
 */
const clearSignOutScrubPending = (seen: string): void => void dropFieldIf('signOutScrubPending', seen);

/**
 * A sign-out owed to the configuration a restore is about to bring (made while it waited). It names the sign-in it signs
 * out by fingerprint (the per-field hashes of the sign-in the mirror last wrote, never the values), so applying it
 * blanks a sign-in only where its token is one of those: a later login has another token and is never touched, whichever
 * process saw it, in whatever order the stores land. A record that applies to nothing is harmless.
 */
type OwedSignOut = { id: string; at: string; fingerprints: string[] };

const isOwedSignOut = (value: unknown): value is OwedSignOut =>
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    typeof value.at === 'string' &&
    Array.isArray(value.fingerprints) &&
    value.fingerprints.every((fingerprint) => typeof fingerprint === 'string');

/**
 * Records a sign-out that is owed to the configuration a restore is about to bring: when it lands, in any process, the
 * sign-in the record names is signed out. A missing marker is made for it.
 *
 * @param fingerprints - of the sign-in being signed out (see mirroredSignIns)
 * @returns the record; null when the marker could not be written, so that the sign-out is refused (where the write is only
 *   queued, the Android app window, it is taken as recorded, and `onLost` is told if it then fails)
 */
const markSignOutOwed = (
    fingerprints: readonly string[],
    onLost?: (record: OwedSignOut) => void,
): OwedSignOut | null => {
    const record: OwedSignOut = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        at: new Date().toISOString(),
        fingerprints: [...fingerprints],
    };
    // Not kept pending when it cannot be made: the sign-out is refused then, and must not be recorded later.
    const result = recordInMarker('signOutOwed', record, { keepPending: false, onLost: () => onLost?.(record) });
    return result === 'failed' ? null : record;
};

/**
 * Puts a field in the marker (a missing marker is made for it).
 *
 * @returns what became of it; `failed` when the marker could not be written (where the write is only queued, the Android
 *   app window, it is `queued`, and `onLost` is told if it then fails)
 */
const recordInMarker = (
    field: string,
    value: unknown,
    options: { keepPending?: boolean; onLost?: () => void },
): MarkerResult => changeMarker((marker) => ({ ...marker, [field]: value }), options);

/**
 * Records that a settings.json that could not be read was left as it is by Start fresh, and is to be set aside before
 * anything is mirrored over it once it can be read.
 *
 * @returns the record's id; null when it could not be recorded
 */
const markLegacyAsideOwed = (onLost?: () => void): string | null => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return recordInMarker('legacyAsideOwed', id, { keepPending: false, onLost }) === 'failed' ? null : id;
};

/** The record of a settings.json left as it is by Start fresh that is still to be set aside, or null. */
const legacyAsideOwedStored = (): string | null => {
    const id = readMarker()?.legacyAsideOwed;
    return typeof id === 'string' ? id : null;
};

/**
 * Drops `field` while `held` says it still holds the value the change was meant for (a change that is made later, or a
 * replay, leaves a newer value alone). In the app window the change is first made on its cache of the marker, which may be
 * behind the service: a change that declines there never sees what is stored, so it leaves the marker as it is (a write of
 * the same text), and the compare-and-write finds the stored one and makes the change again on it.
 */
const dropFieldWhen = (
    field: string,
    held: (value: unknown) => boolean,
    options?: { keepPending?: boolean },
): MarkerResult =>
    changeMarker((marker) => {
        if (marker === null) return null;
        if (!held(marker[field])) return runtime.isCapacitor() && !runtime.isHeadlessService() ? marker : null;
        return Object.fromEntries(Object.entries(marker).filter(([key]) => key !== field));
    }, options);

const dropFieldIf = (field: string, expected: unknown): MarkerResult =>
    dropFieldWhen(field, (value) => value === expected);

/** Forgets that a set-aside is owed, while the record is still the one given (it was made, or Start fresh did not happen). */
const clearLegacyAsideOwed = (id: string): void => {
    dropFieldIf('legacyAsideOwed', id);
};

/** Records that the copies kept of the settings files were cleared of the sign-in they held (after a sign-out). */
const noteCopiesScrubbed = (): void => {
    // The time is the clearing's, taken now, not the time of a replay.
    const at = new Date().toISOString();
    changeMarker((marker) => ({ ...marker, copiesScrubbedAt: at }));
};

/** When the copies were last cleared of the sign-in (ms since the epoch), or null. */
const copiesScrubbedAtStored = (): number | null => {
    const at = readMarker()?.copiesScrubbedAt;
    const time = typeof at === 'string' ? Date.parse(at) : Number.NaN;
    return Number.isNaN(time) ? null : time;
};

/** The record of a sign-out owed to a restore, or null. */
const signOutOwedStored = (): OwedSignOut | null => {
    const record = readMarker()?.signOutOwed;
    return isOwedSignOut(record) ? record : null;
};

/**
 * Removes the owed sign-out `id`, and no other. Best effort and harmless to miss: a record that stays applies to nothing
 * once the sign-in it names is gone, so a refused or failed removal is not replayed.
 */
const clearSignOutOwed = (id: string): void => {
    dropFieldWhen('signOutOwed', (value) => isOwedSignOut(value) && value.id === id, { keepPending: false });
};

/** The record of a sign-out whose copies are not all cleared yet, read from the marker file (a desktop); null when none. */
const signOutScrubPendingStored = (): string | null => {
    const record = readMarker()?.signOutScrubPending;
    return typeof record === 'string' ? record : null;
};

/** The record of the sign-out the app window owes a clearing for, read from what Preferences holds (the service wrote it); null when none. */
const signOutScrubPendingNow = async (): Promise<string | null> => {
    const record = parseMarker(await importMarkerStore.peekStored())?.signOutScrubPending;
    return typeof record === 'string' ? record : null;
};

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
    clearLegacyAsideOwed,
    clearSignOutOwed,
    clearSignOutScrubPending,
    configSource,
    flushPendingMarkerChanges,
    copiesScrubbedAtStored,
    importMarkerStore,
    isImportMarked,
    isMirrorStarted,
    forgetUnimportableCopy,
    isMirrorStartedNow,
    keepImportedRecord,
    keptUnimportableCopy,
    keptImportedRecord,
    legacyAsideOwedStored,
    markLegacyAsideOwed,
    markImportDone,
    markMirrored,
    markMirrorPending,
    markMirrorPendingQueued,
    markSignOutOwed,
    markSignOutScrubPending,
    noteCopiesScrubbed,
    mirroredSignIns,
    rememberUnimportableCopy,
    signOutOwedStored,
    signOutScrubPendingNow,
    signOutScrubPendingStored,
    mirroredSignInsNow,
};

export type { OwedSignOut };
