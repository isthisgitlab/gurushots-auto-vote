/**
 * The web shell's platform: the node family with the web server's windows —
 * the settings broadcast and the wipe stop of the server this process runs.
 * The server registers its per-run event fan-out and wipe stop here
 * (createWebServer, through setWebShellRun), because the platform installs
 * once, before any server exists. Installed when the module loads;
 * scripts/web-server.ts and web/server.ts import the same module, which
 * evaluates once.
 */

import { installPlatform } from '../platform/port';
import { createNodePlatform } from '../platforms/node';

import type { PlatformWindows } from '../platform/port';

/** What one run of the web server gives the platform's windows. */
type WebShellRun = {
    /** Broadcasts an event to every connected browser. */
    emit: (channel: string, payload?: unknown) => void;
    /** Stops the server once a wipe has succeeded. */
    afterWipe: () => void;
};

// The running server's fan-out and wipe stop; null when none runs. At most
// one server runs in this process, and createWebServer replaces the run at
// each start.
let run: WebShellRun | null = null;

/**
 * Registers the running server's fan-out and wipe stop — the platform's
 * windows delegate here. `null` says no server is running.
 */
const setWebShellRun = (next: WebShellRun | null): void => {
    run = next;
};

const windows: PlatformWindows = {
    // The connected browsers of the run that is live when the change lands.
    broadcastSettingsChanged: (newSettings) => run?.emit('settings-changed', newSettings),
    // The wipe stop: it ends the event streams and stops listening once the reply is out.
    afterWipe: () => run?.afterWipe(),
};

installPlatform(createNodePlatform(windows));

export { setWebShellRun };
