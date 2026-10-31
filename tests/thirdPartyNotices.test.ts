/**
 * The third-party notices loader (src/ts/core/thirdPartyNotices.ts): it asks the
 * installed platform for the asset text, whose readers per family are the
 * webviews' fetch (Android), the CLI binary's embedded asset and the file
 * under src/assets (node). The per-family reads are proven in the family
 * asset tests; these keep the loader's own assertions — the asset name, the
 * platform's text coming through, and the rejection on an unreadable asset.
 * The asset itself is generated at build time, so every read is mocked.
 */

jest.mock('../src/ts/appPaths', () => ({ appPath: jest.fn((...segments: string[]) => `/app/${segments.join('/')}`) }));

const mockSea: { isSea: () => boolean; getAsset: (key: string, encoding: string) => string } = {
    isSea: () => false,
    getAsset: () => '',
};
jest.mock('node:sea', () => mockSea, { virtual: true });

import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import { loadThirdPartyNotices, NOTICES_ASSET_NAME } from '../src/ts/core/thirdPartyNotices';
import { installHeadlessTestPlatform, installTestPlatform, installWebviewTestPlatform } from './helpers/platform';
import { invalid } from './helpers/invalid';

const realFetch = globalThis.fetch;

beforeEach(() => {
    installTestPlatform();
});

afterEach(() => {
    globalThis.fetch = realFetch;
    mockSea.isSea = () => false;
    mockSea.getAsset = () => '';
});

test('the asset is src/assets/THIRD_PARTY_NOTICES.txt', () => {
    expect(NOTICES_ASSET_NAME).toBe('THIRD_PARTY_NOTICES.txt');
});

describe('Android (the webview platforms fetch it from the web assets)', () => {
    test.each<[string, () => void]>([
        ['the app WebView', () => installWebviewTestPlatform()],
        ['the background service', () => installHeadlessTestPlatform()],
    ])('%s fetches it relative to the web root', async (_label, install) => {
        install();
        globalThis.fetch = invalid<typeof fetch>(
            jest.fn(async () => ({ ok: true, status: 200, text: async () => 'NOTICES' })),
        );

        await expect(loadThirdPartyNotices()).resolves.toBe('NOTICES');
        expect(globalThis.fetch).toHaveBeenCalledWith('THIRD_PARTY_NOTICES.txt');
    });

    test('a failed response rejects', async () => {
        installWebviewTestPlatform();
        globalThis.fetch = invalid<typeof fetch>(jest.fn(async () => ({ ok: false, status: 404 })));

        await expect(loadThirdPartyNotices()).rejects.toThrow('HTTP 404');
    });
});

describe('CLI binary (the node platform reads the embedded asset)', () => {
    test('reads the SEA asset as text', async () => {
        mockSea.isSea = () => true;
        const getAsset = jest.fn(() => 'EMBEDDED');
        mockSea.getAsset = getAsset;

        await expect(loadThirdPartyNotices()).resolves.toBe('EMBEDDED');
        expect(getAsset).toHaveBeenCalledWith('THIRD_PARTY_NOTICES.txt', 'utf8');
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });
});

describe('Electron and the CLI from source (the node platform reads the file under src/assets)', () => {
    test('reads the file through the app root', async () => {
        fs.readFileSync.mockReturnValue('FROM FILE');

        await expect(loadThirdPartyNotices()).resolves.toBe('FROM FILE');
        expect(fs.readFileSync).toHaveBeenCalledWith('/app/src/assets/THIRD_PARTY_NOTICES.txt', 'utf8');
    });

    test('falls back to the file when node:sea is not usable', async () => {
        mockSea.isSea = () => {
            throw new Error('no sea');
        };
        fs.readFileSync.mockReturnValue('FROM FILE');

        await expect(loadThirdPartyNotices()).resolves.toBe('FROM FILE');
    });

    test('a missing file rejects', async () => {
        fs.readFileSync.mockImplementation(() => {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        });

        await expect(loadThirdPartyNotices()).rejects.toThrow('ENOENT');
    });
});
