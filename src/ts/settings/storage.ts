/**
 * Persistence transport for the settings.
 *
 * Electron / CLI: settings live in a JSON file read/written synchronously
 * through fs at userData/settings.json.
 *
 * Capacitor: the WebView has no fs and @capacitor/preferences is async-
 * only, so we hydrate an in-memory cache once at boot (initializeAsync)
 * and let all sync reads hit the cache. Writes mutate the cache
 * synchronously so consumers see the new value immediately, then fire
 * an async write-behind so the next launch sees the change.
 *
 * @capacitor/preferences is lazy-required only inside isCapacitor()
 * guards so non-Capacitor bundles never resolve it. The generic JSON store
 * other stores are made with lives in jsonStore.ts and is re-exported here.
 */

import * as fs from 'node:fs';
import * as logger from '../logger';
import * as runtime from '../runtime';

import { errorMessage } from '../errorMessage';
import { sweepStaleTemps, writeAtomicOwnerOnly } from './atomicWrite';
import { getCapacitorPreferences, removePreferenceKeys } from './capacitorPreferences';
import {
    areWritesRefused,
    createJsonStore,
    discardStores,
    refuseWrites,
    resumeWrites,
    settleStores,
} from './jsonStore';
import { headlessSettingsWrite, headlessStore, saveThroughCas } from './storeTransport';
import { rebaseSettingsText } from './settingsMerge';
import {
    electronApp,
    getDefaultMockSetting,
    getEnvironmentInfo,
    getSettingsPath,
    getUserDataPath,
} from './userDataPaths';
import { compareAndWrite } from '../services/NativeAutovoteBridge';

const SETTINGS_KEY = 'gurushots-settings';

let capacitorInitialized = false;
let cachedSettingsJson: string | null = null;

// What the app window knows Preferences to hold for the settings key: what it read, or saved last. The compare-and-write
// of the next save expects it, and the change is made again on what the background service saved since.
let persistedSettingsJson: string | null = null;
// The text the Android service's JS last read from the native store: the text its next write is a change of.
let headlessSettingsBase: string | null = null;

// Serializes Capacitor write-behind so concurrent full-blob writes apply
// in issue order — an earlier write can never resolve after a later one
// and clobber it. flushPendingWrites() awaits the tail so callers can
// guarantee durability (e.g. before the WebView is suspended).
let writeChain = Promise.resolve();

// Bumped by discardPendingWrites: a queued settings write finds the number changed on its turn and puts nothing down.
let settingsWriteGeneration = 0;
// Bumped by every settings write and by moving the stored value aside: a write that finds it moved on is not the latest,
// and leaves the cache to the one that is.
let settingsWriteSerial = 0;

// Whether a settings save of the app window was given up: its change is in no store (and the cache is back to what is
// stored, unless a later write is queued), and `droppedAfter` is the last write issued by then. Cleared by the next
// write issued after that one that lands.
let saveDropped = false;
let droppedAfter = 0;
let saveDroppedListener: (() => void) | null = null;

/**
 * Why a settings save of the app window was given up: the background service kept changing the settings (`conflict`),
 * the blob is past the size the native store takes (`too-large`), or the store refused or failed it (`storage`).
 */
type SaveDroppedCause = 'conflict' | 'too-large' | 'storage';

let droppedCause: SaveDroppedCause = 'storage';

// The cause of a save that threw: the code the native plugin rejected with (`too-large`), or the one a save that lost
// to the other writer on every attempt carries (`conflict`); anything else is the store's failure.
const causeOf = (err: unknown): SaveDroppedCause => {
    const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
    return code === 'too-large' || code === 'conflict' ? code : 'storage';
};

// A change of the reported cause while a save is already reported is a change too: the window words it by the cause.
const setSaveDropped = (dropped: boolean, cause: SaveDroppedCause = 'storage') => {
    if (saveDropped === dropped && (!dropped || droppedCause === cause)) return;
    saveDropped = dropped;
    droppedCause = cause;
    saveDroppedListener?.();
};

/** Whether a settings save of the app window was given up, and its change is not in the stored settings. */
const isSaveDropped = (): boolean => saveDropped;

/** Why the save reported by {@link isSaveDropped} was given up (`storage` while none is). */
const getSaveDroppedCause = (): SaveDroppedCause => droppedCause;

/**
 * Tells `listener` whenever {@link isSaveDropped} changes, so a window can re-read the settings (the one subscriber is
 * replaced by the next).
 */
