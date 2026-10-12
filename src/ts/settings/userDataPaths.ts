/**
 * Where the settings and the other userData files live, and what the app knows of the environment it runs in.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as logger from '../logger';
const { isSourceCode, getAppName } = logger;
import * as runtime from '../runtime';
import type { App } from 'electron';
import { errorMessage } from '../errorMessage';

// Try to import electron, but don't fail if it's not available (CLI context)
let electronApp: App | null | undefined = null;
try {
    const electron = require('electron') as typeof import('electron');
    electronApp = electron.app;
} catch (error) {
    // Electron not available (CLI context), we'll use fallback
    logger.withCategory('ui').info('Running in CLI context - using fallback userData path:', errorMessage(error));
}

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

// When this process loaded, in ms: the anchor of the startup hold on auto-resume
// (scheduling/startupDelay.ts). Captured once, so a window reload does not move it.
const launchedAt = Date.now();

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
        launchedAt,
    };
};

export { electronApp, getSettingsPath, getDefaultMockSetting, getUserDataPath, getEnvironmentInfo };
