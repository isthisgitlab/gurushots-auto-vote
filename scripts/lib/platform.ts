/**
 * The scripts' platform: plain Node — the node family with the explicit
 * no-op windows of a script run. Installed when the module loads; the script
 * entries (build-lexicon.ts, validate-lexicon.ts, build-cli.ts) import it
 * first, before any app module.
 */

import { installPlatform } from '../../src/ts/platform/port';
import { createNodePlatform } from '../../src/ts/platforms/node';

// No windows: a script runs no UI to broadcast to or relaunch.
installPlatform(
    createNodePlatform({
        broadcastSettingsChanged: () => undefined,
        afterWipe: () => undefined,
    }),
);
