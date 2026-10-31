/**
 * The headless service's platform: the headless family with the explicit
 * no-op windows of a service with no windows — the service itself is the
 * native side, and it reports through AndroidHeadlessBridge, not a broadcast.
 * Installed when the module loads; headless/index.ts imports it first, before
 * any core module. Safe at first import in a bare WebView: building the
 * family loads no module graph (platforms/headless/index.ts).
 */

import { installPlatform } from '../platform/port';
import { createHeadlessPlatform } from '../platforms/headless';

// No windows: the service has none to broadcast to or relaunch.
installPlatform(
    createHeadlessPlatform({
        broadcastSettingsChanged: () => undefined,
        afterWipe: () => undefined,
    }),
);
