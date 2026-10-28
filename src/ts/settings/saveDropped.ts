/**
 * Whether a settings save of the app window was given up: its change is in no store (and the cache is back to what is
 * stored, unless a later write is queued), and `droppedAfter` is the last write issued by then. Cleared by the next
 * write issued after that one that lands.
 *
 * The state is shared by every settings file (`createSettingsFile` in storage.ts; only the configuration reports
 * dropped saves) and by the facade's recovery read. storage.ts re-exports the getters, so callers keep importing them
 * from `settings/storage`.
 */

/**
 * Why a settings save of the app window was given up: the background service kept changing the settings (`conflict`),
 * the blob is past the size the native store takes (`too-large`), or the store refused or failed it (`storage`).
 */
export type SaveDroppedCause = 'conflict' | 'too-large' | 'storage' | 'logout-lost';

let saveDropped = false;
let droppedAfter = 0;
// How many saves were given up in this process: each one is a notice of its own, so a repeat of the same cause is told
// apart from the one a window already showed.
let droppedSerial = 0;
let droppedCause: SaveDroppedCause = 'storage';
let saveDroppedListener: (() => void) | null = null;

// The cause of a save that threw: the code the native plugin rejected with (`too-large`), or the one a save that lost
// to the other writer on every attempt carries (`conflict`); anything else is the store's failure.
export const causeOf = (err: unknown): SaveDroppedCause => {
    const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
    return code === 'too-large' || code === 'conflict' ? code : 'storage';
};

// A change of the user's that is given up is a notice of its own, even when it repeats the cause of the one reported: the
// window shows it again (`again`). A write the app issues itself (the import's, which a load with no configuration
// makes) reports a repeat once, or a store that refuses every write would make the window read, try and report in
// a loop.
export const setSaveDropped = (dropped: boolean, cause: SaveDroppedCause = 'storage', again = false): void => {
    if (saveDropped === dropped && (!dropped || (droppedCause === cause && !again))) return;
    if (dropped) droppedSerial++;
    saveDropped = dropped;
    droppedCause = cause;
    saveDroppedListener?.();
};

/** Whether a settings save of the app window was given up, and its change is not in the stored settings. */
export const isSaveDropped = (): boolean => saveDropped;

/** Why the save reported by {@link isSaveDropped} was given up (`storage` while none is). */
export const getSaveDroppedCause = (): SaveDroppedCause => droppedCause;

/** How many saves were given up so far: the one reported by {@link isSaveDropped} is the latest. */
export const getSaveDroppedSerial = (): number => droppedSerial;

/**
 * Tells `listener` whenever {@link isSaveDropped} changes, so a window can re-read the settings (the one subscriber is
 * replaced by the next).
 */
export const onSaveDroppedChange = (listener: (() => void) | null): void => {
    saveDroppedListener = listener;
};

/** The last write issued by the time a save was given up: a write with a serial past it clears the state again. */
export const getDroppedAfter = (): number => droppedAfter;

/** Records the write that was given up, so the writes issued after it can tell whether they clear the state. */
export const markDroppedAfter = (serial: number): void => {
    droppedAfter = serial;
};

/**
 * Forgets a dropped save without telling anyone: `saveDropped` goes back to false and the cause to `storage`, while
 * `droppedSerial` and `droppedAfter` stay as they are (the given-up save keeps its serial) and the listener hears
 * nothing — a discard is the app's own doing, not a change of the user's to report.
 */
export const resetSaveDropped = (): void => {
    saveDropped = false;
    droppedCause = 'storage';
};

/**
 * What a Capacitor write needs from this module to report a given-up save; passed to the write helpers in
 * settingsFileCapacitor.ts by `createSettingsFile` (files whose saves are not reported get `null`).
 */
export type DroppedSaveOps = {
    getAfter: typeof getDroppedAfter;
    markAfter: typeof markDroppedAfter;
    setDropped: typeof setSaveDropped;
    causeOf: typeof causeOf;
};
