/**
 * The shared WebView asset reader the webview and headless families' assets
 * members use: the fetch of one asset relative to the webDir root. fetch is
 * stubbed the way the loaders' own tests stub it (thirdPartyNotices.test.ts).
 */

import { invalid } from '../helpers/invalid';
import { fetchAsset } from '../../src/ts/platform/fetchAsset';

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe('fetchAsset', () => {
    test('it fetches the asset relative to the web root and answers its text', async () => {
        globalThis.fetch = invalid<typeof fetch>(
            jest.fn(async () => ({ ok: true, status: 200, text: async () => 'TEXT' })),
        );
        await expect(fetchAsset('THIRD_PARTY_NOTICES.txt')).resolves.toBe('TEXT');
        expect(globalThis.fetch).toHaveBeenCalledWith('THIRD_PARTY_NOTICES.txt');
    });

    test('a response that is not ok rejects', async () => {
        globalThis.fetch = invalid<typeof fetch>(jest.fn(async () => ({ ok: false, status: 404 })));
        await expect(fetchAsset('missing.txt')).rejects.toThrow('HTTP 404');
    });

    test('a fetch without a response rejects', async () => {
        globalThis.fetch = invalid<typeof fetch>(jest.fn(async () => undefined));
        await expect(fetchAsset('missing.txt')).rejects.toThrow('no response');
    });
});
