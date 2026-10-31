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

import type { PlatformNative } from '../platform/port';

type CapacitorBridgeModule = typeof import('./capacitor');
type NativeAutovoteBridgeModule = typeof import('../services/NativeAutovoteBridge');
type ForegroundServiceModule = typeof import('../services/ForegroundServiceController');
type ApkInstallerModule = typeof import('../services/AndroidUpdateInstaller');
type LocalDataModule = typeof import('../settings/localData');

// The install must run before the logger loads.
const capacitorBridge = (): CapacitorBridgeModule => require('./capacitor') as CapacitorBridgeModule;
// The install must run before the logger loads.
const nativeAutovoteBridge = (): NativeAutovoteBridgeModule =>
    require('../services/NativeAutovoteBridge') as NativeAutovoteBridgeModule;
// The install must run before the logger loads.
const foregroundService = (): ForegroundServiceModule =>
    require('../services/ForegroundServiceController') as ForegroundServiceModule;
// The install must run before the logger loads.
const apkInstaller = (): ApkInstallerModule => require('../services/AndroidUpdateInstaller') as ApkInstallerModule;
// The install must run before the logger loads.
const localData = (): LocalDataModule => require('../settings/localData') as LocalDataModule;

const capacitorPlatform = createWebviewPlatform({
    // The native compare-and-write of one Preferences key, through the
    // plugin (NativeAutovoteBridge).
    cas: (key: string, expected: string | null, data: string) =>
        nativeAutovoteBridge().compareAndWrite(key, expected, data),
    // The AutoVoteBackground plugin's wipe of the native stores (localData's nativeWipe).
    nativeWipe: () => localData().nativeWipe(),
    native: {
        get autovote(): NativeAutovoteBridgeModule {
            return nativeAutovoteBridge();
        },
        get foregroundService(): ForegroundServiceModule {
            return foregroundService();
        },
        get apkInstaller(): ApkInstallerModule {
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
