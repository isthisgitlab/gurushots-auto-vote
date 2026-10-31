/**
 * The headless family's assets member: the fetch readers of the WebView asset
 * branches (thirdPartyNotices.ts, services/semantic/assets.ts,
 * services/visionVerifier.ts) — the bare service WebView shares the app
 * WebView's branches. The read is the shared fetchAsset reader of the
 * platform port's core; the model and the wasm runtime sit beside the
 * document the service loads.
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
        location: () => './',
        device: 'wasm',
        // The served webDir carries the model when the build is not --lite.
        bundled: async (): Promise<boolean> => {
            const response = await fetch('vision-model/config.json').catch(() => null);
            return Boolean(response?.ok);
        },
        loadTransformers: async () => import('@huggingface/transformers'),
    },
});

export { createHeadlessAssets };
