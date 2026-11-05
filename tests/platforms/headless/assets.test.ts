/**
 * The headless family's assets member: the readJson composition over the
 * shared fetchAsset reader (fetchAsset itself is proven in
 * tests/platform/fetchAsset.test.ts) and the vision model's answers there.
 * fetch is stubbed the way the loaders' own tests stub it.
 */

import { invalid } from '../../helpers/invalid';
import { createHeadlessAssets } from '../../../src/ts/platforms/headless/assets';

const realFetch = globalThis.fetch;
const mockTransformers = { env: {}, pipeline: jest.fn() };
jest.mock('@huggingface/transformers', () => mockTransformers);

afterEach(() => {
    globalThis.fetch = realFetch;
});

test('refuses frame extraction in the Android headless service', async () => {
    await expect(createHeadlessAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2])).rejects.toThrow(
        'unavailable in the Android headless service',
    );
});

describe('readJson', () => {
    test('it parses the fetched text', async () => {
        globalThis.fetch = invalid<typeof fetch>(
            jest.fn(async () => ({ ok: true, status: 200, text: async () => '{"a":1}' })),
        );
        await expect(createHeadlessAssets().readJson('semantic-vectors.json')).resolves.toEqual({ a: 1 });
    });
});

describe('visionModel', () => {
    test('the model lives beside the document, and inference runs on the wasm backend', () => {
        const model = createHeadlessAssets().visionModel;
        expect(model.location()).toBe('./');
        expect(model.device).toBe('wasm');
    });

    test('bundled is the model config fetch: ok true, a miss and a failed fetch are not', async () => {
        globalThis.fetch = invalid<typeof fetch>(jest.fn(async () => ({ ok: true, status: 200 })));
        await expect(createHeadlessAssets().visionModel.bundled()).resolves.toBe(true);
        expect(globalThis.fetch).toHaveBeenCalledWith('vision-model/config.json');

        globalThis.fetch = invalid<typeof fetch>(jest.fn(async () => ({ ok: false, status: 404 })));
        await expect(createHeadlessAssets().visionModel.bundled()).resolves.toBe(false);

        globalThis.fetch = invalid<typeof fetch>(jest.fn(async () => Promise.reject(new Error('offline'))));
        await expect(createHeadlessAssets().visionModel.bundled()).resolves.toBe(false);
    });

    test('loadTransformers imports the package', async () => {
        const loaded = await createHeadlessAssets().visionModel.loadTransformers();
        expect(loaded.pipeline).toBe(mockTransformers.pipeline);
    });
});
