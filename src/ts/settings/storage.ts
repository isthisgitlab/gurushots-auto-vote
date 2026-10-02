/**
 * Persistence transport + path / runtime detection helpers.
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
 * guards so non-Capacitor bundles never resolve it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as logger from '../logger';
const { isSourceCode, getAppName } = logger;
import * as runtime from '../runtime';

import type { App } from 'electron';
import type { PreferencesPlugin } from '@capacitor/preferences';
import type { AndroidHeadlessStore } from '../types/settings';
import { errorMessage } from '../errorMessage';

/**
 * The Android headless-service bridge, read at call time (absent everywhere
 * else).
 */
const headlessStore = (): AndroidHeadlessStore | undefined =>
    (globalThis as typeof globalThis & { AndroidHeadlessStore?: AndroidHeadlessStore }).AndroidHeadlessStore;

// Try to import electron, but don't fail if it's not available (CLI context)
let electronApp: App | null | undefined = null;
try {
    const electron = require('electron') as typeof import('electron');
    electronApp = electron.app;
} catch (error) {
    // Electron not available (CLI context), we'll use fallback
    logger.withCategory('ui').info('Running in CLI context - using fallback userData path:', errorMessage(error));
}

const SETTINGS_KEY = 'gurushots-settings';

let capacitorInitialized = false;
let cachedSettingsJson: string | null = null;
let capacitorPreferences: PreferencesPlugin | null = null;

// Serializes Capacitor write-behind so concurrent full-blob writes apply
// in issue order — an earlier write can never resolve after a later one
// and clobber it. flushPendingWrites() awaits the tail so callers can
// guarantee durability (e.g. before the WebView is suspended).
let writeChain = Promise.resolve();

const getCapacitorPreferences = (): PreferencesPlugin => {
    if (capacitorPreferences) return capacitorPreferences;
    const plugin: PreferencesPlugin = (require('@capacitor/preferences') as typeof import('@capacitor/preferences'))
        .Preferences;
    capacitorPreferences = plugin;
    return plugin;
};

// Paths whose refused chmod has been logged. A path is dropped again (and the
// recovery logged) once a chmod on it succeeds, so a file that stays
// unrestrictable warns once per failure episode rather than on every write.
const warnedUnrestrictable = new Set<string>();

/**
 * Write a userData file owner-only (0o600), creating its directory 0o700.
 * The mode passed to writeFileSync only applies when the file is created, so
 * an existing file is chmod'ed to 0o600 before the new content lands in it:
 * when that chmod succeeds the data is never written into a file other local
 * users can read. A chmod that reaches no file (ENOENT: it does not exist yet;
 * EACCES: a directory on its path cannot be searched) is skipped silently: the
 * write then creates it with 0o600 or fails with its own error, and a "could
 * not restrict" warning would point at the wrong fix. A chmod the filesystem
 * refuses (a file owned by another uid, a vfat/SMB/FUSE mount) is logged with
 * what it needs, once per failure episode (until a chmod on that path succeeds
 * again, which is logged as the recovery), and does not fail the write: the
 * data still persists. The files can carry the auth token. The file is
 * rewritten in place rather than replaced by a rename, because settingsWatcher
 * watches its inode.
 */
