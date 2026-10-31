/**
 * The CLI shell's platform: the node family with the single binary's vision
 * model location — the SEA build resolves it into the runtime the build
 * extracted (visionCliAssets, via visionVerifier's cliAssetRoot, set once
 * loadClassifier has extracted it) instead of the source checkout's .cache.
 * The windows are the explicit no-ops of a shell with no windows. Installed
 * when the module loads; cli.ts imports it first, before any core module.
 */

import * as path from 'node:path';

import { installPlatform } from '../platform/port';
import { createNodePlatform } from '../platforms/node';
import { getCliAssetRoot } from '../services/visionVerifier';

import type { PlatformWindows } from '../platform/port';

// The CLI has no windows to broadcast to or relaunch.
const windows: PlatformWindows = {
    broadcastSettingsChanged: () => undefined,
    afterWipe: () => undefined,
};

const cliPlatform = createNodePlatform(windows);
// The extracted runtime root wins while it is set — today's first branch of
// visionVerifier getModelLocation; without it the family's location stands
// (the source checkout's .cache). The family member is captured before the
// assets group is replaced, so the fallback delegates and never recurses.
const nodeModelLocation = cliPlatform.assets.visionModel.location;
cliPlatform.assets = {
    ...cliPlatform.assets,
    visionModel: {
        device: cliPlatform.assets.visionModel.device,
        location: () => {
            const root = getCliAssetRoot();
            return root === undefined ? nodeModelLocation() : `${root}${path.sep}`;
        },
    },
};

installPlatform(cliPlatform);
