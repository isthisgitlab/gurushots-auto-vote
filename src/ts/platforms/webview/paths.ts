/**
 * The webview family's paths member: the OS-path reads delegated to
 * runtime.ts, whose Capacitor branches answer the stub paths of a WebView (no
 * fs behind them; writers fail-soft). The app-root members have no answer on
 * the WebView — no WebView code resolves a path below an app root, the
 * read-only assets are fetched from the webDir — so they throw rather than
 * invent one.
 */

import type { PlatformPaths } from '../../platform/port';

type RuntimeModule = typeof import('../../runtime');

// Reached at call time: the setup file loads the helpers that import this
// family, so an import-time module graph (runtime's node:path and node:os)
// lands in the setup's registry before a test file registers its own mocks
// (platforms/node/index.ts states the reason in full).
const runtime = (): RuntimeModule => require('../../runtime') as RuntimeModule;

const createWebviewPaths = (): PlatformPaths => ({
    // The Capacitor branches of runtime: the stub path /<appName>, and the
    // native-runtime read of isPackaged (isNativePlatform).
    userData: () => runtime().getAppUserDataPath(),
    getUserDataDir: (appName) => runtime().getUserDataDir(appName),
    isPackaged: () => runtime().isPackaged(),
    isSourceCode: () => runtime().isSourceCode(),
    resourcesPath: () => {
        throw new Error('webview has no app-root path');
    },
    appPath: () => {
        throw new Error('webview has no app-root path');
    },
});

export { createWebviewPaths };
