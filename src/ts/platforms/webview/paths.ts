/**
 * The webview family's paths member: the stub paths of a WebView (no fs
 * behind them; writers fail-soft). The app name comes from the core app
 * identity, asked at call time like every wrapped module. The app-root
 * members have no answer on the WebView — no WebView code resolves a path
 * below an app root, the read-only assets are fetched from the webDir — so
 * they throw rather than invent one.
 */

import type { CapacitorGlobals } from '../../core/types/capacitor';
import type { PlatformPaths } from '../../core/platform/port';

type AppIdentityModule = typeof import('../../core/platform/appIdentity');

// Reached at call time: the setup file loads the helpers that import this
// family, so an import-time module graph lands in the setup's registry before
// a test file registers its own mocks (platforms/node/index.ts states the
// reason in full).
const appIdentity = (): AppIdentityModule => require('../../core/platform/appIdentity') as AppIdentityModule;

const createWebviewPaths = (): PlatformPaths => ({
    // The Capacitor branches of runtime: the stub path /<appName>, and the
    // native-runtime read of isPackaged (isNativePlatform).
    userData: () => `/${appIdentity().getAppName()}`,
    // No Electron dev dir exists on the WebView: the notice is a no-op.
    warnLegacyDevDir: () => undefined,
    getUserDataDir: (appName) => `/${appName}`,
    isPackaged: () => {
        const cap = (globalThis as CapacitorGlobals).Capacitor;
        return cap != null && typeof cap.isNativePlatform === 'function' ? cap.isNativePlatform() : false;
    },
    // Never Electron: the native runtime's packaged read (isPackaged above)
    // is the device's, not the desktop app's.
    isElectronPackaged: () => false,
    isSourceCode: () => true,
    resourcesPath: () => {
        throw new Error('webview has no app-root path');
    },
    appPath: () => {
        throw new Error('webview has no app-root path');
    },
});

export { createWebviewPaths };
