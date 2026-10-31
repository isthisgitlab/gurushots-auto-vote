/**
 * The Electron shell's platform: the node family with the shell's own members
 * — the settings broadcast and the post-wipe relaunch of ipc/settings.handlers,
 * and the wipe's session clear of settings/localData, which ElectronPlatform
 * requires. Everything else is the family's (paths.isPackaged rides on
 * runtime.isPackaged, whose Electron branch reads app.isPackaged through the
 * guarded require). Installed when the module loads; index.ts imports it
 * first, before any core module.
 */

import { afterWipe, broadcastSettingsChanged } from '../ipc/settings.handlers';
import { installPlatform } from '../platform/port';
import { createNodePlatform } from '../platforms/node';
import { clearElectronSession } from '../settings/localData';

import type { ElectronPlatform, PlatformWindows } from '../platform/port';

/** The Electron windows: every live window's settings broadcast, and the relaunch. */
const windows: PlatformWindows = { broadcastSettingsChanged, afterWipe };

const electronPlatform = createNodePlatform(windows);
// The Electron wipe also clears the app's browser session; ElectronPlatform requires it.
const installed: ElectronPlatform = Object.assign(electronPlatform, {
    wipe: { ...electronPlatform.wipe, clearSession: clearElectronSession },
});

installPlatform(installed);
