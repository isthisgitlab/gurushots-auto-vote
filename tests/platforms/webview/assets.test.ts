/**
 * The webview family's assets member: the readJson composition over the
 * shared fetchAsset reader (fetchAsset itself is proven in
 * tests/platform/fetchAsset.test.ts) and the vision model's answers there.
 * fetch is stubbed the way the loaders' own tests stub it.
 */

import { invalid } from '../../helpers/invalid';
import { createWebviewAssets } from '../../../src/ts/platforms/webview/assets';

const realFetch = globalThis.fetch;
const mockTransformers = { env: {}, pipeline: jest.fn() };
jest.mock('@huggingface/transformers', () => mockTransformers);

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe('readJson', () => {
    test('it parses the fetched text', async () => {
        globalThis.fetch = invalid<typeof fetch>(
            jest.fn(async () => ({ ok: true, status: 200, text: async () => '{"a":1}' })),
        );
        await expect(createWebviewAssets().readJson('semantic-vectors.json')).resolves.toEqual({ a: 1 });
    });
});

describe('visionModel', () => {
    test('the model lives in the web root, and inference runs on the wasm backend', () => {
        const model = createWebviewAssets().visionModel;
        expect(model.location()).toBe('./');
        expect(model.device).toBe('wasm');
    });

    test('bundled is the model config fetch: ok true, a miss and a failed fetch are not', async () => {
        globalThis.fetch = invalid<typeof fetch>(jest.fn(async () => ({ ok: true, status: 200 })));
        await expect(createWebviewAssets().visionModel.bundled()).resolves.toBe(true);
        expect(globalThis.fetch).toHaveBeenCalledWith('vision-model/config.json');

        globalThis.fetch = invalid<typeof fetch>(jest.fn(async () => ({ ok: false, status: 404 })));
        await expect(createWebviewAssets().visionModel.bundled()).resolves.toBe(false);

        globalThis.fetch = invalid<typeof fetch>(jest.fn(async () => Promise.reject(new Error('offline'))));
        await expect(createWebviewAssets().visionModel.bundled()).resolves.toBe(false);
    });

    test('loadTransformers imports the package', async () => {
        const loaded = await createWebviewAssets().visionModel.loadTransformers();
        expect(loaded.pipeline).toBe(mockTransformers.pipeline);
    });
});
