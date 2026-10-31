/**
 * The headless family's assets member: the fetch readers of the WebView asset
 * branches and the vision model's location and device there. fetch is
 * stubbed the way the loaders' own tests stub it (thirdPartyNotices.test.ts).
 */

import { invalid } from '../../helpers/invalid';
import { createHeadlessAssets } from '../../../src/ts/platforms/headless/assets';

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe('readText', () => {
    test('it fetches the asset relative to the web root and answers its text', async () => {
        globalThis.fetch = invalid<typeof fetch>(
            jest.fn(async () => ({ ok: true, status: 200, text: async () => 'TEXT' })),
        );
        await expect(createHeadlessAssets().readText('semantic-vectors.json')).resolves.toBe('TEXT');
        expect(globalThis.fetch).toHaveBeenCalledWith('semantic-vectors.json');
    });

    test('a response that is not ok throws', async () => {
        globalThis.fetch = invalid<typeof fetch>(jest.fn(async () => ({ ok: false, status: 500 })));
        await expect(createHeadlessAssets().readText('missing.txt')).rejects.toThrow('HTTP 500');
    });

    test('a fetch without a response throws', async () => {
        globalThis.fetch = invalid<typeof fetch>(jest.fn(async () => undefined));
        await expect(createHeadlessAssets().readText('missing.txt')).rejects.toThrow('no response');
    });
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
