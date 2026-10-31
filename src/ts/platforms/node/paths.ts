/**
 * The node family's paths member (Electron main, CLI, web server): the OS
 * paths, the app's own file paths, and the packaged-build / source detection.
 * The Electron read the bodies branch on is the family's own; every wrapped
 * module is reached at call time (see index.ts for why), so every member
 * resolves the code it needs, and the value it answers, on each call.
 */

import type { PlatformPaths } from '../../platform/port';

type AppPathsModule = typeof import('../../appPaths');
type AppIdentityModule = typeof import('../../platform/appIdentity');
type LoggerModule = typeof import('../../logger');
type FsModule = typeof import('node:fs');
type PathModule = typeof import('node:path');
type OsModule = typeof import('node:os');

// See the header: the wrapped modules, reached at call time.
const appPaths = (): AppPathsModule => require('../../appPaths') as AppPathsModule;
const appIdentity = (): AppIdentityModule => require('../../platform/appIdentity') as AppIdentityModule;
const logger = (): LoggerModule => require('../../logger') as LoggerModule;
const nodeFs = (): FsModule => require('node:fs') as FsModule;
const nodePath = (): PathModule => require('node:path') as PathModule;
const nodeOs = (): OsModule => require('node:os') as OsModule;

/**
 * Whether this node process is the Electron main process (the
 * `process.versions.electron` read). The paths, assets and capabilities
 * members branch on it; the WebView families know what they run on and need
 * no equivalent.
 */
const isElectron = () =>
    typeof process !== 'undefined' && process.versions != null && process.versions.electron != null;

/**
 * The app's user-data directory does not exist and cannot be created. The message says what happened, why and what to
 * do next, so a shell can show it as it is.
 */
class UserDataUnavailableError extends Error {
    readonly path: string;
    constructor(userDataPath: string, reason: string) {
        super(
            `The app's data folder ${userDataPath} does not exist and could not be created (${reason}). Settings and the login are not stored anywhere else, so nothing was started. Create the folder, or make its parent writable by this account, and run again.`,
        );
        this.name = 'UserDataUnavailableError';
        this.path = userDataPath;
    }
}

// The platform-native user data directory of one app name. The Windows branch falls back to the manual
// AppData path when APPDATA isn't set (some shells/CI). The Capacitor stub of the WebView bundles is the
// webview family's answer — this family always has a file system.
const getUserDataDir = (appName: string): string => {
    switch (process.platform) {
        case 'darwin':
            return nodePath().join(nodeOs().homedir(), 'Library', 'Application Support', appName);
        case 'win32':
            return nodePath().join(
                process.env.APPDATA || nodePath().join(nodeOs().homedir(), 'AppData', 'Roaming'),
                appName,
            );
        default:
            return nodePath().join(nodeOs().homedir(), '.config', appName);
    }
};

/**
 * Detect running-from-source vs a built app (packaged Electron, SEA CLI,
 * or asar). Drives the -dev suffix so dev state never pollutes prod state.
 */
const isSourceCode = () => {
    if (isElectron()) {
        try {
            if ((require('electron') as typeof import('electron')).app?.isPackaged) return false;
        } catch {
            // Electron module unavailable despite the version flag — treat as source.
        }
    }
    try {
        if ((require('node:sea') as typeof import('node:sea')).isSea()) return false;
    } catch {
        // node:sea unavailable — fall through to other detection
    }
    // Safety net for code loaded from an asar outside the packaged-Electron
    // path (e.g. ELECTRON_RUN_AS_NODE, where require('electron') has no app).
    // __dirname is fixed by the module wrapper, so a test can't place it in an asar.
    /* istanbul ignore if */
    if (__dirname.includes('.asar')) return false;
    return true;
};

const isPackaged = () => {
    if (isElectron()) {
        try {
            return (require('electron') as typeof import('electron')).app.isPackaged;
        } catch {
            return false;
        }
    }
    return false;
};

// One-shot notice if a legacy dev directory exists elsewhere. The legacy
// Electron dev location is `<parent>/gurushots-auto-vote-dev`, while the
// resolved user-data path appends `-dev` to userData. When the two differ
// (userData basename ≠ package name) the legacy dir may still hold a
// settings.json. It fires when the settings path is resolved, which calls
// userData() — the one-shot flag lives with the body that resolves the path.
let legacyDevDirChecked = false;
/** @param userDataPath */
const warnIfLegacyDevDir = (userDataPath: string) => {
    if (legacyDevDirChecked) return;
    legacyDevDirChecked = true;
    try {
        const electronApp = isElectron() ? (require('electron') as typeof import('electron')).app : null;
        if (!(electronApp && electronApp.getPath) || !isSourceCode()) return;
        const legacy = nodePath().join(nodePath().dirname(electronApp.getPath('userData')), 'gurushots-auto-vote-dev');
        if (legacy !== userDataPath && nodeFs().existsSync(nodePath().join(legacy, 'settings.json'))) {
            logger()
                .withCategory('settings')
                .warning(
                    `Dev settings found at ${legacy}, but settings are read from ${userDataPath} — move settings.json there if your values look reset`,
                );
        }
    } catch {
        // Purely informational — never block settings resolution.
    }
};

// The app's user-data directory, resolved identically for every consumer
// (logger, settings storage, scripts):
//   - Electron: app.getPath('userData'), with `-dev` appended when running
//     from source (canonical dev form).
//   - CLI/SEA: the platform-native dir for getAppName(), created on first
//     use.
// A directory that cannot be created throws UserDataUnavailableError: settings, tokens and logs are never put
// anywhere else. Bootstrap-safe: no logger import. The CLI branch resolves
// the directory through the member, so a member override is what it answers.
const createNodePaths = (): PlatformPaths => {
    const getAppUserDataPath = () => {
        if (isElectron()) {
            try {
                const app = (require('electron') as typeof import('electron')).app;
                if (app && app.getPath) {
                    const base = app.getPath('userData');
                    return isSourceCode() ? `${base}-dev` : base;
                }
            } catch {
                // fall through to the CLI resolution
            }
        }
        const userDataPath = paths.getUserDataDir(appIdentity().getAppName());
        try {
            const fs = nodeFs();
            if (!fs.existsSync(userDataPath)) {
                try {
                    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
                } catch (error) {
                    const mkdirError = error as NodeJS.ErrnoException;
                    throw new UserDataUnavailableError(userDataPath, mkdirError.code || mkdirError.message);
                }
            }
        } catch (error) {
            if (error instanceof UserDataUnavailableError) throw error;
            // No fs — return the stub path; writers fail-soft.
        }
        return userDataPath;
    };

    const paths: PlatformPaths = {
        userData: () => {
            const userDataPath = getAppUserDataPath();
            warnIfLegacyDevDir(userDataPath);
            return userDataPath;
        },
        getUserDataDir,
        isPackaged,
        isSourceCode,
        // The packaged-Electron branch of the vision model's location
        // (visionVerifier getModelLocation): from source, the resources are the
        // app root's own (src/assets, .cache).
        resourcesPath: () => (isElectron() && isPackaged() ? process.resourcesPath : appPaths().appPath()),
        appPath: (...segments) => appPaths().appPath(...segments),
    };
    return paths;
};

export { createNodePaths, getUserDataDir, isElectron, isPackaged, isSourceCode, UserDataUnavailableError };
