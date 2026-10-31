/**
 * The node family's assets member: the SEA-or-fs read of the runtime assets
 * and the vision model's answers on Node — the packaged-Electron / build-cache
 * location, the cpu device, the SEA-or-fs bundled check, and the transformers
 * load, which a SEA build with the injected extractor runs from the extracted
 * runtime (whose root the family remembers). node:sea is faked as a virtual
 * module the way the loaders' tests fake it.
 */

import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);

import {
    createNodeAssets,
    extractedVisionRootOf,
    __resetExtractedRootForTests,
} from '../../../src/ts/platforms/node/assets';

import type * as runtimeModule from '../../../src/ts/runtime';
import type * as appPathsModule from '../../../src/ts/appPaths';

const mockSea: { isSea: () => boolean; getAsset: (key: string, encoding: string) => string } = {
    isSea: () => false,
    getAsset: () => '',
};
const mockSeaTransformers = {
    env: { backends: { onnx: { wasm: {} } } },
    pipeline: jest.fn(),
};
const mockCreateRequire = jest.fn(() => () => mockSeaTransformers);
const mockExtract = jest.fn(() => ({ root: '/vision/root', modulePath: '/vision/root/vision-entry.js' }));

jest.mock('node:sea', () => mockSea, { virtual: true });
jest.mock('node:module', () => ({ createRequire: mockCreateRequire }));
jest.mock('@huggingface/transformers', () => ({ __esModule: true, default: {} }));
jest.mock('../../../src/ts/runtime', () => ({
    __esModule: true,
    ...jest.requireActual<typeof runtimeModule>('../../../src/ts/runtime'),
    isElectron: jest.fn(() => false),
    isPackaged: jest.fn(() => false),
}));
jest.mock('../../../src/ts/appPaths', () => ({
    __esModule: true,
    appPath: jest.fn((...segments: string[]) => `/app/${segments.join('/')}`),
}));

const runtime = jest.mocked(require('../../../src/ts/runtime') as typeof runtimeModule);
const appPaths = jest.mocked(require('../../../src/ts/appPaths') as typeof appPathsModule);

beforeEach(() => {
    mockSea.isSea = () => false;
    mockSea.getAsset = () => '';
    runtime.isElectron.mockReturnValue(false);
    runtime.isPackaged.mockReturnValue(false);
    appPaths.appPath.mockClear();
    __resetExtractedRootForTests();
});

afterEach(() => {
    // The island's doMock persists past isolateModules: put the stand-in
    // registration back.
    jest.dontMock('node:sea');
    jest.doMock('node:sea', () => mockSea, { virtual: true });
});

afterEach(() => {
    delete (process.versions as { electron?: string }).electron;
    delete (process as { resourcesPath?: string }).resourcesPath;
});

