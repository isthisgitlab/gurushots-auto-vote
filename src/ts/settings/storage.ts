/**
 * Persistence transport for the settings.
 *
 * Electron / CLI: the configuration lives in a JSON file read/written synchronously through fs at
 * userData/config.json.
 *
 * Capacitor: the WebView has no fs and @capacitor/preferences is async-
 * only, so we hydrate an in-memory cache once at boot (initializeAsync)
 * and let all sync reads hit the cache. Writes mutate the cache
 * synchronously so consumers see the new value immediately, then fire
 * an async write-behind so the next launch sees the change.
 *
 * Two files go through the same transport (`createSettingsFile`): the configuration (`storage`: read, saved, set
 * aside when it is unusable) and `settings.json` (`legacyStorage`: read for the one-time import).
 *
 * @capacitor/preferences is lazy-required only inside isCapacitor()
 * guards so non-Capacitor bundles never resolve it. The generic JSON store
 * other stores are made with lives in jsonStore.ts and is re-exported here.
 */

import { sweepStaleTemps } from './atomicWrite';
import { listPreferenceKeys, removePreferenceKeys } from './capacitorPreferences';
import { createJsonStore, discardStores, refuseWrites, resumeWrites, settleStores } from './jsonStore';
import { rebaseConfigText } from './settingsMerge';
import {
    electronApp,
    getDefaultMockSetting,
    getEnvironmentInfo,
    getLegacySettingsPath,
    getSettingsPath,
    getUserDataPath,
} from './userDataPaths';
import {
    causeOf,
    getDroppedAfter,
    isSaveDropped,
    getSaveDroppedCause,
    getSaveDroppedSerial,
    markDroppedAfter,
    onSaveDroppedChange,
    resetSaveDropped,
    setSaveDropped,
} from './saveDropped';
import { CORRUPT_SUFFIX, failQueuedWrite, makeFileBridge, runQueuedWrite } from './settingsFileCapacitor';
import {
    discardMethod,
    hasQuarantinedMethod,
    initializeAsyncMethod,
    isLoadedMethod,
    isPersistedMethod,
    locationMethod,
    quarantineRawMethod,
    readRawMethod,
    writeIfAbsentMethod,
    writeMethod,
} from './settingsFileMethods';
import { issueQueuedWrite } from './settingsFileProtocol';

import type { DroppedSaveOps } from './saveDropped';
import type { SettingsFileState } from './settingsFileProtocol';
import type {
    QuarantineResult,
    QueuedWriteOutcome,
    SettingsFileOptions,
    WriteIfAbsentResult,
    WriteResult,
} from './storageTypes';

/** The Preferences key of the settings.json blob (what `settings.json` is on a desktop). */
const LEGACY_SETTINGS_KEY = 'gurushots-settings';
/** The Preferences key of the configuration (what `config.json` is on a desktop). */
const CONFIG_KEY = 'gurushots-config';

// A copy a `settings.json` that could not be imported was kept under by an older build: wiped with the rest.
const UNIMPORTABLE_SUFFIX = '_unimportable';

const createSettingsFile = (options: SettingsFileOptions) => {
    const { fileName, prefKey, filePath, rebase, dedicatedBridge, reportsDroppedSaves } = options;

    // The per-file state: one object per call. Its write-protocol fields (writeSerial, writeGeneration, cachedJson,
    // persistedJson) change only through the transitions in settingsFileProtocol.ts; this body and the helpers the
    // object is passed to (settingsFileCapacitor.ts, settingsFileMethods.ts, settingsFileNode.ts) read them and
    // change them through those. Two settings files exist, so none of it may sit at module level.
    const state: SettingsFileState = {
        capacitorInitialized: false,
        cachedJson: null,
        hasBackupKey: false,
        persistedJson: null,
        headlessBase: null,
        writeChain: Promise.resolve(),
        writeGeneration: 0,
        writeSerial: 0,
        swept: false,
    };

    // The dropped-save reporting of this file (the configuration's only), handed to the Capacitor write helpers.
    const droppedOps: DroppedSaveOps | null = reportsDroppedSaves
        ? { getAfter: getDroppedAfter, markAfter: markDroppedAfter, setDropped: setSaveDropped, causeOf }
        : null;

    // Temp files an earlier crash left beside the file are swept on the first write.
    const sweepOnce = (file: string) => {
        if (state.swept) return;
        state.swept = true;
        sweepStaleTemps(file);
    };

    const bridge = makeFileBridge(dedicatedBridge, prefKey);

    // Queues the write of a change of the cache: after the writes before it, as a compare-and-write. The chain itself
    // stays here; the bodies that run on a queued write's turn are runQueuedWrite and failQueuedWrite
    // (settingsFileCapacitor.ts).
    const queueCapacitorWrite = (
        update: (stored: string | null) => string | null,
        userChange: boolean,
    ): Promise<QueuedWriteOutcome> => {
        const issuedIn = state.writeGeneration;
        const serial = issueQueuedWrite(state);
        const ended = state.writeChain
            .then(() => runQueuedWrite(state, prefKey, droppedOps, update, issuedIn, serial))
            .catch((err: unknown) => failQueuedWrite(state, droppedOps, err, issuedIn, serial, userChange));
        state.writeChain = ended.then(() => undefined);
        return ended;
    };

    // Each method body takes the state and the explicit parts of the factory's wiring it needs (the queue and the
    // bridge are the factory's).
    return {
        readRaw: (): string | null => readRawMethod(state, bridge, filePath),
        write: (data: string): WriteResult =>
            writeMethod(state, bridge, rebase, queueCapacitorWrite, filePath, sweepOnce, data),
        /** `write`, for the caller that has no use for `landed`. */
        writeRaw: (data: string): boolean =>
            writeMethod(state, bridge, rebase, queueCapacitorWrite, filePath, sweepOnce, data).ok,
        writeIfAbsent: (data: string): WriteIfAbsentResult =>
            writeIfAbsentMethod(state, bridge, queueCapacitorWrite, filePath, data),
        location: (): string => locationMethod(prefKey, filePath),
        isLoaded: (): boolean => isLoadedMethod(state),
        isPersisted: (): boolean => isPersistedMethod(state),
        hasQuarantined: (): boolean => hasQuarantinedMethod(state, filePath),
        quarantineRaw: (raw: string): QuarantineResult => quarantineRawMethod(state, prefKey, filePath, raw),
        initializeAsync: async (): Promise<void> => initializeAsyncMethod(state, prefKey),
        /** The in-flight Capacitor write-behind chain (see flushPendingWrites). */
        flush: () => state.writeChain,
        discard: async (): Promise<void> => discardMethod(state),
        fileName,
        prefKey,
    };
};

