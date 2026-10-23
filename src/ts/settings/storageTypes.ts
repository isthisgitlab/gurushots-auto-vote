/**
 * The types `createSettingsFile` (storage.ts) and its Capacitor helpers (settingsFileCapacitor.ts) pass around: the
 * options a settings file is created with, the per-file state object they share, the per-file closures the factory
 * hands the method bodies (settingsFileMethods.ts), and the results of its writes and quarantine. Type-only module —
 * no runtime code.
 */

import type { HeadlessSettingsBridge } from './storeTransport';

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

/**
 * The per-file state `createSettingsFile` makes one of per call: the helpers in settingsFileCapacitor.ts take it as a
 * parameter and mutate it in place (two settings files exist, so none of this state may sit at module level).
 */
export type SettingsFileState = {
    /** Set by initializeAsync only; a write must not flip it, or hydration would be skipped. */
    capacitorInitialized: boolean;
    /** The text sync reads answer on Capacitor; also what the next compare-and-write is made from until it lands. */
    cachedJson: string | null;
    /** Whether a quarantined copy of this file exists in Preferences (the app window learns it when it hydrates). */
    hasBackupKey: boolean;
    /** What the app window knows Preferences to hold for the key: what it read, or saved last. */
    persistedJson: string | null;
    /** The text the Android service's JS last read from the native store: the text its next write is a change of. */
    headlessBase: string | null;
    /**
     * Serializes Capacitor write-behind so concurrent full-blob writes apply in issue order — an earlier write can
     * never resolve after a later one and clobber it. flush() awaits the tail so callers can guarantee durability
     * (e.g. before the WebView is suspended). The chain itself stays in the factory body.
     */
    writeChain: Promise<void>;
    /** Bumped by discard: a queued write finds the number changed on its turn and puts nothing down. */
    writeGeneration: number;
    /** Bumped by every write and by moving the stored value aside: a write that finds it moved on is not the latest. */
    writeSerial: number;
    /** Temp files an earlier crash left beside the file are swept on the first write. */
    swept: boolean;
};

/**
 * The per-file closures the factory hands the method bodies (settingsFileMethods.ts): what those bodies need besides
 * `state`, and the only reach they have at the factory's own wiring (the queue and the bridge are the factory's).
 */
export type SettingsFileDeps = {
    prefKey: string;
    /** the full path of the file, read at call time */
    filePath: () => string;
    /** a change made again on the text the other Android context saved meanwhile (a plain overwrite for `settings.json`) */
    rebase: SettingsFileOptions['rebase'];
    /** the bridge pair this file's Android reads and writes go through, resolved per call */
    bridge: () => HeadlessSettingsBridge | undefined;
    /** sweeps the temp files an earlier crash left beside the file, on the first write only */
    sweepOnce: (file: string) => void;
    /** queues a Capacitor compare-and-write of a change of the cache (the factory owns the chain) */
    queueWrite: (update: (stored: string | null) => string | null, userChange: boolean) => Promise<QueuedWriteOutcome>;
};
