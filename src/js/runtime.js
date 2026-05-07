/**
 * Runtime mode and OS-path resolution. The single allowed reader of
 * process.env so the rest of the codebase isn't sprinkled with env
 * lookups. Pure Node — no Electron, no logger import — so it can be
 * required from anywhere including bootstrap paths.
 */

const path = require('path');
const os = require('os');

const isDevelopment = () => (
    process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'dev'
    || process.env.DEV === 'true' || process.env.DEV === '1'
);

const isProduction = () => (
    process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod'
    || process.env.PROD === 'true' || process.env.PROD === '1'
);

const isTest = () => process.env.NODE_ENV === 'test';

const getEnvSnapshot = () => ({
    nodeEnv: process.env.NODE_ENV,
    dev: process.env.DEV,
    prod: process.env.PROD,
});

// Platform-native user data directory. The Windows branch falls back
// to the manual AppData path when APPDATA isn't set (some shells/CI).
const getUserDataDir = (appName) => {
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
    isDevelopment,
    isProduction,
    isTest,
    getEnvSnapshot,
    getUserDataDir,
};