/** The configuration (`config.json`, `gurushots-config`). */
const storage = createSettingsFile({
    fileName: 'config.json',
    prefKey: CONFIG_KEY,
    filePath: getSettingsPath,
    rebase: rebaseConfigText,
    dedicatedBridge: true,
    reportsDroppedSaves: true,
});

/**
 * `settings.json` (`gurushots-settings`): read for the one-time import of the settings it holds.
 */
const legacyStorage = createSettingsFile({
    fileName: 'settings.json',
    prefKey: LEGACY_SETTINGS_KEY,
    filePath: getLegacySettingsPath,
    rebase: (_base, ours) => ours,
    dedicatedBridge: false,
    reportsDroppedSaves: false,
});

/**
 * Async initialization for Capacitor builds. The React entry on Android
 * must `await initializeAsync()` before mounting so the synchronous
 * loadSettings/getSetting API returns hydrated data. No-op on
 * Electron/CLI where the fs path serves reads directly.
 */
const initializeAsync = async () => {
    await Promise.all([storage.initializeAsync(), legacyStorage.initializeAsync()]);
};

/**
 * Returns the in-flight Capacitor write-behind chain. AWAIT the returned
 * promise to ensure the latest settings have reached @capacitor/preferences
 * (e.g. before invalidating a session). The caller owns the await — calling
 * this without awaiting does not flush anything. The chain absorbs write
 * failures internally, so the returned promise resolves even if the last
 * write failed; it signals "the queue has drained", not "every write
 * succeeded". On Electron/CLI writes are already synchronous, so this is the
 * initial already-resolved promise and awaiting it is an immediate no-op.
 */
const flushPendingWrites = async () => {
    await Promise.all([storage.flush(), legacyStorage.flush()]);
};

/**
 * Gives up every write still queued (settings and every createJsonStore store), empties the caches, and makes every
 * store refuse writes, so that nothing is persisted again while local data is deleted. Resolves once the writes
 * already handed to Preferences have landed, so that removing their keys afterwards removes them for good.
 */
const discardPendingWrites = async (): Promise<void> => {
    refuseWrites();
    resetSaveDropped();
    discardStores();
    await Promise.all([storage.discard(), legacyStorage.discard()]);
    await settleStores();
};

export type { QueuedWriteOutcome } from './storageTypes';
export type { SaveDroppedCause } from './saveDropped';
export {
    LEGACY_SETTINGS_KEY,
    CONFIG_KEY,
    CORRUPT_SUFFIX,
    UNIMPORTABLE_SUFFIX,
    discardPendingWrites,
    resumeWrites,
    listPreferenceKeys,
    removePreferenceKeys,
    storage,
    legacyStorage,
    isSaveDropped,
    getSaveDroppedCause,
    getSaveDroppedSerial,
    onSaveDroppedChange,
    initializeAsync,
    flushPendingWrites,
    getSettingsPath,
    getLegacySettingsPath,
    getDefaultMockSetting,
    getUserDataPath,
    getEnvironmentInfo,
    createJsonStore,
    // electronApp is exposed for the rare caller (test harness, CLI scripts)
    // that needs the raw electron app handle.
    electronApp,
};
