/**
 * Tests for the cross-platform lexicon asset loader (semantic/assets.js).
 *
 * Every platform branch resolves to the parsed object or null — never a throw —
 * and the result is memoised, with concurrent callers sharing one load.
 * `runtime` is mocked to pick the branch; `fs` is already mocked by
 * tests/setup.js; `node:sea` is replaced per test.
 */

jest.mock('../../../src/js/runtime', () => ({
    isCapacitor: jest.fn(() => false),
    isHeadlessService: jest.fn(() => false),
}));

// One mutable stand-in: the registry instantiates a mock once, so tests
// reconfigure this object instead of re-mocking the module.
const mockSea = { isSea: () => false, getAsset: () => null };
jest.mock('node:sea', () => mockSea, { virtual: true });

const runtime = require('../../../src/js/runtime');
const fs = require('fs');
const assets = require('../../../src/js/services/semantic/assets');

const LEXICON = { dims: 2, scale: 1, packed: {} };
const realFetch = globalThis.fetch;

beforeEach(() => {
    assets.__resetForTests();
    runtime.isCapacitor.mockReturnValue(false);
    runtime.isHeadlessService.mockReturnValue(false);
});

afterEach(() => {
    globalThis.fetch = realFetch;
    mockSea.isSea = () => false;
    mockSea.getAsset = () => null;
});

describe('fetch branch (Capacitor WebView / headless service)', () => {
    test.each([
        ['Capacitor', 'isCapacitor'],
        ['headless service', 'isHeadlessService'],
    ])('%s loads the asset via fetch and memoises it', async (_label, flag) => {
        runtime[flag].mockReturnValue(true);
        globalThis.fetch = jest.fn(async () => ({ ok: true, json: async () => LEXICON }));

        await expect(assets.loadLexiconAsset()).resolves.toBe(LEXICON);
        await expect(assets.loadLexiconAsset()).resolves.toBe(LEXICON);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(globalThis.fetch).toHaveBeenCalledWith(assets.ASSET_NAME);
    });

    test('concurrent callers share one in-flight load', async () => {
        runtime.isCapacitor.mockReturnValue(true);
        let release;
        globalThis.fetch = jest.fn(
            () =>
                new Promise((resolve) => {
                    release = () => resolve({ ok: true, json: async () => LEXICON });
                }),
        );
        const a = assets.loadLexiconAsset();
        const b = assets.loadLexiconAsset();
        release();
        await expect(Promise.all([a, b])).resolves.toEqual([LEXICON, LEXICON]);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['a non-ok HTTP response', async () => ({ ok: false, status: 404 })],
        ['a null response', async () => null],
        ['a rejected fetch', async () => Promise.reject(new Error('offline'))],
    ])('%s resolves to a cached null (lexical-only fallback)', async (_label, impl) => {
        runtime.isCapacitor.mockReturnValue(true);
        globalThis.fetch = jest.fn(impl);
        await expect(assets.loadLexiconAsset()).resolves.toBeNull();
        await expect(assets.loadLexiconAsset()).resolves.toBeNull();
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    test('__resetForTests forces a fresh load', async () => {
        runtime.isCapacitor.mockReturnValue(true);
        globalThis.fetch = jest.fn(async () => ({ ok: true, json: async () => LEXICON }));
        await assets.loadLexiconAsset();
        assets.__resetForTests();
        await assets.loadLexiconAsset();
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
});

describe('node branch (CLI / Electron)', () => {
    test('a SEA build reads the embedded asset and never touches fs', async () => {
        const getAsset = jest.fn(() => JSON.stringify(LEXICON));
        mockSea.isSea = () => true;
        mockSea.getAsset = getAsset;
        await expect(assets.loadLexiconAsset()).resolves.toEqual(LEXICON);
        expect(getAsset).toHaveBeenCalledWith(assets.ASSET_NAME, 'utf8');
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    test('a non-SEA build falls through to the committed file', async () => {
        fs.readFileSync.mockReturnValueOnce(JSON.stringify(LEXICON));
        await expect(assets.loadLexiconAsset()).resolves.toEqual(LEXICON);
        expect(fs.readFileSync.mock.calls[0][0]).toContain(assets.ASSET_NAME);
    });

    test('node:sea throwing is swallowed and the fs read is used', async () => {
        mockSea.isSea = () => {
            throw new Error('no sea');
        };
        fs.readFileSync.mockReturnValueOnce(JSON.stringify(LEXICON));
        await expect(assets.loadLexiconAsset()).resolves.toEqual(LEXICON);
    });

    test('an unreadable file resolves to null', async () => {
        fs.readFileSync.mockImplementationOnce(() => {
            throw new Error('ENOENT');
        });
        await expect(assets.loadLexiconAsset()).resolves.toBeNull();
    });
});
