/**
 * Runtime mode, platform detection, and OS-path resolution. The single
 * allowed reader of process.env so the rest of the codebase isn't
 * sprinkled with env lookups. Pure Node — no Electron, no logger
 * import — so it can be required from anywhere including bootstrap
 * paths. Electron is touched only via a guarded require() inside
 * isPackaged() and only when isElectron() is already true.
 */

const path = require('node:path');
const os = require('node:os');

const hasNode = typeof process !== 'undefined' && process.versions != null;
const getCapacitor = () => globalThis.Capacitor;

const isElectron = () => hasNode && process.versions.electron != null;

const isCapacitor = () => {
    const cap = getCapacitor();
    return cap != null && typeof cap.isNativePlatform === 'function';
};

// The Android background service runs the JS in a bare WebView with no
// Capacitor runtime, and injects this flag so the storage and HTTP layers
// route through the native @JavascriptInterface bridges instead of
// @capacitor/preferences / CapacitorHttp.
const isHeadlessService = () => globalThis.__GS_HEADLESS__ === true;

const isCli = () => hasNode && !isElectron();

const getPlatform = () => {
    if (isHeadlessService()) return 'headless';
    if (isElectron()) return 'electron';
    if (isCapacitor()) return 'capacitor';
    if (isCli()) return 'cli';
    return 'unknown';
};

const isPackaged = () => {
    if (isElectron()) {
        try {
            return require('electron').app.isPackaged;
        } catch {
            return false;
        }
    }
    if (isCapacitor()) return getCapacitor().isNativePlatform();
    return false;
};

const getOs = () => {
    if (isCapacitor()) return getCapacitor().getPlatform();
    if (hasNode) return process.platform;
    return 'unknown';
};

const isDevelopment = () =>
    process.env.NODE_ENV === 'development' ||
    process.env.NODE_ENV === 'dev' ||
    process.env.DEV === 'true' ||
    process.env.DEV === '1';

const isProduction = () =>
    process.env.NODE_ENV === 'production' ||
    process.env.NODE_ENV === 'prod' ||
    process.env.PROD === 'true' ||
    process.env.PROD === '1';

const isTest = () => process.env.NODE_ENV === 'test';

const getEnvSnapshot = () => ({
    nodeEnv: process.env.NODE_ENV,
    dev: process.env.DEV,
    prod: process.env.PROD,
});

// Platform-native user data directory. The Windows branch falls back
// to the manual AppData path when APPDATA isn't set (some shells/CI).
// On Capacitor (Android WebView) there is no fs anyway — return a
// stub path so callers do not crash on os.homedir() (which gets
// shimmed to undefined when the bundler externalizes 'os'). Code
// paths that try to actually mkdir/write at this returned path are
// expected to be wrapped in try/catch so they fail-soft.
const getUserDataDir = (appName) => {
    if (isCapacitor()) return `/${appName}`;
    switch (process.platform) {
        case 'darwin':
            return path.join(os.homedir(), 'Library', 'Application Support', appName);
        case 'win32':
            return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
        default:
            return path.join(os.homedir(), '.config', appName);
    }
};

// --- App identity + resolved user-data path (single source of truth) ---
// logger.js and settings/storage.js previously carried their OWN copies of
// this resolution, and their Electron dev branches disagreed (`<userData>-dev`
// vs `<parent>/gurushots-auto-vote-dev`) — logs and settings could land in
// different directories whenever the userData basename differs from the
// package name. This module is the one implementation; logger re-exports
// isSourceCode/getAppName for compatibility (tests mock the logger seam).

const APP_BASE_NAME = 'gurushots-auto-vote';

/**
 * Detect running-from-source vs a built app (packaged Electron, SEA CLI,
 * or asar). Drives the -dev suffix so dev state never pollutes prod state.
 */
const isSourceCode = () => {
    if (isElectron()) {
        try {
            if (require('electron').app?.isPackaged) return false;
        } catch {
            // Electron module unavailable despite the version flag — treat as source.
        }
    }
    try {
        if (require('node:sea').isSea()) return false;
    } catch {
        // node:sea unavailable — fall through to other detection
    }
    if (__dirname.includes('.asar')) return false;
    return true;
};

const getAppName = () => (isSourceCode() ? `${APP_BASE_NAME}-dev` : APP_BASE_NAME);

/**
 * The app's user-data directory, resolved identically for every consumer
 * (logger, settings storage, scripts):
 *   - Electron: app.getPath('userData'), with `-dev` appended when running
 *     from source (canonical dev form).
 *   - CLI/SEA: the platform-native dir for getAppName(), created on first
 *     use with a cwd fallback.
 * Bootstrap-safe: no logger import (console.warn is the only channel here).
 */
const getAppUserDataPath = () => {
    if (isElectron()) {
        try {
            const app = require('electron').app;
            if (app && app.getPath) {
                const base = app.getPath('userData');
                return isSourceCode() ? `${base}-dev` : base;
            }
        } catch {
            // fall through to the CLI resolution
        }
    }
    let userDataPath = getUserDataDir(getAppName());
    try {
        const fs = require('node:fs');
        if (!fs.existsSync(userDataPath)) {
            try {
                fs.mkdirSync(userDataPath, { recursive: true });
            } catch (mkdirError) {
                console.warn(
                    `[runtime] failed to create userData dir ${userDataPath} (${mkdirError.code || mkdirError.message}); falling back to cwd/userData`,
                );
                userDataPath = path.join(process.cwd(), 'userData');
                if (!fs.existsSync(userDataPath)) {
                    fs.mkdirSync(userDataPath, { recursive: true });
                }
            }
        }
    } catch {
        // No fs (Capacitor WebView) — return the stub path; writers fail-soft.
    }
    return userDataPath;
};

module.exports = {
    isElectron,
    isCapacitor,
    isHeadlessService,
    isCli,
    getPlatform,
    isPackaged,
    getOs,
    isDevelopment,
    isProduction,
    isTest,
    getEnvSnapshot,
    getUserDataDir,
    isSourceCode,
    getAppName,
    getAppUserDataPath,
};
