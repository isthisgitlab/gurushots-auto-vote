/**
 * The node family's paths member: every member delegates to the code it wraps
 * (runtime.ts, appPaths.ts) and answers what that code answers, resolving the
 * wrapped module on each call — a jest.mock made after the platform was built
 * is still seen, and no value is captured at build time.
 */

import { createNodePaths } from '../../../src/ts/platforms/node/paths';

import type * as runtimeModule from '../../../src/ts/runtime';
import type * as appPathsModule from '../../../src/ts/appPaths';

jest.mock('../../../src/ts/runtime', () => ({
    __esModule: true,
    ...jest.requireActual<typeof runtimeModule>('../../../src/ts/runtime'),
    getAppUserDataPath: jest.fn(() => '/user-data'),
    getUserDataDir: jest.fn((appName: string) => `/data/${appName}`),
    isPackaged: jest.fn(() => false),
    isSourceCode: jest.fn(() => true),
    isElectron: jest.fn(() => false),
}));
jest.mock('../../../src/ts/appPaths', () => ({
    __esModule: true,
    appPath: jest.fn((...segments: string[]) => `/app/${segments.join('/')}`),
}));

const runtime = jest.mocked(require('../../../src/ts/runtime') as typeof runtimeModule);
const appPaths = jest.mocked(require('../../../src/ts/appPaths') as typeof appPathsModule);

afterEach(() => {
    runtime.getAppUserDataPath.mockClear();
    runtime.getUserDataDir.mockClear();
    runtime.isPackaged.mockReturnValue(false);
    runtime.isSourceCode.mockReturnValue(true);
    runtime.isElectron.mockReturnValue(false);
    appPaths.appPath.mockClear();
});

describe('createNodePaths', () => {
    test('userData delegates to runtime.getAppUserDataPath', () => {
        const paths = createNodePaths();
        expect(paths.userData()).toBe('/user-data');
        expect(runtime.getAppUserDataPath).toHaveBeenCalledTimes(1);
    });

    test('getUserDataDir delegates to runtime.getUserDataDir', () => {
        const paths = createNodePaths();
        expect(paths.getUserDataDir('app')).toBe('/data/app');
        expect(runtime.getUserDataDir).toHaveBeenCalledWith('app');
    });

    test('isPackaged resolves the runtime on each call, not once at build time', () => {
        const paths = createNodePaths();
        expect(paths.isPackaged()).toBe(false);
        runtime.isPackaged.mockReturnValue(true);
        expect(paths.isPackaged()).toBe(true);
    });

    test('isSourceCode delegates to runtime.isSourceCode', () => {
        const paths = createNodePaths();
        expect(paths.isSourceCode()).toBe(true);
        expect(runtime.isSourceCode).toHaveBeenCalledTimes(1);
    });

    test('resourcesPath answers the Electron resources path on a packaged build', () => {
        runtime.isElectron.mockReturnValue(true);
        runtime.isPackaged.mockReturnValue(true);
        (process as { resourcesPath?: string }).resourcesPath = '/res';
        try {
            expect(createNodePaths().resourcesPath()).toBe('/res');
        } finally {
            delete (process as { resourcesPath?: string }).resourcesPath;
        }
    });

    test('resourcesPath answers the app root when running from source', () => {
        expect(createNodePaths().resourcesPath()).toBe('/app/');
        expect(appPaths.appPath).toHaveBeenCalledWith();
    });

    test('appPath delegates to appPaths.appPath', () => {
        expect(createNodePaths().appPath('src', 'assets', 'x')).toBe('/app/src/assets/x');
        expect(appPaths.appPath).toHaveBeenCalledWith('src', 'assets', 'x');
    });
});
