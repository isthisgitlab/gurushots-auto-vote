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
 * The platform work — the per-file state, the write queue and the write protocol of each family — is the
 * SettingsFileTransport the platform's storage member builds per file (src/ts/platform/port.ts); this factory keeps
 * the refuse-writes checks and the public surface, and never tests which family it has. The generic JSON store
 * other stores are made with lives in jsonStore.ts and is re-exported here.
 */

import { installedPlatform, platform } from '../platform/port';
import {
    areWritesRefused,
    createJsonStore,
    discardStores,
    refuseWrites,
    resumeWrites,
    settleStores,
} from './jsonStore';
import { rebaseConfigText } from './settingsMerge';
import {
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

import type { SettingsFileTransport, SettingsStoreRef } from '../platform/port';
import type { DroppedSaveOps } from './saveDropped';
import type { RawJsonStore, ThroughResult } from '../types/stores';
import type { QuarantineResult, SettingsFileOptions, WriteIfAbsentResult, WriteResult } from './storageTypes';

/**
 * Writes to `target` a text made from its current one, saved before anything can read it where that takes a moment (the
 * Android app: see RawJsonStore.updateThrough); `update` answers null to write nothing.
 */
const throughStore = async (
    target: RawJsonStore,
    update: (current: string | null) => string | null,
): Promise<ThroughResult> => {
    if (target.updateThrough) return target.updateThrough(update);
    const data = update(target.readRaw());
    if (data === null) return 'aborted';
    target.writeRaw(data);
    return 'saved';
};

/** The Preferences key of the settings.json blob (what `settings.json` is on a desktop). */
const LEGACY_SETTINGS_KEY = 'gurushots-settings';
/** The Preferences key of the configuration (what `config.json` is on a desktop). */
const CONFIG_KEY = 'gurushots-config';

// The backup of an unparseable Capacitor value lives under its key plus this suffix and the time it was set aside (a
// later one never replaces an earlier). Before the time was added it was the suffix alone. The webview family reads
// it at call time for the backup-key naming.
const CORRUPT_SUFFIX = '_corrupt';

// A copy a `settings.json` that could not be imported was kept under by an older build: wiped with the rest.
const UNIMPORTABLE_SUFFIX = '_unimportable';

const createSettingsFile = (options: SettingsFileOptions) => {
    const { fileName, prefKey, filePath, rebase, dedicatedBridge, reportsDroppedSaves } = options;

    // The sweep policy of a settings file: the temp files an earlier crash left beside it are swept before the first
    // write only, never on a read.
    const ref: SettingsStoreRef = { prefKey, filePath, sweep: 'write' };

    // The dropped-save reporting of this file (the configuration's only), handed to the family transport.
    const droppedSaves: DroppedSaveOps | null = reportsDroppedSaves
        ? { getAfter: getDroppedAfter, markAfter: markDroppedAfter, setDropped: setSaveDropped, causeOf }
        : null;

    // The transport is built as the file is created, where a platform stands. A module imported where none is
    // installed (a renderer bundle reaches these files, and no port is installed there) builds it on the file's
    // first use.
    let transport: SettingsFileTransport | null = null;
    const of = (): SettingsFileTransport =>
        (transport ??= platform().storage.settingsFile(ref, { rebase, dedicatedBridge, droppedSaves }));
    const installed = installedPlatform();
    if (installed) transport = installed.storage.settingsFile(ref, { rebase, dedicatedBridge, droppedSaves });

    return {
        readRaw: (): string | null => of().readRaw(),
        write: (data: string): WriteResult => (areWritesRefused() ? { ok: false } : of().write(data)),
        /** `write`, for the caller that has no use for `landed`. */
        writeRaw: (data: string): boolean => (areWritesRefused() ? false : of().write(data).ok),
        writeIfAbsent: (data: string): WriteIfAbsentResult =>
            areWritesRefused() ? { outcome: 'failed' } : of().writeIfAbsent(data),
        location: (): string => of().location(),
        isLoaded: (): boolean => of().isLoaded(),
        isPersisted: (): boolean => of().isPersisted(),
        hasQuarantined: (): boolean => of().hasQuarantined(),
        quarantineRaw: (raw: string): QuarantineResult => of().quarantineRaw(raw),
        initializeAsync: async (): Promise<void> => of().hydrate(),
        /** The in-flight Capacitor write-behind chain (see flushPendingWrites). */
        flush: () => of().flush(),
        discard: async (): Promise<void> => of().discard(),
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
// The one-step save of a generic JSON store and its conflict error, for the
// platform families' transports — the settings-facade internals are private
// to the facade, so the public storage module carries them.
export { writeNow } from './jsonStore';
export { SaveConflictError } from './saveDropped';
export {
    LEGACY_SETTINGS_KEY,
    CONFIG_KEY,
    CORRUPT_SUFFIX,
    UNIMPORTABLE_SUFFIX,
    discardPendingWrites,
    resumeWrites,
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
    throughStore,
};
