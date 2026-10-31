/**
 * The webview family's paths member: the OS-path reads delegated to runtime,
 * whose Capacitor branches answer the stub paths of a WebView, and the
 * app-root members that throw — the family invents no app-root path.
 */

jest.mock('../../../src/ts/runtime', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../../src/ts/runtime')>('../../../src/ts/runtime'),
    getAppUserDataPath: jest.fn(() => '/gurushots-auto-vote'),
    getUserDataDir: jest.fn((appName: string) => `/${appName}`),
    isPackaged: jest.fn(() => true),
    isSourceCode: jest.fn(() => false),
}));

const runtime = jest.mocked(require('../../../src/ts/runtime') as typeof import('../../../src/ts/runtime'));

import { createWebviewPaths } from '../../../src/ts/platforms/webview/paths';

describe('the runtime delegations', () => {
    test('userData delegates to the app user-data path', () => {
        expect(createWebviewPaths().userData()).toBe('/gurushots-auto-vote');
        expect(runtime.getAppUserDataPath).toHaveBeenCalled();
    });

    test('getUserDataDir delegates with the app name', () => {
        expect(createWebviewPaths().getUserDataDir('gurushots-auto-vote')).toBe('/gurushots-auto-vote');
        expect(runtime.getUserDataDir).toHaveBeenCalledWith('gurushots-auto-vote');
    });

    test('isPackaged delegates (the native-runtime read)', () => {
        expect(createWebviewPaths().isPackaged()).toBe(true);
        expect(runtime.isPackaged).toHaveBeenCalled();
    });

    test('isSourceCode delegates', () => {
        expect(createWebviewPaths().isSourceCode()).toBe(false);
        expect(runtime.isSourceCode).toHaveBeenCalled();
    });
});

describe('the app-root members', () => {
    test('resourcesPath and appPath throw: no WebView code resolves a path below an app root', () => {
        const paths = createWebviewPaths();
        expect(() => paths.resourcesPath()).toThrow('webview has no app-root path');
        expect(() => paths.appPath('src', 'assets')).toThrow('webview has no app-root path');
    });
});
