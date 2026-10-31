/**
 * The webview family's paths member: the OS-path reads delegated to
 * runtime.ts, whose Capacitor branches answer the stub paths of a WebView (no
 * fs behind them; writers fail-soft). The read-only resources are the webDir
 * the WebView document is served from, so resourcesPath answers the document
 * root the fetch readers resolve against, and a path below the app root is a
 * webDir-relative one.
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
    resourcesPath: () => './',
    appPath: (...segments) => segments.join('/'),
});

export { createWebviewPaths };
