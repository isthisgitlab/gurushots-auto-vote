/**
 * The Capacitor page's platform: the webview family with the shell's native
 * members and windows — every part required, so a shell that forgets one
 * fails to compile. The native parts are the plugin-backed code: the services
 * the WebView page drives, the AutoVoteBackground wipe, and the bridge's
 * compare-and-write. The windows are the bridge's in-process settings emit
 * and the post-wipe reload. The wrapped modules are reached at call time —
 * the install must run before the logger loads — so this module's own import
 * chain is the port and the family builder only. Installed when the module
 * loads; shells/capacitor/page.tsx imports it first, before any other import.
 */

import { installPlatform } from '../../core/platform/port';
import { createWebviewPlatform } from '../../platforms/webview';
import { isPlainObject } from '../../core/plainObject';

import type { CapacitorGlobals } from '../../core/types/capacitor';
import type {
    PlatformApkInstaller,
    PlatformAutovote,
    PlatformForegroundService,
    PlatformNative,
} from '../../core/platform/port';

type CapacitorBridgeModule = typeof import('./bridge/capacitor');
type NativeAutovoteBridgeModule = typeof import('./NativeAutovoteBridge');
type ForegroundServiceModule = typeof import('./ForegroundServiceController');
type ApkInstallerModule = typeof import('./AndroidUpdateInstaller');

// The install must run before the logger loads. The requires are cast to the
// real modules' own types, so the `satisfies PlatformNative` below checks
// each real module against its port type instead of the port against itself.
const capacitorBridge = (): CapacitorBridgeModule => require('./bridge/capacitor') as CapacitorBridgeModule;
const nativeAutovoteBridge = (): NativeAutovoteBridgeModule =>
    require('./NativeAutovoteBridge') as NativeAutovoteBridgeModule;
const foregroundService = (): ForegroundServiceModule =>
    require('./ForegroundServiceController') as ForegroundServiceModule;
const apkInstaller = (): ApkInstallerModule => require('./AndroidUpdateInstaller') as ApkInstallerModule;

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
