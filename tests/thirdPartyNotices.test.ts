/**
 * The third-party notices loader (src/ts/thirdPartyNotices.ts): one resolver per
 * shell — fetch from the web assets (Android), the embedded asset (CLI binary),
 * the file under src/assets (CLI from source, Electron). The asset itself is
 * generated at build time, so every read is mocked.
 */

jest.mock('../src/ts/runtime', () => ({
    isCapacitor: jest.fn(() => false),
    isHeadlessService: jest.fn(() => false),
}));
jest.mock('../src/ts/appPaths', () => ({ appPath: jest.fn((...segments: string[]) => `/app/${segments.join('/')}`) }));

const mockSea: { isSea: () => boolean; getAsset: (key: string, encoding: string) => string } = {
    isSea: () => false,
    getAsset: () => '',
};
jest.mock('node:sea', () => mockSea, { virtual: true });

import runtimeModule = require('../src/ts/runtime');
const runtime = jest.mocked(runtimeModule);
import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import { loadThirdPartyNotices, NOTICES_ASSET_NAME } from '../src/ts/thirdPartyNotices';
import { invalid } from './helpers/invalid';

const realFetch = globalThis.fetch;

beforeEach(() => {
    runtime.isCapacitor.mockReturnValue(false);
    runtime.isHeadlessService.mockReturnValue(false);
});

afterEach(() => {
    globalThis.fetch = realFetch;
    mockSea.isSea = () => false;
    mockSea.getAsset = () => '';
});

test('the asset is src/assets/THIRD_PARTY_NOTICES.txt', () => {
    expect(NOTICES_ASSET_NAME).toBe('THIRD_PARTY_NOTICES.txt');
});

describe('Android (fetched from the web assets)', () => {
    test.each<[string, 'isCapacitor' | 'isHeadlessService']>([
        ['the app WebView', 'isCapacitor'],
        ['the background service', 'isHeadlessService'],
    ])('%s fetches it relative to the web root', async (_label, flag) => {
        runtime[flag].mockReturnValue(true);
        globalThis.fetch = invalid<typeof fetch>(
            jest.fn(async () => ({ ok: true, status: 200, text: async () => 'NOTICES' })),
        );

        await expect(loadThirdPartyNotices()).resolves.toBe('NOTICES');
        expect(globalThis.fetch).toHaveBeenCalledWith('THIRD_PARTY_NOTICES.txt');
    });

    test('a failed response rejects', async () => {
        runtime.isCapacitor.mockReturnValue(true);
        globalThis.fetch = invalid<typeof fetch>(jest.fn(async () => ({ ok: false, status: 404 })));

        await expect(loadThirdPartyNotices()).rejects.toThrow('HTTP 404');
    });
});

describe('CLI binary (embedded asset)', () => {
    test('reads the SEA asset as text', async () => {
        mockSea.isSea = () => true;
        const getAsset = jest.fn(() => 'EMBEDDED');
        mockSea.getAsset = getAsset;

        await expect(loadThirdPartyNotices()).resolves.toBe('EMBEDDED');
        expect(getAsset).toHaveBeenCalledWith('THIRD_PARTY_NOTICES.txt', 'utf8');
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });
});

describe('Electron and the CLI from source (file under src/assets)', () => {
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