const writeOwnerOnly = (filePath: string, data: string) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try {
        fs.chmodSync(filePath, 0o600);
        if (warnedUnrestrictable.delete(filePath)) {
            logger.withCategory('settings').info(`Restricted ${filePath} to owner-only`);
        }
    } catch (err) {
        const code = err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
        if (code !== 'ENOENT' && code !== 'EACCES' && !warnedUnrestrictable.has(filePath)) {
            warnedUnrestrictable.add(filePath);
            const reason = code ?? errorMessage(err) ?? 'unknown error';
            logger
                .withCategory('settings')
                .warning(
                    `Could not restrict ${filePath} to owner-only (${reason}); other local users may be able to read it. It must be a regular file owned by the account this app runs as, on a filesystem that supports permissions (not FAT, SMB or FUSE); once it is, the next save restricts it automatically.`,
                );
        }
    }
    fs.writeFileSync(filePath, data, { encoding: 'utf8', mode: 0o600 });
};

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
            return (store && store.read()) || null;
        }
        if (runtime.isCapacitor()) {
            return cachedSettingsJson;
        }
        const settingsPath = getSettingsPath();
        if (!fs.existsSync(settingsPath)) return null;
        return fs.readFileSync(settingsPath, 'utf8');
    },
    /**
     * Writes the raw settings JSON string. Sync on Electron/CLI; cache + async write-behind on Capacitor.
     */
    writeRaw: (data: string) => {
        if (runtime.isHeadlessService()) {
            // Persist through the native bridge to the shared store; the
            // commit is synchronous so a later read() in the same cycle
            // sees the new value.
            try {
                headlessStore()?.write(data);
            } catch (err) {
                logger.withCategory('settings').error('Headless store write failed:', err);
            }
            return;
        }
        if (runtime.isCapacitor()) {
            // Update the cache so synchronous reads see the new value
            // immediately, then fire async write-behind to Preferences.
            // Do NOT flip capacitorInitialized here — only initializeAsync
            // owns that flag. If a write happens before initializeAsync
            // resolves and we flipped the flag, initializeAsync would
            // skip its hydration and previously-persisted settings would
            // be lost on the next read of an unwritten key.
            cachedSettingsJson = data;
            // Chain onto the previous write so persistence is ordered. A
            // failed write is logged but does not break the chain for the
            // next one (the cache still holds the latest value).
            writeChain = writeChain
                .then(() => getCapacitorPreferences().set({ key: SETTINGS_KEY, value: data }))
                .catch((err) => {
                    logger.withCategory('settings').error('Capacitor preferences write failed:', err);
                });
            return;
        }
        writeOwnerOnly(getSettingsPath(), data);
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
    } catch (err) {
        logger.withCategory('settings').error('Capacitor preferences read failed:', err);
        cachedSettingsJson = null;
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

// One-shot notice if a legacy dev directory exists elsewhere. The legacy
// Electron dev location is `<parent>/gurushots-auto-vote-dev`, while
// runtime.getAppUserDataPath appends `-dev` to userData. When the two differ
// (userData basename ≠ package name) the legacy dir may still hold a settings.json.
let legacyDevDirChecked = false;
/** @param userDataPath */
const warnIfLegacyDevDir = (userDataPath: string) => {
    if (legacyDevDirChecked) return;
    legacyDevDirChecked = true;
    if (!(electronApp && electronApp.getPath) || !isSourceCode()) return;
    try {
        const legacy = path.join(path.dirname(electronApp.getPath('userData')), 'gurushots-auto-vote-dev');
        if (legacy !== userDataPath && fs.existsSync(path.join(legacy, 'settings.json'))) {
            logger
                .withCategory('settings')
                .warning(
                    `Dev settings found at ${legacy}, but settings are read from ${userDataPath} — move settings.json there if your values look reset`,
                );
        }
    } catch {
        // Purely informational — never block settings resolution.
    }
};

// Define the settings file path in the userData directory. Resolution lives
// in runtime.getAppUserDataPath — the ONE implementation shared with the
// logger, so logs and settings can never land in different directories.
const getSettingsPath = () => {
    const userDataPath = runtime.getAppUserDataPath();
    warnIfLegacyDevDir(userDataPath);
    return path.join(userDataPath, 'settings.json');
};

/**
 * Determine the default mock setting based on environment.
 * Dev wins over prod when both signals are set; default is prod (mock disabled).
 */
const getDefaultMockSetting = () => {
    if (runtime.isDevelopment()) return true;
    return false;
};

// Get the userData directory path (useful for debugging)
const getUserDataPath = () => {
    return path.dirname(getSettingsPath());
};

// Get current environment information
const getEnvironmentInfo = () => {
    const isElectronPackaged = electronApp ? electronApp.isPackaged : false;
    const isBuiltApp = isElectronPackaged || !isSourceCode();

    return {
        ...runtime.getEnvSnapshot(),
        defaultMock: getDefaultMockSetting(),
        platform: process.platform,
        userDataPath: getUserDataPath(),
        isSourceCode: isSourceCode(),
        isElectronPackaged: isElectronPackaged,
        isBuiltApp: isBuiltApp,
        appName: getAppName(),
    };
};

const readHeadlessKey = (prefKey: string, fallback: string | null): string | null => {
    try {
        // aislop-ignore-next-line ai-slop/hidden-fallback -- an absent key is the caller's cached value; the read contract
        return headlessStore()?.readKey?.(prefKey) ?? fallback;
    } catch (err) {
        logger.withCategory('settings').error(`Headless ${prefKey} read failed:`, err);
        // aislop-ignore-next-line ai-slop/hidden-fallback -- logged via the settings logger; the caller's cached value is the read contract
        return fallback;
    }
};

const writeHeadlessKey = (prefKey: string, data: string) => {
    try {
        headlessStore()?.writeKey?.(prefKey, data);
    } catch (err) {
        logger.withCategory('settings').error(`Headless ${prefKey} write failed:`, err);
    }
};

/**
 * Generic platform-aware JSON store — the same transport pattern the
 * settings store above uses, packaged for other stores (metadata.ts).
 *
 *   - Electron/CLI: synchronous fs at userData/<fileName>, left at mode
 *     0o600 after every write (userData JSON can carry tokens/state that
 *     other local users have no business reading).
 *   - Capacitor app WebView: hydrate-once cache (initializeAsync) +
 *     ordered async write-behind to @capacitor/preferences under prefKey.
 *   - Android headless service: the native keyed preference bridge persists
 *     supported stores; unsupported keys retain their per-cycle memory cache.
 */
const createJsonStore = ({ fileName, prefKey }: { fileName: string; prefKey: string }) => {
    let initialized = false;
    let cachedJson: string | null = null;
    let chain = Promise.resolve();

    const filePath = () => path.join(path.dirname(getSettingsPath()), fileName);

    return {
        /**
         * Raw JSON string, or null when never written.
         */
        readRaw: (): string | null => {
            if (runtime.isHeadlessService()) {
                return readHeadlessKey(prefKey, cachedJson);
            }
            if (runtime.isCapacitor()) {
                return cachedJson;
            }
            const p = filePath();
            if (!fs.existsSync(p)) return null;
            return fs.readFileSync(p, 'utf8');
        },
        /**
         * Sync on Electron/CLI; cache + ordered write-behind on Capacitor; native keyed bridge on headless.
         */
        writeRaw: (data: string) => {
            if (runtime.isHeadlessService()) {
                cachedJson = data;
                writeHeadlessKey(prefKey, data);
                return;
            }
            if (runtime.isCapacitor()) {
                cachedJson = data;
                chain = chain
                    .then(() => getCapacitorPreferences().set({ key: prefKey, value: data }))
                    .catch((err) => {
                        logger.withCategory('settings').error(`Capacitor ${prefKey} write failed:`, err);
                    });
                return;
            }
            writeOwnerOnly(filePath(), data);
        },
        /** Hydrate the Capacitor cache once at boot. No-op elsewhere. */
        initializeAsync: async () => {
            if (!runtime.isCapacitor() || runtime.isHeadlessService() || initialized) return;
            try {
                const { value } = await getCapacitorPreferences().get({ key: prefKey });
                cachedJson = value;
            } catch (err) {
                logger.withCategory('settings').error(`Capacitor ${prefKey} read failed:`, err);
                cachedJson = null;
            } finally {
                initialized = true;
            }
        },
        /**
         * Re-read the Capacitor preference into the cache — for a store the
         * Android background service (a separate JS context) also writes.
         * Waits for this context's own queued writes first, so none is lost.
         * No-op off the Capacitor app WebView.
         */
        refreshAsync: async () => {
            if (!runtime.isCapacitor() || runtime.isHeadlessService()) return;
            await chain;
            try {
                const { value } = await getCapacitorPreferences().get({ key: prefKey });
                cachedJson = value;
                initialized = true;
            } catch (err) {
                logger.withCategory('settings').error(`Capacitor ${prefKey} refresh failed:`, err);
            }
        },
        /** Await to guarantee the write-behind queue has drained. */
        flushPendingWrites: () => chain,
        /** fs path (Electron/CLI) — for debug/info surfaces. */
        getFilePath: filePath,
    };
};

export {
    storage,
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