const onSaveDroppedChange = (listener: (() => void) | null): void => {
    saveDroppedListener = listener;
};

// Saves the settings text the app window changed (`data`, made from `base`, the cache before the change): only if
// Preferences still holds what was last known of it, else the change is made again on what the background service saved
// since. Once the latest write is saved, the cache holds the merged text.
const saveSettingsThroughCas = async (base: string | null, data: string, serial: number): Promise<void> => {
    // The text of the attempt that saved is the last one made.
    let saved = data;
    await saveThroughCas(
        SETTINGS_KEY,
        getCapacitorPreferences,
        persistedSettingsJson,
        (stored) => (saved = rebaseSettingsText(base, data, stored)),
        (expected, text) => compareAndWrite(SETTINGS_KEY, expected, text),
    );
    persistedSettingsJson = saved;
    if (serial === settingsWriteSerial) cachedSettingsJson = saved;
};

// The backup of an unparseable Capacitor settings value lives under the settings key plus this suffix.
const CORRUPT_SUFFIX = '_corrupt';

// Temp files an earlier crash left beside settings.json are swept on the first write.
let settingsSwept = false;

/** What moving an unusable settings value aside came to: where it went, or why it did not. */
type QuarantineResult = { ok: true; path: string } | { ok: false; error: string };

