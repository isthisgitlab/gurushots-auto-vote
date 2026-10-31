/**
 * The headless family's paths member: the answers runtime.ts gave on the bare
 * service WebView (`__GS_HEADLESS__`, no Capacitor runtime). The OS branch
 * runs through the bundle's os shim on the device; the fail-soft body returns
 * the path without ever requiring a real file system. The app name comes from
 * the core app identity, asked at call time like every wrapped module. The
 * app-root members have no answer on the service — no service code resolves a
 * path below an app root, the read-only assets are fetched from the webDir —
 * so they throw rather than invent one.
 */

import type { PlatformPaths } from '../../platform/port';

type AppIdentityModule = typeof import('../../platform/appIdentity');
type FsModule = typeof import('node:fs');
type PathModule = typeof import('node:path');
type OsModule = typeof import('node:os');

// Reached at call time: the setup file loads the helpers that import this
// family, so an import-time module graph lands in the setup's registry before
// a test file registers its own mocks (platforms/node/index.ts states the
// reason in full).
const appIdentity = (): AppIdentityModule => require('../../platform/appIdentity') as AppIdentityModule;
const nodeFs = (): FsModule => require('node:fs') as FsModule;
const nodePath = (): PathModule => require('node:path') as PathModule;
const nodeOs = (): OsModule => require('node:os') as OsModule;

/**
 * The app's user-data directory does not exist and cannot be created. Same
 * error the node family throws: the service shares the message contract, and
 * families never import one another, so the class is declared here again.
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

// The platform-native user data directory of one app name (runtime's OS
// branch, minus the Capacitor stub — the service has no Capacitor runtime).
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

// The fail-soft body of runtime.getAppUserDataPath, without the Electron
// branch: the resolved directory is ensured once (owner-only), and a file
// system that is not there returns the path untouched — writers fail-soft.
const getUserDataPath = () => {
    const userDataPath = getUserDataDir(appIdentity().getAppName());
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
        // No fs (the bundle's require shim) — return the stub path; writers fail-soft.
    }
    return userDataPath;
};

const createHeadlessPaths = (): PlatformPaths => ({
    userData: getUserDataPath,
    getUserDataDir,
    isPackaged: () => false,
    isSourceCode: () => true,
    resourcesPath: () => {
        throw new Error('headless has no app-root path');
    },
    appPath: () => {
        throw new Error('headless has no app-root path');
    },
});

export { createHeadlessPaths, UserDataUnavailableError };
