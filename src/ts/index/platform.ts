/**
 * The Electron shell's platform: the node family with the shell's own members
 * — the settings broadcast and the post-wipe relaunch of ipc/settings.handlers,
 * and the wipe's session clear of settings/localData, which ElectronPlatform
 * requires. Everything else is the family's (paths.isPackaged rides on
 * runtime.isPackaged, whose Electron branch reads app.isPackaged through the
 * guarded require). Installed when the module loads; index.ts imports it
 * first, before any core module. The wrapped modules are reached at call
 * time — the install must run before the logger loads — so this module's own
 * import chain is the port and the family builder only.
 */

import { installPlatform } from '../platform/port';
import { createNodePlatform } from '../platforms/node';

import type { ElectronPlatform, PlatformWindows } from '../platform/port';

type SettingsHandlersModule = typeof import('../ipc/settings.handlers');
type LocalDataModule = typeof import('../settings/localData');

// The install must run before the logger loads.
const settingsHandlers = (): SettingsHandlersModule => require('../ipc/settings.handlers') as SettingsHandlersModule;
// The install must run before the logger loads.
const localData = (): LocalDataModule => require('../settings/localData') as LocalDataModule;

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
        clearSession: () => localData().clearElectronSession(),
    },
});

installPlatform(installed);
