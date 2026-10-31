/**
 * Where the settings and the other userData files live, and what the app knows of the environment it runs in.
 * The user-data resolution and the app identity are the installed platform's (platform().paths, the core app
 * identity); the one-shot legacy dev-dir notice lives with the body that resolves the path (the node family's
 * paths member), so the notice fires here through the same call.
 */

import * as path from 'node:path';
import * as runtime from '../runtime';
import { platform } from '../platform/port';
import { getAppName } from '../platform/appIdentity';

// Define the configuration file path in the userData directory. Resolution lives behind platform().paths.userData —
// the ONE implementation shared with the logger, so logs and settings can never land in different directories.
const getSettingsPath = () => {
    const userDataPath = platform().paths.userData();
    // The one-shot legacy dev-dir notice runs here, at the settings-path
    // resolution: a userData()-time call ran while the logger loaded and
    // re-entered it half-loaded, so the notice was lost.
    platform().paths.warnLegacyDevDir(userDataPath);
    return path.join(userDataPath, 'config.json');
};

// The `settings.json` the configuration is imported from, beside it.
const getLegacySettingsPath = () => path.join(path.dirname(getSettingsPath()), 'settings.json');

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

// When this process loaded, in ms: the anchor of the startup hold on auto-resume
// (scheduling/startupDelay.ts). Captured once, so a window reload does not move it.
const launchedAt = Date.now();

// Get current environment information
const getEnvironmentInfo = () => {
    const isElectronPackaged = platform().paths.isElectronPackaged();
    const isBuiltApp = isElectronPackaged || !platform().paths.isSourceCode();

    return {
        ...runtime.getEnvSnapshot(),
        defaultMock: getDefaultMockSetting(),
        platform: process.platform,
        userDataPath: getUserDataPath(),
        isSourceCode: platform().paths.isSourceCode(),
        isElectronPackaged: isElectronPackaged,
        isBuiltApp: isBuiltApp,
        appName: getAppName(),
        launchedAt,
    };
};

export { getSettingsPath, getLegacySettingsPath, getDefaultMockSetting, getUserDataPath, getEnvironmentInfo };
