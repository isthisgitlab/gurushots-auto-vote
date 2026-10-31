/**
 * The Capacitor page's platform: the webview family with the shell's native
 * members and windows — every part required, so a shell that forgets one
 * fails to compile. The native parts are the plugin-backed code: the services
 * the WebView page drives, the AutoVoteBackground wipe, and the bridge's
 * compare-and-write. The windows are the bridge's in-process settings emit
 * and the post-wipe reload. Installed when the module loads;
 * pages/Capacitor.tsx imports it first, before any other import.
 */

import { emit, reloadWindow } from './capacitor';
import { installPlatform } from '../platform/port';
import { createWebviewPlatform } from '../platforms/webview';
import * as androidUpdateInstaller from '../services/AndroidUpdateInstaller';
import * as foregroundService from '../services/ForegroundServiceController';
import * as NativeAutovoteBridge from '../services/NativeAutovoteBridge';
import { nativeWipe } from '../settings/localData';

const capacitorPlatform = createWebviewPlatform({
    // The native compare-and-write of one Preferences key, through the plugin (NativeAutovoteBridge).
    cas: NativeAutovoteBridge.compareAndWrite,
    // The AutoVoteBackground plugin's wipe of the native stores.
    nativeWipe,
    native: {
        autovote: NativeAutovoteBridge,
        foregroundService,
        apkInstaller: androidUpdateInstaller,
    },
    // The bridge's pub/sub emit and the WebView reload into the login screen.
    windows: {
        broadcastSettingsChanged: (newSettings) => emit('settings-changed', newSettings),
        afterWipe: () => {
            void reloadWindow();
        },
    },
});

installPlatform(capacitorPlatform);
