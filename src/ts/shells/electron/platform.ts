/**
 * The Electron shell's platform: the node family with the shell's own members
 * — the settings broadcast and the post-wipe relaunch, and the wipe's session
 * clear, which ElectronPlatform requires. Everything else is the family's
 * (paths.isPackaged reads app.isPackaged through the guarded require).
 * Installed when the module loads; index.ts imports it first, before any core
 * module. The electron reads are reached at call time — the install must run
 * before the logger loads — so this module's own import chain is the port and
 * the family builder only.
 */

import { installPlatform } from '../../core/platform/port';
import { createNodePlatform } from '../../platforms/node';
import { APP_PARTITION } from './index/session';

import type { BroadcastSettingsChange } from '../../core/ipc/settingsThinHandlers';
import type { ElectronPlatform, PlatformWindows } from '../../core/platform/port';

/** The electron session the app's windows use, for the wipe to clear its cookies, local storage and cache. */
const appSession = () => (require('electron') as typeof import('electron')).session.fromPartition(APP_PARTITION);

/**
 * Clears the cookies, local storage and cache of the app's windows' session and Electron's default session — the
 * wipe's clearSession on Electron.
 */
const clearElectronSession = async (): Promise<void> => {
    // The default session writes its cookies, storage and caches at the user-data root, beside the app's files.
    const { session } = require('electron') as typeof import('electron');
    for (const target of [appSession(), session.defaultSession]) {
        await target.clearStorageData();
        await target.clearCache();
    }
};

/**
 * Sends the new settings to every window — the handlers' broadcast through the platform's windows.
 */
const broadcastSettingsChanged: BroadcastSettingsChange = (newSettings) => {
    // A window closing mid-save must not turn a landed write into a
    // reported failure (a send to a destroyed window throws).
    const { BrowserWindow } = require('electron') as typeof import('electron');
    BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) win.webContents.send('settings-changed', newSettings);
    });
};

// The window is closed by the exit, so the reply to the wipe is let out first.
const afterWipe = () => {
    setTimeout(() => {
        const { app } = require('electron') as typeof import('electron');
        app.relaunch();
        app.exit(0);
    }, 200);
};

/** The Electron windows: every live window's settings broadcast, and the relaunch. */
const windows: PlatformWindows = { broadcastSettingsChanged, afterWipe };

const electronPlatform = createNodePlatform(windows);
// The Electron wipe also clears the app's browser session; ElectronPlatform requires it.
const installed: ElectronPlatform = Object.assign(electronPlatform, {
    wipe: {
        ...electronPlatform.wipe,
        clearSession: clearElectronSession,
    },
});

installPlatform(installed);
