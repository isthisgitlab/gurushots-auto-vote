/**
 * The Electron shell's platform: the node family with the shell's own members
 * — the settings broadcast and the post-wipe relaunch of ipc/settings.handlers,
 * and the wipe's session clear, which ElectronPlatform requires. Everything
 * else is the family's (paths.isPackaged reads app.isPackaged through the
 * guarded require). Installed when the module loads; index.ts imports it
 * first, before any core module. The wrapped modules are reached at call
 * time — the install must run before the logger loads — so this module's own
 * import chain is the port and the family builder only.
 */

import { installPlatform } from '../platform/port';
import { createNodePlatform } from '../platforms/node';
import { APP_PARTITION } from './session';

import type { ElectronPlatform, PlatformWindows } from '../platform/port';

type SettingsHandlersModule = typeof import('../ipc/settings.handlers');

// The install must run before the logger loads.
const settingsHandlers = (): SettingsHandlersModule => require('../ipc/settings.handlers') as SettingsHandlersModule;

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

/** The Electron windows: every live window's settings broadcast, and the relaunch. */
const windows: PlatformWindows = {
    broadcastSettingsChanged: (newSettings) => settingsHandlers().broadcastSettingsChanged(newSettings),
    afterWipe: () => settingsHandlers().afterWipe(),
};

const electronPlatform = createNodePlatform(windows);
// The Electron wipe also clears the app's browser session; ElectronPlatform requires it.
const installed: ElectronPlatform = Object.assign(electronPlatform, {
    wipe: {
        ...electronPlatform.wipe,
        clearSession: clearElectronSession,
    },
});

installPlatform(installed);
