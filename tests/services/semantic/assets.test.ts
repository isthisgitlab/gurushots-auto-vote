/**
 * Tests for the cross-platform lexicon asset loader (semantic/assets.ts).
 *
 * Every platform resolves to the parsed object or null — never a throw — and
 * the result is memoised, with concurrent callers sharing one load. The
 * branch is picked by the installed platform (the webview platforms fetch,
 * the node platform reads the SEA asset or the committed file — the reads
 * themselves are proven in the family asset tests); `fs` is already mocked by
 * tests/setup.ts; `node:sea` is replaced per test.
 */

// One mutable stand-in: the registry instantiates a mock once, so tests
// reconfigure this object instead of re-mocking the module.
const mockSea: { isSea: () => boolean; getAsset: (key: string, encoding: string) => string | null } = {
    isSea: () => false,
    getAsset: () => null,
};
jest.mock('node:sea', () => mockSea, { virtual: true });

import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import assets = require('../../../src/ts/services/semantic/assets');
import { installHeadlessTestPlatform, installTestPlatform, installWebviewTestPlatform } from '../../helpers/platform';
import { invalid } from '../../helpers/invalid';

const LEXICON = { dims: 2, scale: 1, packed: {} };
const realFetch = globalThis.fetch;

beforeEach(() => {
    assets.__resetForTests();
    installTestPlatform();
});

afterEach(() => {
    globalThis.fetch = realFetch;
    mockSea.isSea = () => false;
    mockSea.getAsset = () => null;
});

describe('fetch branch (the webview platforms)', () => {
    test.each<[string, () => void]>([
        ['Capacitor', () => installWebviewTestPlatform()],
        ['headless service', () => installHeadlessTestPlatform()],
    ])('%s loads the asset via fetch and memoises it', async (_label, install) => {
        install();
        globalThis.fetch = invalid<typeof fetch>(
            jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(LEXICON) })),
        );

        await expect(assets.loadLexiconAsset()).resolves.toEqual(LEXICON);
        await expect(assets.loadLexiconAsset()).resolves.toEqual(LEXICON);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(globalThis.fetch).toHaveBeenCalledWith(assets.ASSET_NAME);
    });

    test('concurrent callers share one in-flight load', async () => {
        installWebviewTestPlatform();
        let release!: () => void;
        globalThis.fetch = invalid<typeof fetch>(
            jest.fn(
                () =>
                    new Promise((resolve) => {
                        release = () => resolve({ ok: true, status: 200, text: async () => JSON.stringify(LEXICON) });
                    }),
            ),
        );
        const a = assets.loadLexiconAsset();
        const b = assets.loadLexiconAsset();
        release();
        await expect(Promise.all([a, b])).resolves.toEqual([LEXICON, LEXICON]);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    test.each<[string, () => Promise<unknown>]>([
        ['a non-ok HTTP response', async () => ({ ok: false, status: 404 })],
        ['a null response', async () => null],
        ['a rejected fetch', async () => Promise.reject(new Error('offline'))],
    ])('%s resolves to a cached null (lexical-only fallback)', async (_label, impl) => {
        installWebviewTestPlatform();
        globalThis.fetch = invalid<typeof fetch>(jest.fn(impl));
        await expect(assets.loadLexiconAsset()).resolves.toBeNull();
        await expect(assets.loadLexiconAsset()).resolves.toBeNull();
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    test('__resetForTests forces a fresh load', async () => {
        installWebviewTestPlatform();
        globalThis.fetch = invalid<typeof fetch>(
            jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(LEXICON) })),
        );
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

    test('a SEA asset that fails to parse falls back to the file', async () => {
        mockSea.isSea = () => true;
        mockSea.getAsset = () => '{not json';
        fs.readFileSync.mockReturnValueOnce(JSON.stringify(LEXICON));
        await expect(assets.loadLexiconAsset()).resolves.toEqual(LEXICON);
    });
});
