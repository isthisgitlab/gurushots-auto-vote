/**
 * The headless family's paths member: the OS-path reads delegated to
 * runtime.ts, answered the way runtime answers them on the bare service
 * WebView. The app-root members have no answer on the service — no service
 * code resolves a path below an app root, the read-only assets are fetched
 * from the webDir — so they throw rather than invent one.
 */

import type { PlatformPaths } from '../../platform/port';

type RuntimeModule = typeof import('../../runtime');

// Reached at call time: the setup file loads the helpers that import this
// family, so an import-time module graph (runtime's node:path and node:os)
// lands in the setup's registry before a test file registers its own mocks
// (platforms/node/index.ts states the reason in full).
const runtime = (): RuntimeModule => require('../../runtime') as RuntimeModule;

const createHeadlessPaths = (): PlatformPaths => ({
    userData: () => runtime().getAppUserDataPath(),
    getUserDataDir: (appName) => runtime().getUserDataDir(appName),
    isPackaged: () => runtime().isPackaged(),
    isSourceCode: () => runtime().isSourceCode(),
    resourcesPath: () => {
        throw new Error('headless has no app-root path');
    },
    appPath: () => {
        throw new Error('headless has no app-root path');
    },
});

export { createHeadlessPaths };
