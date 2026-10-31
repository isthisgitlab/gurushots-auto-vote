/**
 * The node family's paths member (Electron main, CLI, web server): the OS
 * paths and the app's own file paths, delegated to runtime.ts and
 * appPaths.ts. The wrapped modules are reached at call time (see index.ts
 * for why), so every member resolves the code it delegates to, and the value
 * it answers, on each call.
 */

import type { PlatformPaths } from '../../platform/port';

type RuntimeModule = typeof import('../../runtime');
type AppPathsModule = typeof import('../../appPaths');

const runtime = (): RuntimeModule => require('../../runtime') as RuntimeModule;
const appPaths = (): AppPathsModule => require('../../appPaths') as AppPathsModule;

const createNodePaths = (): PlatformPaths => ({
    userData: () => runtime().getAppUserDataPath(),
    getUserDataDir: (appName) => runtime().getUserDataDir(appName),
    isPackaged: () => runtime().isPackaged(),
    isSourceCode: () => runtime().isSourceCode(),
    // The packaged-Electron branch of the vision model's location
    // (visionVerifier getModelLocation): from source, the resources are the
    // app root's own (src/assets, .cache).
    resourcesPath: () =>
        runtime().isElectron() && runtime().isPackaged() ? process.resourcesPath : appPaths().appPath(),
    appPath: (...segments) => appPaths().appPath(...segments),
});

export { createNodePaths };
