/**
 * The webview family's assets member: the fetch readers of the WebView asset
 * branches (thirdPartyNotices.ts, services/semantic/assets.ts) and the vision
 * model's answers there (services/visionVerifier.ts). The read is the shared
 * fetchAsset reader of the platform port's core; the model and the wasm
 * runtime sit in the webDir the document resolves against.
 */

import { fetchAsset } from '../../core/platform/fetchAsset';

import type { PlatformAssets } from '../../core/platform/port';

const createWebviewAssets = (): PlatformAssets => ({
    readText: fetchAsset,
    readJson: async (relativePath: string): Promise<unknown> => {
        const parsed: unknown = JSON.parse(await fetchAsset(relativePath));
        return parsed;
    },
    visionModel: {
        location: () => './',
        device: 'wasm',
        // The webDir carries the model when the build is not --lite.
        bundled: async (): Promise<boolean> => {
            const response = await fetch('vision-model/config.json').catch(() => null);
            return Boolean(response?.ok);
        },
        loadTransformers: async () => import('@huggingface/transformers'),
    },
});

export { createWebviewAssets };
