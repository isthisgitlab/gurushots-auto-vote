/**
 * The types `createSettingsFile` (storage.ts) and its helpers (settingsFileMethods.ts, settingsFileCapacitor.ts)
 * pass around: the options a settings file is created with, and the results of its writes and quarantine. The
 * per-file state and its write-protocol transitions live in settingsFileProtocol.ts. Type-only module — no runtime
 * code.
 */

/**
 * What moving an unusable settings value aside came to: where it went, or why it did not. Where the move is only queued
 * (the Android app window) `moved` says later whether it was made.
 */
export type QuarantineResult = { ok: true; path: string; moved?: Promise<boolean> } | { ok: false; error: string };

/**
 * How a queued Capacitor write ended: `written` (Preferences holds the text), `declined` (the compare-and-write found
 * another context's text there and took that: the write had nothing to do), or `failed` (nothing was written).
 */
export type QueuedWriteOutcome = 'written' | 'declined' | 'failed';

/**
 * What `writeIfAbsent` came to: it was saved, a value was already there (`current`), or the save failed. Where the save
 * is only queued (the Android app window) `landed` says how it ended, once it has: until then the text is shown by the
 * cache, and nothing that depends on it being stored may be done.
 */
export type WriteIfAbsentResult =
    | { outcome: 'saved'; landed?: Promise<QueuedWriteOutcome> }
    | { outcome: 'exists'; current: string | null }
    | { outcome: 'failed' };

/**
 * What a `write` came to: `ok` (the text is saved, or shown by the cache and queued), and, where the save is only
 * queued (the Android app window), `landed`, which says how the queued write ended once it has: until then the text is
 * shown by the cache, and nothing that depends on it being stored may be done.
 */
export type WriteResult = { ok: boolean; landed?: Promise<QueuedWriteOutcome> };

export type SettingsFileOptions = {
    /** the file in the user-data directory */
    fileName: string;
    /** the Preferences key (Capacitor) and the native bridge key (Android) */
    prefKey: string;
    /** the full path of the file, read at call time */
    filePath: () => string;
    /** a change made again on the text the other Android context saved meanwhile (a plain overwrite for `settings.json`) */
    rebase: (base: string | null, ours: string, theirs: string | null) => string;
    /** the Android service reaches the key through the bridge's own read/write pair, not through the keyed calls */
    dedicatedBridge: boolean;
    /** a given-up write of this file is reported to the window (the configuration's only) */
    reportsDroppedSaves: boolean;
};
