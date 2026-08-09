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

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../logger');
const { isSourceCode, getAppName } = logger;
const runtime = require('../runtime');

// Try to import electron, but don't fail if it's not available (CLI context)
let electronApp = null;
try {
    const electron = require('electron');
    electronApp = electron.app;
} catch (error) {
    // Electron not available (CLI context), we'll use fallback
    logger.withCategory('ui').info('Running in CLI context - using fallback userData path:', error.message);
}

const SETTINGS_KEY = 'gurushots-settings';

let capacitorInitialized = false;
let cachedSettingsJson = null;
let capacitorPreferences = null;

// Serializes Capacitor write-behind so concurrent full-blob writes apply
// in issue order — an earlier write can never resolve after a later one
// and clobber it. flushPendingWrites() awaits the tail so callers can
// guarantee durability (e.g. before the WebView is suspended).
let writeChain = Promise.resolve();

const getCapacitorPreferences = () => {
    if (capacitorPreferences) return capacitorPreferences;
    capacitorPreferences = require('@capacitor/preferences').Preferences;
    return capacitorPreferences;
};

const storage = {
    /** Returns the raw settings JSON string, or null if not yet written. */
    readRaw: () => {
        if (runtime.isHeadlessService()) {
            // Background WebView: read from the native bridge backed by the
            // same store the app's @capacitor/preferences uses, so the token
            // and settings stay in sync between app and background.
            const store = globalThis.AndroidHeadlessStore;
            return (store && store.read()) || null;
        }
        if (runtime.isCapacitor()) {
            return cachedSettingsJson;
        }
        const settingsPath = getSettingsPath();
        if (!fs.existsSync(settingsPath)) return null;
        return fs.readFileSync(settingsPath, 'utf8');
    },
    /** Writes the raw settings JSON string. Sync on Electron/CLI; cache + async write-behind on Capacitor. */
    writeRaw: (data) => {
        if (runtime.isHeadlessService()) {
            // Persist through the native bridge to the shared store; the
            // commit is synchronous so a later read() in the same cycle
            // sees the new value.
            try {
                globalThis.AndroidHeadlessStore?.write(data);
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
        const settingsPath = getSettingsPath();
        const settingsDir = path.dirname(settingsPath);
        if (!fs.existsSync(settingsDir)) {
            fs.mkdirSync(settingsDir, { recursive: true });
        }
        // 0o600: the settings blob carries the auth token — no reason for
        // other local users to be able to read it. (Only applies on create;
        // pre-existing files keep their mode.)
        fs.writeFileSync(settingsPath, data, { encoding: 'utf8', mode: 0o600 });
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

// One-shot notice if a pre-consolidation dev directory exists elsewhere.
// Storage's old Electron dev branch hardcoded `<parent>/gurushots-auto-vote-dev`
// while logger appended `-dev` to userData; runtime.getAppUserDataPath now
// canonicalizes on the latter. When the two differ (userData basename ≠
// package name) the old dir may still hold a settings.json.
let legacyDevDirChecked = false;
const warnIfLegacyDevDir = (userDataPath) => {
    if (legacyDevDirChecked) return;
    legacyDevDirChecked = true;
    if (!(electronApp && electronApp.getPath) || !isSourceCode()) return;
    try {
        const legacy = path.join(path.dirname(electronApp.getPath('userData')), 'gurushots-auto-vote-dev');
        if (legacy !== userDataPath && fs.existsSync(path.join(legacy, 'settings.json'))) {
            logger
                .withCategory('settings')
                .warning(
                    `Legacy dev settings found at ${legacy}; settings now live at ${userDataPath} — move settings.json there if your values look reset`,
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

/**
 * Detect whether autovote is currently running. The flag is set by the
 * autovote orchestration code, possibly on different global surfaces
 * depending on whether we're in Electron main, renderer, or the CLI.
 * `globalThis` covers the renderer too — `window === globalThis` there.
 */
const isAutovoteRunning = () => {
    if (typeof global !== 'undefined' && global.autovoteRunning) return true;
    if (typeof globalThis !== 'undefined' && globalThis.autovoteRunning) return true;
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

/**
 * Generic platform-aware JSON store — the same transport pattern the
 * settings store above uses, packaged for other stores (metadata.js).
 *
 *   - Electron/CLI: synchronous fs at userData/<fileName>, written with
 *     mode 0o600 (userData JSON can carry tokens/state that other local
 *     users have no business reading).
 *   - Capacitor app WebView: hydrate-once cache (initializeAsync) +
 *     ordered async write-behind to @capacitor/preferences under prefKey.
 *   - Android headless service: in-memory only. The native
 *     AndroidHeadlessStore bridge is a keyless single blob owned by the
 *     settings store, so other stores keep per-cycle state in memory —
 *     same effective behavior the raw-fs implementation had there
 *     (every fs call threw and fell back to defaults), minus the noise.
 *
 * @param {{fileName: string, prefKey: string}} opts
 */
const createJsonStore = ({ fileName, prefKey }) => {
    let initialized = false;
    let cachedJson = null;
    let chain = Promise.resolve();

    const filePath = () => path.join(path.dirname(getSettingsPath()), fileName);

    return {
        /** Raw JSON string, or null when never written. */
        readRaw: () => {
            if (runtime.isHeadlessService() || runtime.isCapacitor()) {
                return cachedJson;
            }
            const p = filePath();
            if (!fs.existsSync(p)) return null;
            return fs.readFileSync(p, 'utf8');
        },
        /** Sync on Electron/CLI; cache + ordered write-behind on Capacitor; memory-only on headless. */
        writeRaw: (data) => {
            if (runtime.isHeadlessService()) {
                cachedJson = data;
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
            const p = filePath();
            const dir = path.dirname(p);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(p, data, { encoding: 'utf8', mode: 0o600 });
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
        /** Await to guarantee the write-behind queue has drained. */
        flushPendingWrites: () => chain,
        /** fs path (Electron/CLI) — for debug/info surfaces. */
        getFilePath: filePath,
    };
};

module.exports = {
    storage,
    initializeAsync,
    flushPendingWrites,
    getSettingsPath,
    isAutovoteRunning,
    getDefaultMockSetting,
    getUserDataPath,
    getEnvironmentInfo,
    createJsonStore,
    // electronApp is exposed for the rare caller (test harness, CLI scripts)
    // that needs the raw electron app handle.
    electronApp,
};
