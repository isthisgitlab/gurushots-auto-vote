/**
 * The CLI shell's platform module: it installs the node family with the
 * single binary's vision model location when it loads — the extracted SEA
 * runtime root wins while it is set, and the family's location stands
 * without it — and the explicit no-op windows. visionVerifier is mocked at
 * the cliAssetRoot seam (the real root is set only by a SEA extraction). The
 * installed object is captured once: the setup file's afterEach reinstalls
 * the node test platform on the port, so the tests read the captured object,
 * not the slot.
 */

import * as path from 'node:path';

import { platform } from '../../src/ts/platform/port';
import { clearInstalledPlatform } from '../helpers/platform';

import type { Platform } from '../../src/ts/platform/port';

const mockGetCliAssetRoot = jest.fn<string | undefined, []>();

jest.mock('../../src/ts/services/visionVerifier', () => ({
    __esModule: true,
    getCliAssetRoot: () => mockGetCliAssetRoot(),
}));

// Requiring the module installs the platform; the slot is cleared first,
// because the setup file installed the node test platform before this file
// loaded.
clearInstalledPlatform();
require('../../src/ts/cli/platform');
const installed: Platform = platform();

const appPaths = require('../../src/ts/appPaths') as typeof import('../../src/ts/appPaths');

// The modules the shell members wrap, reached at call time — the install
// must run before the logger loads (whose own absence from the chain the
// bundle check proves). The deferral suite stands FIRST: a jest.doMock
// inside isolateModules only wins while the wrapped module has not been
// instantiated in the outer registry (the location tests below instantiate
// the file-level mock), and its afterEach re-registers that mock.
const HEAVY = ['../../src/ts/services/visionVerifier'];

describe('loading the CLI shell platform module defers the wrapped modules', () => {
    let mockLoaded: string[];

    beforeEach(() => {
        mockLoaded = [];
    });

    afterEach(() => {
        for (const heavy of HEAVY) jest.dontMock(heavy);
        // doMock (not mock): the hoisted registration was removed by
        // dontMock above, and a runtime re-registration is a doMock.
        jest.doMock('../../src/ts/services/visionVerifier', () => ({
            __esModule: true,
            getCliAssetRoot: () => mockGetCliAssetRoot(),
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
            require('../../src/ts/cli/platform');
            expect(mockLoaded).toEqual([]);
            expect(platform()).toBeDefined();
        });
    });

    test('calling the vision model location reaches visionVerifier', () => {
        jest.isolateModules(() => {
            clearInstalledPlatform();
            jest.doMock('../../src/ts/services/visionVerifier', () => ({
                __esModule: true,
                getCliAssetRoot: () => '/from-mock',
            }));
            require('../../src/ts/cli/platform');
            // The deferred require of visionVerifier is the next thing the
            // location member runs, so the root comes back from the mock.
            expect(platform().assets.visionModel.location()).toBe(`/from-mock${path.sep}`);
        });
    });
});

describe('the CLI shell platform module', () => {
    test('the module installs the platform, and the windows are the explicit no-ops', () => {
        expect(installed).toBeDefined();
        expect(() => installed.windows.broadcastSettingsChanged({})).not.toThrow();
        expect(() => installed.windows.afterWipe()).not.toThrow();
    });

    test('the vision model resolves into the extracted SEA runtime while its root is set', () => {
        mockGetCliAssetRoot.mockReturnValue('/extracted/vision-runtime');
        expect(installed.assets.visionModel.location()).toBe(`/extracted/vision-runtime${path.sep}`);
    });

    test('without the extracted root the family location stands (the source checkout cache)', () => {
        mockGetCliAssetRoot.mockReturnValue(undefined);
        expect(installed.assets.visionModel.location()).toBe(`${appPaths.appPath('.cache')}${path.sep}`);
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
