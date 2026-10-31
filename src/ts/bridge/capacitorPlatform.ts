/**
 * The Capacitor page's platform: the webview family with the shell's native
 * members and windows — every part required, so a shell that forgets one
 * fails to compile. The native parts are the plugin-backed code: the services
 * the WebView page drives, the AutoVoteBackground wipe, and the bridge's
 * compare-and-write. The windows are the bridge's in-process settings emit
 * and the post-wipe reload. The wrapped modules are reached at call time —
 * the install must run before the logger loads — so this module's own import
 * chain is the port and the family builder only. Installed when the module
 * loads; pages/Capacitor.tsx imports it first, before any other import.
 */

import { installPlatform } from '../platform/port';
import { createWebviewPlatform } from '../platforms/webview';
import { isPlainObject } from '../plainObject';

import type { CapacitorGlobals } from '../types/capacitor';
import type {
    PlatformApkInstaller,
    PlatformAutovote,
    PlatformForegroundService,
    PlatformNative,
} from '../platform/port';

type CapacitorBridgeModule = typeof import('./capacitor');

// The install must run before the logger loads.
const capacitorBridge = (): CapacitorBridgeModule => require('./capacitor') as CapacitorBridgeModule;
// The install must run before the logger loads.
const nativeAutovoteBridge = (): PlatformAutovote => require('../services/NativeAutovoteBridge') as PlatformAutovote;
// The install must run before the logger loads.
const foregroundService = (): PlatformForegroundService =>
    require('../services/ForegroundServiceController') as PlatformForegroundService;
// The install must run before the logger loads.
const apkInstaller = (): PlatformApkInstaller => require('../services/AndroidUpdateInstaller') as PlatformApkInstaller;

/**
 * The native plugin's wipe (AutoVoteBackground.wipeLocalData), or null where the build has none. Asked on the wipe.
 */
const nativeWipe = async (): Promise<{ ok: boolean } | null> => {
    const plugin = (globalThis as CapacitorGlobals).Capacitor?.Plugins?.AutoVoteBackground;
    if (typeof plugin?.wipeLocalData !== 'function') return null;
    const answer: unknown = await plugin.wipeLocalData();
    return isPlainObject(answer) ? { ok: answer.ok === true } : { ok: false };
};

const capacitorPlatform = createWebviewPlatform({
    // The native compare-and-write of one Preferences key, through the
    // plugin (NativeAutovoteBridge).
    cas: (key: string, expected: string | null, data: string) =>
        nativeAutovoteBridge().compareAndWrite(key, expected, data),
    // The AutoVoteBackground plugin's wipe of the native stores.
    nativeWipe,
    native: {
        get autovote(): PlatformAutovote {
            return nativeAutovoteBridge();
        },
        get foregroundService(): PlatformForegroundService {
            return foregroundService();
        },
        get apkInstaller(): PlatformApkInstaller {
            return apkInstaller();
        },
    } satisfies PlatformNative,
    // The bridge's pub/sub emit and the WebView reload into the login screen.
    windows: {
        broadcastSettingsChanged: (newSettings) => capacitorBridge().emit('settings-changed', newSettings),
        afterWipe: () => {
            void capacitorBridge().reloadWindow();
        },
    },
});

installPlatform(capacitorPlatform);
