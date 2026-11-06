/**
 * The CLI shell's platform module: it installs the node family with the
 * single binary's vision runtime extractor injected — a SEA build's
 * transformers load extracts through it, and the vision model location is the
 * extracted root the family remembered while it is set, the family's own
 * location (the source checkout's .cache) without it — and the explicit
 * no-op windows. visionCliAssets is mocked at the extraction seam (the real
 * extractor reads the SEA blob and the file system). The installed object is
 * captured once: the setup file's afterEach reinstalls the node test platform
 * on the port, so the tests read the captured object, not the slot.
 */

import * as path from 'node:path';

import { platform } from '../../src/ts/core/platform/port';
import { clearInstalledPlatform } from '../helpers/platform';

import type { Platform } from '../../src/ts/core/platform/port';

const mockExtract = jest.fn(() => ({
    root: '/extracted/vision-runtime',
    modulePath: '/extracted/vision-runtime/vision-entry.js',
}));
const mockSea = { isSea: jest.fn(() => true), getAsset: jest.fn(() => 'sha') };
const mockSeaTransformers = { env: {}, pipeline: jest.fn() };
const mockCreateRequire = jest.fn(() => () => mockSeaTransformers);
const mockExtractVideoDecoderCliAssets = jest.fn(() => ({
    decoderPath: '/extracted/video-decoder/ffmpeg',
    probePath: '/extracted/video-decoder/ffprobe',
}));
const mockExtractNodeVideoFrames = jest.fn<Promise<string[]>, [string, number, readonly number[], () => string]>();

jest.mock('../../src/ts/shells/cli/visionCliAssets', () => ({
    __esModule: true,
    extractVisionCliAssets: mockExtract,
}));
jest.mock('../../src/ts/shells/cli/videoDecoderCliAssets', () => ({
    __esModule: true,
    extractVideoDecoderCliAssets: mockExtractVideoDecoderCliAssets,
}));
jest.mock('node:sea', () => mockSea, { virtual: true });
jest.mock('node:module', () => ({ createRequire: mockCreateRequire }));
jest.mock('../../src/ts/platforms/node/videoFrames', () => ({ extractNodeVideoFrames: mockExtractNodeVideoFrames }));

// Requiring the module installs the platform; the slot is cleared first,
// because the setup file installed the node test platform before this file
// loaded.
clearInstalledPlatform();
require('../../src/ts/shells/cli/platform');
const installed: Platform = platform();

const appPaths = require('../../src/ts/appPaths') as typeof import('../../src/ts/appPaths');
const { __resetExtractedRootForTests } =
    require('../../src/ts/platforms/node') as typeof import('../../src/ts/platforms/node');

// The modules the shell members wrap, reached at call time — the install
// must run before the logger loads (whose own absence from the chain the
// bundle check proves). The deferral suite stands FIRST: a jest.doMock
// inside isolateModules only wins while the wrapped module has not been
// instantiated in the outer registry (the location tests below instantiate
// the file-level mock), and its afterEach re-registers that mock.
const HEAVY = [
    '../../src/ts/shells/cli/visionCliAssets',
    '../../src/ts/shells/cli/videoDecoderCliAssets',
    '../../src/ts/core/logger',
];

describe('loading the CLI shell platform module defers the wrapped modules', () => {
    let mockLoaded: string[];

    beforeEach(() => {
        mockLoaded = [];
    });

    afterEach(() => {
        for (const heavy of HEAVY) jest.dontMock(heavy);
        // doMock (not mock): the hoisted registration was removed by
        // dontMock above, and a runtime re-registration is a doMock.
        jest.doMock('../../src/ts/shells/cli/visionCliAssets', () => ({
            __esModule: true,
            extractVisionCliAssets: mockExtract,
        }));
        jest.doMock('../../src/ts/shells/cli/videoDecoderCliAssets', () => ({
            __esModule: true,
            extractVideoDecoderCliAssets: mockExtractVideoDecoderCliAssets,
        }));
    });

    test('loading installs the platform and loads none of them', () => {
        jest.isolateModules(() => {
            clearInstalledPlatform();
            for (const heavy of HEAVY) {
                jest.doMock(heavy, () => {
                    mockLoaded.push(heavy);
                    return {};
                });
            }
            require('../../src/ts/shells/cli/platform');
            expect(mockLoaded).toEqual([]);
            expect(platform()).toBeDefined();
        });
    });

    test('the location override reads the family root the family assets module answers', () => {
        jest.isolateModules(() => {
            clearInstalledPlatform();
            jest.doMock('../../src/ts/platforms/node/assets', () => ({
                __esModule: true,
                createNodeAssets: () => ({
                    readText: async () => '',
                    readJson: async () => null,
                    visionModel: {
                        location: () => `/family${path.sep}`,
                        device: 'cpu' as const,
                        bundled: async () => true,
                        loadTransformers: async () => mockSeaTransformers,
                    },
                }),
                extractedVisionRootOf: () => '/from-mock',
            }));
            require('../../src/ts/shells/cli/platform');
            // The deferred read of the family's remembered root is the next
            // thing the location member runs, so the root comes back from
            // the mock.
            expect(platform().assets.visionModel.location()).toBe(`/from-mock${path.sep}`);
        });
    });
});

describe('the CLI shell platform module', () => {
    beforeEach(() => {
        __resetExtractedRootForTests();
        mockExtractVideoDecoderCliAssets.mockClear();
        mockExtractNodeVideoFrames.mockImplementation(async (_url, _durationMs, _positions, decoderPath) => [
            decoderPath(),
        ]);
    });

    test('the module installs the platform, and the windows are the explicit no-ops', () => {
        expect(installed).toBeDefined();
        expect(() => installed.windows.broadcastSettingsChanged({})).not.toThrow();
        expect(() => installed.windows.afterWipe()).not.toThrow();
    });

    test('without the extracted root the family location stands (the source checkout cache)', () => {
        expect(installed.assets.visionModel.location()).toBe(`${appPaths.appPath('.cache')}${path.sep}`);
    });

    test('the vision model resolves into the extracted SEA runtime once a load has extracted it', async () => {
        mockExtract.mockClear();
        await installed.assets.visionModel.loadTransformers();
        expect(mockExtract).toHaveBeenCalledTimes(1);
        expect(mockCreateRequire).toHaveBeenCalledWith('/extracted/vision-runtime/vision-entry.js');
        expect(installed.assets.visionModel.location()).toBe(`/extracted/vision-runtime${path.sep}`);
    });

    test('injects the decoder extractor lazily for the CLI SEA runtime', async () => {
        await expect(
            installed.assets.videoFrames('https://media.gurushots.com/clip.mp4', 1_000, [0.2]),
        ).resolves.toEqual(['/extracted/video-decoder/ffmpeg']);
        expect(mockExtractVideoDecoderCliAssets).toHaveBeenCalledTimes(1);
    });

    test('the capabilities answer the CLI values, computed from the logger context flags', () => {
        // The context captures the two flags at its load: argv names cli.ts,
        // the way the real CLI start does, and there is no Electron.
        const originalArgv = process.argv;
        process.argv = ['node', 'cli.ts', 'status'];
        try {
            const capabilities = installed.capabilities;
            expect(capabilities.refreshMissionNeeds).toBe(false);
            expect(capabilities.snapAllowed).toBe(true);
            expect(capabilities.backgroundServiceOwnsScenarios()).toBe(false);
            expect(capabilities.recoveryWording).toBe('file');
            expect(capabilities.logContext()).toBe('CLI');
            expect(capabilities.logCleanup).toBe(true);
        } finally {
            process.argv = originalArgv;
        }
    });
});
