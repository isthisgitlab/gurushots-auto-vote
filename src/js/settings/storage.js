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

const fs = require('fs');
const path = require('path');
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

const getCapacitorPreferences = () => {
    if (capacitorPreferences) return capacitorPreferences;
    capacitorPreferences = require('@capacitor/preferences').Preferences;
    return capacitorPreferences;
};

const storage = {
    /** Returns the raw settings JSON string, or null if not yet written. */
    readRaw: () => {
        if (runtime.isCapacitor()) {
            return cachedSettingsJson;
        }
        const settingsPath = getSettingsPath();
        if (!fs.existsSync(settingsPath)) return null;
        return fs.readFileSync(settingsPath, 'utf8');
    },
    /** Writes the raw settings JSON string. Sync on Electron/CLI; cache + async write-behind on Capacitor. */
    writeRaw: (data) => {
        if (runtime.isCapacitor()) {
            // Update the cache so synchronous reads see the new value
            // immediately, then fire async write-behind to Preferences.
            // Do NOT flip capacitorInitialized here — only initializeAsync
            // owns that flag. If a write happens before initializeAsync
            // resolves and we flipped the flag, initializeAsync would
            // skip its hydration and previously-persisted settings would
            // be lost on the next read of an unwritten key.
            cachedSettingsJson = data;
            getCapacitorPreferences()
                .set({ key: SETTINGS_KEY, value: data })
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
        fs.writeFileSync(settingsPath, data, 'utf8');
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

// Define the settings file path in the userData directory
const getSettingsPath = () => {
    let userDataPath;

    if (electronApp && electronApp.getPath) {
        // Electron context - need to construct proper path based on source/built status
        if (isSourceCode()) {
            // Running from source code - use dev-specific directory
            const basePath = path.dirname(electronApp.getPath('userData'));
            userDataPath = path.join(basePath, 'gurushots-auto-vote-dev');
        } else {
            // Built app - use normal userData path
            userDataPath = electronApp.getPath('userData');
        }
    } else {
        // CLI context - create fallback userData path
        userDataPath = runtime.getUserDataDir(getAppName());

        // Ensure the directory exists
        if (!fs.existsSync(userDataPath)) {
            try {
                fs.mkdirSync(userDataPath, { recursive: true });
                logger.withCategory('ui').info(`Created userData directory: ${userDataPath}`, null);
            } catch (error) {
                logger.withCategory('ui').error('Error creating userData directory:', error);
                // Fallback to current directory if we can't create the proper path
                userDataPath = path.join(process.cwd(), 'userData');
                if (!fs.existsSync(userDataPath)) {
                    fs.mkdirSync(userDataPath, { recursive: true });
                }
            }
        }
    }

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
 */
const isAutovoteRunning = () => {
    if (typeof global !== 'undefined' && global.autovoteRunning) return true;
    if (typeof globalThis !== 'undefined' && globalThis.autovoteRunning) return true;
    try {
        // eslint-disable-next-line no-undef
        if (typeof window !== 'undefined' && window.autovoteRunning) return true;
    } catch {
        // window not available outside the renderer; ignore
    }
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

module.exports = {
    storage,
    initializeAsync,
    getSettingsPath,
    isAutovoteRunning,
    getDefaultMockSetting,
    getUserDataPath,
    getEnvironmentInfo,
    // electronApp is exposed for the rare caller (test harness, CLI scripts)
    // that needs the raw electron app handle.
    electronApp,
};
