/**
 * The node family's assets member: the SEA-or-fs read of the runtime assets
 * and the vision model's location and device on Node — the answers the core
 * loaders give today. node:sea is faked as a virtual module the way the core
 * loaders' tests fake it.
 */

import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);

import { createNodeAssets } from '../../../src/ts/platforms/node/assets';

import type * as runtimeModule from '../../../src/ts/runtime';
import type * as appPathsModule from '../../../src/ts/appPaths';

const mockSea: { isSea: () => boolean; getAsset: (key: string, encoding: string) => string } = {
    isSea: () => false,
    getAsset: () => '',
};

jest.mock('node:sea', () => mockSea, { virtual: true });
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
});

afterEach(() => {
    delete (process.versions as { electron?: string }).electron;
    delete (process as { resourcesPath?: string }).resourcesPath;
});

describe('readText', () => {
    test('the CLI binary reads the embedded SEA asset', () => {
        mockSea.isSea = () => true;
        mockSea.getAsset = (key, encoding) => `asset:${key}:${encoding}`;
        expect(createNodeAssets().readText('THIRD_PARTY_NOTICES.txt')).toBe('asset:THIRD_PARTY_NOTICES.txt:utf8');
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    test('from source it reads the file under src/assets of the app root', () => {
        fs.readFileSync.mockReturnValue('FROM FILE');
        expect(createNodeAssets().readText('THIRD_PARTY_NOTICES.txt')).toBe('FROM FILE');
        expect(fs.readFileSync).toHaveBeenCalledWith('/app/src/assets/THIRD_PARTY_NOTICES.txt', 'utf8');
    });

    test('an unusable node:sea falls back to the file', () => {
        mockSea.isSea = () => {
            throw new Error('no sea');
        };
        fs.readFileSync.mockReturnValue('FROM FILE');
        expect(createNodeAssets().readText('semantic-vectors.json')).toBe('FROM FILE');
    });
});

describe('readJson', () => {
    test('it parses the asset text', () => {
        fs.readFileSync.mockReturnValue('{"a":1}');
        expect(createNodeAssets().readJson<Record<string, number>>('semantic-vectors.json')).toEqual({ a: 1 });
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
