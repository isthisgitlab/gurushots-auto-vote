/**
 * The headless family's assets member: the fetch readers of the WebView asset
 * branches (thirdPartyNotices.ts, services/semantic/assets.ts,
 * services/visionVerifier.ts) — the bare service WebView shares the app
 * WebView's branches. The read is the shared fetchAsset reader of the
 * platform port's core; Phase 3 retires the loaders' private copies for it.
 */

import { fetchAsset } from '../../platform/fetchAsset';

import type { PlatformAssets } from '../../platform/port';

const createHeadlessAssets = (): PlatformAssets => ({
    readText: fetchAsset,
    readJson: async (relativePath: string): Promise<unknown> => {
        const parsed: unknown = JSON.parse(await fetchAsset(relativePath));
        return parsed;
    },
    visionModel: {
        // The WebView branch of visionVerifier getModelLocation: the model and
        // the wasm runtime sit beside the document the service loads.
        location: () => './',
        device: 'wasm',
    },
});

export { createHeadlessAssets };
