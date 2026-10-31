/**
 * The webview family's assets member: the fetch readers of the WebView asset
 * branches (thirdPartyNotices.ts, services/semantic/assets.ts) and the vision
 * model's location and device there (services/visionVerifier.ts). The read is
 * the shared fetchAsset reader of the platform port's core; Phase 3 retires
 * the loaders' private copies for it.
 */

import { fetchAsset } from '../../platform/fetchAsset';

import type { PlatformAssets } from '../../platform/port';

const createWebviewAssets = (): PlatformAssets => ({
    readText: fetchAsset,
    readJson: async (relativePath: string): Promise<unknown> => {
        const parsed: unknown = JSON.parse(await fetchAsset(relativePath));
        return parsed;
    },
    visionModel: {
        // The WebView branch of visionVerifier getModelLocation: the model and
        // the wasm runtime sit in the webDir the document resolves against.
        location: () => './',
        device: 'wasm',
    },
});

export { createWebviewAssets };
