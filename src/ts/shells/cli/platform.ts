/**
 * The CLI shell's platform: the node family with the single binary's vision
 * runtime extractor injected — a SEA build's transformers load extracts the
 * embedded runtime (visionCliAssets) through it, and the model location is
 * the extracted root the family remembered while it is set, the source
 * checkout's .cache without it. The windows are the explicit no-ops of a
 * shell with no windows. Installed when the module loads; cli.ts imports it
 * first, before any core module. The wrapped modules are reached at call
 * time — the install must run before the logger loads — so this module's own
 * import chain is the port and the family builder only.
 */

import * as path from 'node:path';

import { installPlatform } from '../../core/platform/port';
import { createNodePlatform, extractedVisionRootOf } from '../../platforms/node';

import type { PlatformWindows } from '../../core/platform/port';

type VisionCliAssetsModule = typeof import('./visionCliAssets');

// The install must run before the logger loads.
const visionCliAssets = (): VisionCliAssetsModule => require('./visionCliAssets') as VisionCliAssetsModule;

// The CLI has no windows to broadcast to or relaunch.
const windows: PlatformWindows = {
    broadcastSettingsChanged: () => undefined,
    afterWipe: () => undefined,
};

const cliPlatform = createNodePlatform(windows, {
    extractVisionCliAssets: () => visionCliAssets().extractVisionCliAssets(),
});
// The extracted runtime root wins while it is set — the root the family's
// transformers load remembered; without it the family location stands (the
// source checkout's .cache). The family member is captured before the assets
// group is replaced, so the fallback delegates and never recurses.
const nodeModelLocation = cliPlatform.assets.visionModel.location;
cliPlatform.assets = {
    ...cliPlatform.assets,
    visionModel: {
        ...cliPlatform.assets.visionModel,
        location: () => {
            const root = extractedVisionRootOf();
            return root === undefined ? nodeModelLocation() : `${root}${path.sep}`;
        },
    },
};

installPlatform(cliPlatform);
