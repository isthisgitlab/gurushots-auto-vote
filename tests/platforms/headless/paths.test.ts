/**
 * The headless family's paths member: the OS-path reads delegated to runtime,
 * answered the way runtime answers them on the bare service WebView, and the
 * app-root members that throw — the family invents no app-root path.
 */

jest.mock('../../../src/ts/runtime', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../../src/ts/runtime')>('../../../src/ts/runtime'),
    getAppUserDataPath: jest.fn(() => '/stub-user-data'),
    getUserDataDir: jest.fn((appName: string) => `/stub/${appName}`),
    isPackaged: jest.fn(() => false),
    isSourceCode: jest.fn(() => true),
}));

const runtime = jest.mocked(require('../../../src/ts/runtime') as typeof import('../../../src/ts/runtime'));

import { createHeadlessPaths } from '../../../src/ts/platforms/headless/paths';

describe('the runtime delegations', () => {
    test('userData delegates to the app user-data path', () => {
        expect(createHeadlessPaths().userData()).toBe('/stub-user-data');
        expect(runtime.getAppUserDataPath).toHaveBeenCalled();
    });

    test('getUserDataDir delegates with the app name', () => {
        expect(createHeadlessPaths().getUserDataDir('gurushots-auto-vote')).toBe('/stub/gurushots-auto-vote');
        expect(runtime.getUserDataDir).toHaveBeenCalledWith('gurushots-auto-vote');
    });

    test('isPackaged and isSourceCode delegate', () => {
        expect(createHeadlessPaths().isPackaged()).toBe(false);
        expect(createHeadlessPaths().isSourceCode()).toBe(true);
        expect(runtime.isPackaged).toHaveBeenCalled();
        expect(runtime.isSourceCode).toHaveBeenCalled();
    });
});

describe('the app-root members', () => {
    test('resourcesPath and appPath throw: no service code resolves a path below an app root', () => {
        const paths = createHeadlessPaths();
        expect(() => paths.resourcesPath()).toThrow('headless has no app-root path');
        expect(() => paths.appPath('vision-model')).toThrow('headless has no app-root path');
    });
});
