/**
 * The per-file state of a settings file (`createSettingsFile`, storage.ts, makes one per call) and the only module
 * its write protocol may be changed from: every assignment to `writeSerial`, `writeGeneration`, `cachedJson` and
 * `persistedJson` happens here, as one of the named transitions below, each doc comment stating the invariant it
 * maintains (two settings files exist, so none of the state may sit at module level). The consumers — the factory
 * bodies in storage.ts and the helpers in settingsFileMethods.ts, settingsFileCapacitor.ts and settingsFileNode.ts —
 * read the fields and change them only by calling a transition. The module is computation only: no IO, no imports at
 * all (in particular not storage.ts), so a test's `jest.mock('settings/storage')` keeps ruling over every consumer.
 */

/**
 * The per-file state `createSettingsFile` makes one of per call: the factory bodies and the helpers in
 * settingsFileMethods.ts / settingsFileCapacitor.ts take it as a parameter, and its write-protocol fields change
 * only through the transitions below.
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
 * Issues the serial of a queued operation (a write-behind write, or the move of a damaged value to its backup key):
 * every queued operation gets the next serial, so one that later finds the serial moved on knows it is no longer the
 * latest and must not touch what the cache shows.
 */
export const issueQueuedWrite = (state: SettingsFileState): number => {
    state.writeSerial += 1;
    return state.writeSerial;
};

/**
 * Stages a change in the cache ahead of the write that will carry it, so synchronous reads answer the change at
 * once; whether it is stored stays what the queued write's outcome makes of it (`notePersisted` when it lands,
 * `restoreCacheToPersisted` when it fails).
 */
export const stageWrite = (state: SettingsFileState, data: string): void => {
    state.cachedJson = data;
};

/**
 * A queued compare-and-write ended, and Preferences now holds `saved`: that becomes the known stored text, and the
 * cache follows it only when the write that ended was the latest issued — an earlier one must not overwrite what a
 * later write staged in the cache.
 */
export const notePersisted = (state: SettingsFileState, saved: string | null, serial: number): void => {
    state.persistedJson = saved;
    if (serial === state.writeSerial) state.cachedJson = saved;
};

/**
 * A queued write threw and stored nothing: the cache goes back to what is stored, so it never shows a change that
 * was not saved — but only when the failed write was the latest issued, since a later one owns the cache now.
 */
export const restoreCacheToPersisted = (state: SettingsFileState, serial: number): void => {
    if (serial === state.writeSerial) state.cachedJson = state.persistedJson;
};

/**
 * The boot-time hydration of the app window's file: cache and known stored text both become the value read from
 * Preferences (`value` is null where no entry exists), or both null when the read failed — either way the file
 * starts from a cache that says exactly what is known to be stored.
 */
export const hydrate = (state: SettingsFileState, value: string | null): void => {
    state.cachedJson = value;
    state.persistedJson = value;
};

/**
 * An unusable stored value is moved aside: the cache stops showing it at once, and the backup is recorded so the
 * window knows a copy exists. Answers whether one did before, for the caller to put back if the move fails
 * (`undoQuarantine`).
 */
export const beginQuarantine = (state: SettingsFileState): boolean => {
    state.cachedJson = null;
    const hadBackupKey = state.hasBackupKey;
    state.hasBackupKey = true;
    return hadBackupKey;
};

/**
 * The queued move to the backup key landed: the value was copied there and removed from its own key, so
 * Preferences no longer holds anything for it.
 */
export const noteMovedAside = (state: SettingsFileState): void => {
    state.persistedJson = null;
};

/**
 * The move to the backup key failed — the value was not moved: Preferences still holds it, so the cache shows what
 * is stored again (a write queued meanwhile, a restore, cannot change what is stored over the damaged value, and
 * must not be shown in place of it), and the copy is not recorded.
 */
export const undoQuarantine = (state: SettingsFileState, hadBackupKey: boolean): void => {
    state.cachedJson = state.persistedJson;
    state.hasBackupKey = hadBackupKey;
};

/**
 * Every write still queued is given up (a discard): the generation moves on, so each queued write finds it changed
 * on its turn and puts nothing down, and both texts are forgotten — nothing of this file is known anymore.
 */
export const discard = (state: SettingsFileState): void => {
    state.writeGeneration += 1;
    state.cachedJson = null;
    state.persistedJson = null;
    state.hasBackupKey = false;
};
