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

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as logger from '../logger';
import * as runtime from '../runtime';

import { errorMessage } from '../errorMessage';
import { sweepStaleTemps, writeAtomicOwnerOnly } from './atomicWrite';
import { getCapacitorPreferences, listPreferenceKeys, removePreferenceKeys } from './capacitorPreferences';
import {
    areWritesRefused,
    createJsonStore,
    discardStores,
    refuseWrites,
    resumeWrites,
    settleStores,
} from './jsonStore';
import { headlessSettingsWrite, headlessStore, keyedSettingsBridge, saveThroughCas } from './storeTransport';
import { rebaseConfigText } from './settingsMerge';
import {
    electronApp,
    getDefaultMockSetting,
    getEnvironmentInfo,
    getLegacySettingsPath,
    getSettingsPath,
    getUserDataPath,
} from './userDataPaths';
import { compareAndWrite } from '../services/NativeAutovoteBridge';

import type { HeadlessSettingsBridge } from './storeTransport';

/** The Preferences key of the settings.json blob (what `settings.json` is on a desktop). */
const LEGACY_SETTINGS_KEY = 'gurushots-settings';
/** The Preferences key of the configuration (what `config.json` is on a desktop). */
const CONFIG_KEY = 'gurushots-config';

// The backup of an unparseable Capacitor value lives under its key plus this suffix and the time it was set aside (a
// later one never replaces an earlier). Before the time was added it was the suffix alone.
const CORRUPT_SUFFIX = '_corrupt';
// A copy a `settings.json` that could not be imported was kept under by an older build: wiped with the rest.
const UNIMPORTABLE_SUFFIX = '_unimportable';

// Whether a settings save of the app window was given up: its change is in no store (and the cache is back to what is
// stored, unless a later write is queued), and `droppedAfter` is the last write issued by then. Cleared by the next
// write issued after that one that lands.
let saveDropped = false;
let droppedAfter = 0;
// How many saves were given up in this process: each one is a notice of its own, so a repeat of the same cause is told
// apart from the one a window already showed.
let droppedSerial = 0;
let saveDroppedListener: (() => void) | null = null;

/**
 * Why a settings save of the app window was given up: the background service kept changing the settings (`conflict`),
 * the blob is past the size the native store takes (`too-large`), or the store refused or failed it (`storage`).
 */
type SaveDroppedCause = 'conflict' | 'too-large' | 'storage' | 'logout-lost';

let droppedCause: SaveDroppedCause = 'storage';

// The cause of a save that threw: the code the native plugin rejected with (`too-large`), or the one a save that lost
// to the other writer on every attempt carries (`conflict`); anything else is the store's failure.
const causeOf = (err: unknown): SaveDroppedCause => {
    const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
    return code === 'too-large' || code === 'conflict' ? code : 'storage';
};

// A change of the user's that is given up is a notice of its own, even when it repeats the cause of the one reported: the
// window shows it again (`again`). A write the app issues itself (the restore of the configuration, which a read tries
// again at once) reports a repeat once, or a store that refuses every write would make the window read, try and report in
// a loop.
const setSaveDropped = (dropped: boolean, cause: SaveDroppedCause = 'storage', again = false) => {
    if (saveDropped === dropped && (!dropped || (droppedCause === cause && !again))) return;
    if (dropped) droppedSerial++;
    saveDropped = dropped;
    droppedCause = cause;
    saveDroppedListener?.();
};

/** Whether a settings save of the app window was given up, and its change is not in the stored settings. */
const isSaveDropped = (): boolean => saveDropped;

/** Why the save reported by {@link isSaveDropped} was given up (`storage` while none is). */
const getSaveDroppedCause = (): SaveDroppedCause => droppedCause;

/** How many saves were given up so far: the one reported by {@link isSaveDropped} is the latest. */
const getSaveDroppedSerial = (): number => droppedSerial;

/**
 * Tells `listener` whenever {@link isSaveDropped} changes, so a window can re-read the settings (the one subscriber is
 * replaced by the next).
 */
const onSaveDroppedChange = (listener: (() => void) | null): void => {
    saveDroppedListener = listener;
};

/**
 * What moving an unusable settings value aside came to: where it went, or why it did not. Where the move is only queued
 * (the Android app window) `moved` says later whether it was made.
 */
type QuarantineResult = { ok: true; path: string; moved?: Promise<boolean> } | { ok: false; error: string };

/**
 * How a queued Capacitor write ended: `written` (Preferences holds the text), `declined` (the compare-and-write found
 * another context's text there and took that: the write had nothing to do), or `failed` (nothing was written).
 */
type QueuedWriteOutcome = 'written' | 'declined' | 'failed';