describe('readText', () => {
    test('a node:sea that cannot be required at all is no SEA, so the model check reads the file', async () => {
        // First test in the file: node:sea is not yet in the registry, so
        // the island's throwing registration is the one the guarded require
        // of the fresh family sees. The bundled check runs its sea lookup
        // synchronously, so the island's family is the one that requires it.
        let bundled!: Promise<boolean>;
        jest.isolateModules(() => {
            jest.doMock('node:sea', () => {
                throw new Error('no sea module');
            });
            bundled = (
                require('../../../src/ts/platforms/node/assets') as typeof import('../../../src/ts/platforms/node/assets')
            )
                .createNodeAssets()
                .visionModel.bundled();
        });
        await expect(bundled).resolves.toBeFalsy();
    });

    test('the CLI binary reads the embedded SEA asset', async () => {
        mockSea.isSea = () => true;
        mockSea.getAsset = (key, encoding) => `asset:${key}:${encoding}`;
        await expect(createNodeAssets().readText('THIRD_PARTY_NOTICES.txt')).resolves.toBe(
            'asset:THIRD_PARTY_NOTICES.txt:utf8',
        );
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    test('from source it reads the file under src/assets of the app root', async () => {
        fs.readFileSync.mockReturnValue('FROM FILE');
        await expect(createNodeAssets().readText('THIRD_PARTY_NOTICES.txt')).resolves.toBe('FROM FILE');
        expect(fs.readFileSync).toHaveBeenCalledWith('/app/src/assets/THIRD_PARTY_NOTICES.txt', 'utf8');
    });

    test('an unusable node:sea falls back to the file', async () => {
        mockSea.isSea = () => {
            throw new Error('no sea');
        };
        fs.readFileSync.mockReturnValue('FROM FILE');
        await expect(createNodeAssets().readText('semantic-vectors.json')).resolves.toBe('FROM FILE');
    });
});

describe('readJson', () => {
    test('it parses the asset text', async () => {
        fs.readFileSync.mockReturnValue('{"a":1}');
        await expect(createNodeAssets().readJson('semantic-vectors.json')).resolves.toEqual({ a: 1 });
    });

    test('a SEA build parses the embedded asset, and reads no file', async () => {
        mockSea.isSea = () => true;
        mockSea.getAsset = () => '{"sea":true}';
        fs.readFileSync.mockClear();
        await expect(createNodeAssets().readJson('semantic-vectors.json')).resolves.toEqual({ sea: true });
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    test('a SEA asset that fails to parse falls back to the file, the way the lexicon loader parses', async () => {
        mockSea.isSea = () => true;
        mockSea.getAsset = () => '{not json';
        fs.readFileSync.mockReturnValue('{"a":1}');
        await expect(createNodeAssets().readJson('semantic-vectors.json')).resolves.toEqual({ a: 1 });
        expect(fs.readFileSync).toHaveBeenCalledWith('/app/src/assets/semantic-vectors.json', 'utf8');
    });
});

describe('visionModel', () => {
    test('inference runs on the cpu', () => {
        expect(createNodeAssets().visionModel.device).toBe('cpu');
    });

    test('a packaged Electron build reads the resources directory', () => {
        (process.versions as { electron?: string }).electron = '43.0.0';
        runtime.isElectron.mockReturnValue(true);
        runtime.isPackaged.mockReturnValue(true);
        (process as { resourcesPath?: string }).resourcesPath = '/res';
        expect(createNodeAssets().visionModel.location()).toBe('/res/');
    });

    test('from source the model lives in the app root .cache directory', () => {
        expect(createNodeAssets().visionModel.location()).toBe('/app/.cache/');
    });
});

describe('visionModel.bundled', () => {
    test('a SEA build answers the embedded runtime checksum asset', async () => {
        mockSea.isSea = () => true;
        const getAsset = jest.fn(() => 'sha');
        mockSea.getAsset = getAsset;
        await expect(createNodeAssets().visionModel.bundled()).resolves.toBe(true);
        expect(getAsset).toHaveBeenCalledWith('vision-runtime.sha256');
        expect(fs.existsSync).not.toHaveBeenCalled();
    });

    test('a SEA build without the embedded runtime answers false, without touching fs', async () => {
        mockSea.isSea = () => true;
        mockSea.getAsset = () => {
            throw new Error('ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND');
        };
        await expect(createNodeAssets().visionModel.bundled()).resolves.toBe(false);
        expect(fs.existsSync).not.toHaveBeenCalled();
    });

    test('not a SEA build, the model beside the location the model loads from decides', async () => {
        (process.versions as { electron?: string }).electron = '43.0.0';
        runtime.isElectron.mockReturnValue(true);
        runtime.isPackaged.mockReturnValue(true);
        (process as { resourcesPath?: string }).resourcesPath = '/res';
        fs.existsSync.mockReturnValue(true);
        await expect(createNodeAssets().visionModel.bundled()).resolves.toBe(true);
        expect(fs.existsSync).toHaveBeenCalledWith(
            (require('node:path') as typeof import('node:path')).join('/res/', 'vision-model', 'config.json'),
        );
        fs.existsSync.mockReturnValue(false);
        await expect(createNodeAssets().visionModel.bundled()).resolves.toBe(false);
    });
});

describe('visionModel.loadTransformers', () => {
    test('a SEA build with the injected extractor loads from the extracted runtime and remembers its root', async () => {
        mockSea.isSea = () => true;
        const assets = createNodeAssets({ extractVisionCliAssets: () => mockExtract() });
        await expect(assets.visionModel.loadTransformers()).resolves.toBe(mockSeaTransformers);
        expect(mockExtract).toHaveBeenCalledTimes(1);
        expect(mockCreateRequire).toHaveBeenCalledWith('/vision/root/vision-entry.js');
        expect(extractedVisionRootOf()).toBe('/vision/root');
    });

    test('without the injected extractor the package import stands, and no root is remembered', async () => {
        mockSea.isSea = () => true;
        const loaded = (await createNodeAssets().visionModel.loadTransformers()) as unknown;
        expect(loaded).toEqual(expect.objectContaining({ default: {} }));
        expect(mockExtract).not.toHaveBeenCalled();
        expect(mockCreateRequire).not.toHaveBeenCalled();
        expect(extractedVisionRootOf()).toBeUndefined();
    });

    test('not a SEA build, the extractor is not asked even when injected', async () => {
        const assets = createNodeAssets({ extractVisionCliAssets: () => mockExtract() });
        const loaded = (await assets.visionModel.loadTransformers()) as unknown;
        expect(loaded).toEqual(expect.objectContaining({ default: {} }));
        expect(mockExtract).not.toHaveBeenCalled();
    });
});
