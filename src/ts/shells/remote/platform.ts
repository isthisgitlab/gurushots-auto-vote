/**
 * The remote shell's platform: the same node family the web shell installs, with explicit
 * no-op windows — the phone keeps no local settings (the desktop's are relayed) and never
 * runs a wipe. Installed when the module loads, before anything else of the shell loads; the
 * page entry imports it first.
 */

import { installPlatform } from '../../core/platform/port';
import { createNodePlatform } from '../../platforms/node';

import type { PlatformWindows } from '../../core/platform/port';

const windows: PlatformWindows = {
    // A settings change happens on the desktop and arrives relayed; nothing is broadcast locally.
    broadcastSettingsChanged: () => {},
    // "Delete all local data" is refused to a remote peer; there is nothing to run after a wipe.
    afterWipe: () => {},
};

installPlatform(createNodePlatform(windows));