/**
 * What `writeIfAbsent` came to: it was saved, a value was already there (`current`), or the save failed. Where the save
 * is only queued (the Android app window) `landed` says how it ended, once it has: until then the text is shown by the
 * cache, and nothing that depends on it being stored may be done.
 */
type WriteIfAbsentResult =
    | { outcome: 'saved'; landed?: Promise<QueuedWriteOutcome> }
    | { outcome: 'exists'; current: string | null }
    | { outcome: 'failed' };

/**
 * What a `write` came to: `ok` (the text is saved, or shown by the cache and queued), and, where the save is only
 * queued (the Android app window), `landed`, which says how the queued write ended once it has: until then the text is
 * shown by the cache, and nothing that depends on it being stored may be done.
 */
type WriteResult = { ok: boolean; landed?: Promise<QueuedWriteOutcome> };

type SettingsFileOptions = {
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

// The time a value was set aside, as part of the name it is kept under.
const setAsideStamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

const createSettingsFile = (options: SettingsFileOptions) => {
    const { fileName, prefKey, filePath, rebase, dedicatedBridge, reportsDroppedSaves } = options;
    let capacitorInitialized = false;
    let cachedJson: string | null = null;
    // Whether a quarantined copy of this file exists in Preferences (the app window learns it when it hydrates).
    let hasBackupKey = false;

    // What the app window knows Preferences to hold for the key: what it read, or saved last. The compare-and-write
    // of the next save expects it, and the change is made again on what the background service saved since.
    let persistedJson: string | null = null;
    // The text the Android service's JS last read from the native store: the text its next write is a change of.
    let headlessBase: string | null = null;

    // Serializes Capacitor write-behind so concurrent full-blob writes apply in issue order — an earlier write can
    // never resolve after a later one and clobber it. flush() awaits the tail so callers can guarantee durability
    // (e.g. before the WebView is suspended).
    let writeChain = Promise.resolve();

    // Bumped by discard: a queued write finds the number changed on its turn and puts nothing down.
    let writeGeneration = 0;
    // Bumped by every write and by moving the stored value aside: a write that finds it moved on is not the latest,
    // and leaves the cache to the one that is.
    let writeSerial = 0;

    // Temp files an earlier crash left beside the file are swept on the first write.
    let swept = false;
    const sweepOnce = (file: string) => {
        if (swept) return;
        swept = true;
        sweepStaleTemps(file);
    };

    const bridge = (): HeadlessSettingsBridge | undefined => {
        if (dedicatedBridge) return headlessStore();
        return keyedSettingsBridge(prefKey);
    };

    // Saves the text the app window changed (`data`, made from `base`, the cache before the change): only if
    // Preferences still holds what was last known of it, else the change is made again on what the background service
    // saved since (`update` decides what is saved from what is there). Once the latest write is saved, the cache holds
    // the saved text.
    const saveThroughCasWith = async (
        update: (stored: string | null) => string | null,
        serial: number,
    ): Promise<string | null> => {
        let saved = persistedJson;
        const result = await saveThroughCas(
            prefKey,
            getCapacitorPreferences,
            persistedJson,
            (stored) => {
                const next = update(stored);
                saved = next ?? stored;
                return next;
            },
            (expected, text) => compareAndWrite(prefKey, expected, text),
        );
        persistedJson = saved;
        if (serial === writeSerial) cachedJson = saved;
        return result;
    };

    // Queues the write of a change of the cache: after the writes before it, as a compare-and-write.
    const queueCapacitorWrite = (
        update: (stored: string | null) => string | null,
        userChange: boolean,
    ): Promise<QueuedWriteOutcome> => {
        const issuedIn = writeGeneration;
        const serial = ++writeSerial;
        const ended = writeChain
            .then(async (): Promise<QueuedWriteOutcome> => {
                if (issuedIn !== writeGeneration) return 'failed';
                const result = await saveThroughCasWith(update, serial);
                // A write issued before the one given up does not carry its change either.
                if (reportsDroppedSaves && serial > droppedAfter) setSaveDropped(false);
                return result === null ? 'declined' : 'written';
            })
            .catch((err): QueuedWriteOutcome => {
                logger.withCategory('settings').error('Capacitor preferences write failed:', err);
                if (issuedIn !== writeGeneration) return 'failed';
                // What the cache shows must be what is stored: the change was not saved, and no later write carries
                // it (each carries its own).
                if (serial === writeSerial) cachedJson = persistedJson;
                if (!reportsDroppedSaves) return 'failed';
                // The window is told, so the user can make the change again.
                droppedAfter = writeSerial;
                setSaveDropped(true, causeOf(err), userChange);
                return 'failed';
            });
        writeChain = ended.then(() => undefined);
        return ended;
    };

    // The stored text where it is the app's own to read: the Android window's cache, or the file.
    const readHere = (): string | null => {
        if (runtime.isCapacitor()) return cachedJson;
        const file = filePath();
        if (!fs.existsSync(file)) return null;
        return fs.readFileSync(file, 'utf8');
    };

    const write = (data: string): WriteResult => {
        if (areWritesRefused()) return { ok: false };
        if (runtime.isHeadlessService()) {
            // Persist through the native bridge to the shared store, as a change of the text this context read: the
            // app window saves the same blob, and what it saved meanwhile is kept (see headlessSettingsWrite). The
            // commit is synchronous so a later read() in the same cycle sees the new value.
            try {
                const saved = headlessSettingsWrite(bridge(), rebase, headlessBase, data);
                if (saved === null) {
                    // The native side says why: the blob is past its size limit, it changed under the write, or the commit failed.
                    const why = bridge()?.lastWriteRefusal?.();
                    logger
                        .withCategory('settings')
                        .error(`Headless store refused the settings write${why ? ` (${why})` : ''}`, null);
                    return { ok: false };
                }
                headlessBase = saved;
            } catch (err) {
                logger.withCategory('settings').error('Headless store write failed:', err);
                return { ok: false };
            }
            return { ok: true };
        }
        if (runtime.isCapacitor()) {
            // Update the cache so synchronous reads see the new value immediately, then fire async write-behind
            // to Preferences. Do NOT flip capacitorInitialized here — only initializeAsync owns that flag. If a
            // write happens before initializeAsync resolves and we flipped the flag, initializeAsync would skip
            // its hydration and previously-persisted settings would be lost on the next read of an unwritten key.
            const base = cachedJson;
            cachedJson = data;
            return { ok: true, landed: queueCapacitorWrite((stored) => rebase(base, data, stored), true) };
        }
        const file = filePath();
        sweepOnce(file);
        writeAtomicOwnerOnly(file, data);
        return { ok: true };
    };

    return {
        /**
         * Returns the raw JSON string, or null if not yet written.
         */
        readRaw: (): string | null => {
            if (runtime.isHeadlessService()) {
                // Background WebView: read from the native bridge backed by the same store the app's
                // @capacitor/preferences uses, so the token and settings stay in sync between app and background.
                headlessBase = bridge()?.read() || null;
                return headlessBase;
            }
            return readHere();
        },
        /**
         * Writes the raw JSON string. Sync on Electron/CLI (replaced atomically, so a reader or a crash never sees a
         * cut-off file); cache + async write-behind on Capacitor, where `landed` says how the queued write ended.
         *
         * @returns `ok` false when the Android service's native store refused the write; true otherwise (a failed fs write throws)
         */
        write,
        /** `write`, for the caller that has no use for `landed`. */
        writeRaw: (data: string): boolean => write(data).ok,
        /**
         * Writes the raw JSON string only if nothing is stored yet: the write of an import, which two contexts (the app
         * window and the background service) may both try. On Android the native compare-and-write decides which
         * one is first; the other finds what the first saved (`exists`, with the text) and has nothing to write. On a
         * desktop the caller holds the import lock, so what it found missing is still missing.
         */
        writeIfAbsent: (data: string): WriteIfAbsentResult => {
            if (areWritesRefused()) return { outcome: 'failed' };
            if (runtime.isHeadlessService()) {
                try {
                    const answer = bridge();
                    if (!answer) {
                        headlessBase = data;
                        return { outcome: 'saved' };
                    }
                    if (answer.write(data) !== false) {
                        headlessBase = data;
                        return { outcome: 'saved' };
                    }
                    const current = answer.read();
                    if (current !== null) {
                        headlessBase = current;
                        return { outcome: 'exists', current };
                    }
                    logger
                        .withCategory('settings')
                        .error(
                            `Headless store refused the settings write (${answer.lastWriteRefusal?.() || 'refused'})`,
                            null,
                        );
                } catch (err) {
                    logger.withCategory('settings').error('Headless store write failed:', err);
                }
                return { outcome: 'failed' };
            }
            if (runtime.isCapacitor()) {
                // The cache shows the import at once; if the service saved first, the compare-and-write finds its text
                // and the cache takes that (`declined`). Whether it landed is for `landed` to say.
                cachedJson = data;
                return {
                    outcome: 'saved',
                    landed: queueCapacitorWrite((stored) => (stored === null ? data : null), false),
                };
            }
            const file = filePath();
            if (fs.existsSync(file)) return { outcome: 'exists', current: fs.readFileSync(file, 'utf8') };
            writeAtomicOwnerOnly(file, data);
            return { outcome: 'saved' };
        },
        /** Where the file lives, for a message: the file, or the preference key where there is no file. */
        location: (): string => (runtime.isHeadlessService() || runtime.isCapacitor() ? prefKey : filePath()),
        /**
         * Whether what a read answers is what is stored: false only where the answer is a cache that has not been
         * filled yet (the app window before initializeAsync resolved) or no bridge answers (the Android service).
         */
        isLoaded: (): boolean => {
            if (runtime.isHeadlessService()) return headlessStore() !== undefined;
            if (runtime.isCapacitor()) return capacitorInitialized;
            return true;
        },
        /**
         * Whether what a read answers is stored: false only in the Android app window while a write of its own, queued
         * and not landed yet, is what the cache shows (it is stored when it lands, and the cache goes back to what is
         * stored when it fails).
         */
        isPersisted: (): boolean =>
            !runtime.isCapacitor() || runtime.isHeadlessService() || cachedJson === persistedJson,
        /**
         * Whether an unusable copy of this file was set aside earlier (`<file>.corrupt-<time>`; on Capacitor a
         * `<key>_corrupt…` preference, which the window learns when it hydrates, and the service cannot see).
         */
        hasQuarantined: (): boolean => {
            if (runtime.isHeadlessService()) return false;
            if (runtime.isCapacitor()) return hasBackupKey;
            try {
                const prefix = `${path.basename(filePath())}.corrupt-`;
                return fs.readdirSync(path.dirname(filePath())).some((name) => name.startsWith(prefix));
            } catch {
                return false;
            }
        },
        /**
         * Moves a value that cannot be used out of the way, so the next save does not overwrite it: the file is
         * renamed to `<file>.corrupt-<time>` (Electron/CLI); the Preferences value is copied to
         * `<key>_corrupt-<time>`, then removed from its own key, and the cache emptied (Capacitor). The Android
         * service cannot do either, so it reports a failure and the caller refuses to save.
         */
        quarantineRaw: (raw: string): QuarantineResult => {
            if (runtime.isHeadlessService()) {
                return { ok: false, error: 'the background service cannot set an unusable settings value aside' };
            }
            if (runtime.isCapacitor()) {
                const backupKey = `${prefKey}${CORRUPT_SUFFIX}-${setAsideStamp()}`;
                cachedJson = null;
                const hadBackupKey = hasBackupKey;
                hasBackupKey = true;
                ++writeSerial;
                const moved = writeChain
                    .then(async () => {
                        const preferences = getCapacitorPreferences();
                        await preferences.set({ key: backupKey, value: raw });
                        await preferences.remove({ key: prefKey });
                        persistedJson = null;
                        return true;
                    })
                    .catch((err) => {
                        logger.withCategory('settings').error('Capacitor preferences backup write failed:', err);
                        // The value was not moved: Preferences still holds it, the cache shows what is stored again (a
                        // write queued meanwhile, a restore, cannot change what is stored over the damaged value, and
                        // must not be shown in place of it), and there is no copy of it.
                        cachedJson = persistedJson;
                        hasBackupKey = hadBackupKey;
                        return false;
                    });
                writeChain = moved.then(() => undefined);
                return { ok: true, path: backupKey, moved };
            }
            const file = filePath();
            const backupPath = `${file}.corrupt-${setAsideStamp()}`;
            try {
                fs.renameSync(file, backupPath);
                return { ok: true, path: backupPath };
            } catch (err) {
                return { ok: false, error: errorMessage(err) ?? 'unknown error' };
            }
        },
        /**
         * Async initialization for Capacitor builds: hydrates the cache from Preferences. No-op elsewhere.
         */
        initializeAsync: async () => {
            if (!runtime.isCapacitor() || runtime.isHeadlessService() || capacitorInitialized) return;
            try {
                const prefs = getCapacitorPreferences();
                const { value } = await prefs.get({ key: prefKey });
                cachedJson = value; // null if no preferences entry exists
                persistedJson = value;
                hasBackupKey = (await prefs.keys()).keys.some((key) => key.startsWith(`${prefKey}${CORRUPT_SUFFIX}`));
            } catch (err) {
                logger.withCategory('settings').error('Capacitor preferences read failed:', err);
                cachedJson = null;
                persistedJson = null;
            } finally {
                capacitorInitialized = true;
            }
        },
        /** The in-flight Capacitor write-behind chain (see flushPendingWrites). */
        flush: () => writeChain,
        /** Gives up every write still queued and empties the caches. */
        discard: async (): Promise<void> => {
            writeGeneration++;
            cachedJson = null;
            persistedJson = null;
            hasBackupKey = false;
            await writeChain;
        },
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
    saveDropped = false;
    droppedCause = 'storage';
    discardStores();
    await Promise.all([storage.discard(), legacyStorage.discard()]);
    await settleStores();
};

export type { QueuedWriteOutcome, SaveDroppedCause };
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
