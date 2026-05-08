/**
 * Runtime mode, platform detection, and OS-path resolution. The single
 * allowed reader of process.env so the rest of the codebase isn't
 * sprinkled with env lookups. Pure Node — no Electron, no logger
 * import — so it can be required from anywhere including bootstrap
 * paths. Electron is touched only via a guarded require() inside
 * isPackaged() and only when isElectron() is already true.
 */

const path = require('path');
const os = require('os');

const hasNode = typeof process !== 'undefined' && process.versions != null;
const getCapacitor = () => globalThis.Capacitor;

const isElectron = () => hasNode && process.versions.electron != null;

const isCapacitor = () => {
    const cap = getCapacitor();
    return cap != null && typeof cap.isNativePlatform === 'function';
};

const isCli = () => hasNode && !isElectron();

const getPlatform = () => {
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

module.exports = {
    isElectron,
    isCapacitor,
    isCli,
    getPlatform,
    isPackaged,
    getOs,
    isDevelopment,
    isProduction,
    isTest,
    getEnvSnapshot,
    getUserDataDir,
};
