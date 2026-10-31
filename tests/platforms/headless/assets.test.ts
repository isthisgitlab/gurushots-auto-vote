/**
 * The headless family's assets member: the readJson composition over the
 * shared fetchAsset reader (fetchAsset itself is proven in
 * tests/platform/fetchAsset.test.ts) and the vision model's location and
 * device there. fetch is stubbed the way the loaders' own tests stub it.
 */

import { invalid } from '../../helpers/invalid';
import { createHeadlessAssets } from '../../../src/ts/platforms/headless/assets';

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
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
});