const storage = {
    /**
     * Returns the raw settings JSON string, or null if not yet written.
     */
    readRaw: (): string | null => {
        if (runtime.isHeadlessService()) {
            // Background WebView: read from the native bridge backed by the
            // same store the app's @capacitor/preferences uses, so the token
            // and settings stay in sync between app and background.
            const store = headlessStore();
            headlessSettingsBase = (store && store.read()) || null;
            return headlessSettingsBase;
        }
        if (runtime.isCapacitor()) {
            return cachedSettingsJson;
        }
        const settingsPath = getSettingsPath();
        if (!fs.existsSync(settingsPath)) return null;
        return fs.readFileSync(settingsPath, 'utf8');
    },
    /**
     * Writes the raw settings JSON string. Sync on Electron/CLI (replaced atomically, so a reader or a crash never
     * sees a cut-off file); cache + async write-behind on Capacitor.
     *
     * @returns false when the Android service's native store refused the write; true otherwise (a failed fs write throws)
     */
    writeRaw: (data: string): boolean => {
        if (areWritesRefused()) return false;
        if (runtime.isHeadlessService()) {
            // Persist through the native bridge to the shared store, as a change of the text this context read: the
            // app window saves the same blob, and what it saved meanwhile is kept (see headlessSettingsWrite). The
            // commit is synchronous so a later read() in the same cycle sees the new value.
            try {
                const saved = headlessSettingsWrite(headlessSettingsBase, data);
                if (saved === null) {
                    // The native side says why: the blob is past its size limit, it changed under the write, or the commit failed.
                    const why = headlessStore()?.lastWriteRefusal?.();
                    logger
                        .withCategory('settings')
                        .error(`Headless store refused the settings write${why ? ` (${why})` : ''}`, null);
                    return false;
                }
                headlessSettingsBase = saved;
            } catch (err) {
                logger.withCategory('settings').error('Headless store write failed:', err);
                return false;
            }
            return true;
        }
        if (runtime.isCapacitor()) {
            // Update the cache so synchronous reads see the new value
            // immediately, then fire async write-behind to Preferences.
            // Do NOT flip capacitorInitialized here — only initializeAsync
            // owns that flag. If a write happens before initializeAsync
            // resolves and we flipped the flag, initializeAsync would
            // skip its hydration and previously-persisted settings would
            // be lost on the next read of an unwritten key.
            const base = cachedSettingsJson;
            cachedSettingsJson = data;
            // Chain onto the previous write so persistence is ordered. A
            // failed write is logged but does not break the chain for the
            // next one.
            const issuedIn = settingsWriteGeneration;
            const serial = ++settingsWriteSerial;
            writeChain = writeChain
                .then(async () => {
                    if (issuedIn !== settingsWriteGeneration) return;
                    await saveSettingsThroughCas(base, data, serial);
                    // A write issued before the one given up does not carry its change either.
                    if (serial > droppedAfter) setSaveDropped(false);
                })
                .catch((err) => {
                    logger.withCategory('settings').error('Capacitor preferences write failed:', err);
                    if (issuedIn !== settingsWriteGeneration) return;
                    // What the cache shows must be what is stored: the change was not saved, and no later write
                    // carries it (each carries its own).
                    if (serial === settingsWriteSerial) cachedSettingsJson = persistedSettingsJson;
                    // The window is told, so the user can make the change again.
                    droppedAfter = settingsWriteSerial;
                    setSaveDropped(true, causeOf(err));
                });
            return true;
        }
        const settingsPath = getSettingsPath();
        if (!settingsSwept) {
            settingsSwept = true;
            sweepStaleTemps(settingsPath);
        }
        writeAtomicOwnerOnly(settingsPath, data);
        return true;
    },
    /** Where the settings live, for a message: the file, or the preference key where there is no file. */
    settingsLocation: (): string =>
        runtime.isHeadlessService() || runtime.isCapacitor() ? SETTINGS_KEY : getSettingsPath(),
    /**
     * Moves a settings value that cannot be used out of the way, so the next save does not overwrite it: the file is
     * renamed to `settings.json.corrupt-<time>` (Electron/CLI); the Preferences value is copied to
     * `<key>_corrupt`, then removed from its own key, and the cache emptied (Capacitor). The Android service cannot do either, so it reports
     * a failure and the caller refuses to save.
     */
    quarantineRaw: (raw: string): QuarantineResult => {
        if (runtime.isHeadlessService()) {
            return { ok: false, error: 'the background service cannot set an unusable settings value aside' };
        }
        if (runtime.isCapacitor()) {
            const backupKey = `${SETTINGS_KEY}${CORRUPT_SUFFIX}`;
            cachedSettingsJson = null;
            settingsWriteSerial++;
            writeChain = writeChain
                .then(async () => {
                    const preferences = getCapacitorPreferences();
                    await preferences.set({ key: backupKey, value: raw });
                    await preferences.remove({ key: SETTINGS_KEY });
                    persistedSettingsJson = null;
                })
                .catch((err) => {
                    logger.withCategory('settings').error('Capacitor preferences backup write failed:', err);
                });
            return { ok: true, path: backupKey };
        }
        const settingsPath = getSettingsPath();
        const backupPath = `${settingsPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        try {
            fs.renameSync(settingsPath, backupPath);
            return { ok: true, path: backupPath };
        } catch (err) {
            return { ok: false, error: errorMessage(err) ?? 'unknown error' };
        }
    },
};

/**
 * Async initialization for Capacitor builds. The React entry on Android
 * must `await initializeAsync()` before mounting so the synchronous
 * loadSettings/getSetting API returns hydrated data. No-op on
 * Electron/CLI where the fs path serves reads directly.
 */
const initializeAsync = async () => {
    if (!runtime.isCapacitor() || capacitorInitialized) return;
    try {
        const prefs = getCapacitorPreferences();
        const { value } = await prefs.get({ key: SETTINGS_KEY });
        cachedSettingsJson = value; // null if no preferences entry exists
        persistedSettingsJson = value;
    } catch (err) {
        logger.withCategory('settings').error('Capacitor preferences read failed:', err);
        cachedSettingsJson = null;
        persistedSettingsJson = null;
    } finally {
        capacitorInitialized = true;
    }
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
const flushPendingWrites = () => writeChain;

/**
 * Gives up every write still queued (settings and every createJsonStore store), empties the caches, and makes every
 * store refuse writes, so that nothing is persisted again while local data is deleted. Resolves once the writes
 * already handed to Preferences have landed, so that removing their keys afterwards removes them for good.
 */
const discardPendingWrites = async (): Promise<void> => {
    refuseWrites();
    settingsWriteGeneration++;
    cachedSettingsJson = null;
    persistedSettingsJson = null;
    saveDropped = false;
    droppedCause = 'storage';
    discardStores();
    await writeChain;
    await settleStores();
};

export type { SaveDroppedCause };
export {
    SETTINGS_KEY,
    CORRUPT_SUFFIX,
    discardPendingWrites,
    resumeWrites,
    removePreferenceKeys,
    storage,
    isSaveDropped,
    getSaveDroppedCause,
    onSaveDroppedChange,
    initializeAsync,
    flushPendingWrites,
    getSettingsPath,
    getDefaultMockSetting,
    getUserDataPath,
    getEnvironmentInfo,
    createJsonStore,
    // electronApp is exposed for the rare caller (test harness, CLI scripts)
    // that needs the raw electron app handle.
    electronApp,
};
