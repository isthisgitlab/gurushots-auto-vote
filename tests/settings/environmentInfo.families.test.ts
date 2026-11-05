/**
 * The environment info the Android shells answer: isElectronPackaged and
 * isBuiltApp are the packaged ELECTRON app's flags and stay false on a
 * device, where the native runtime's own packaged read must not stand in
 * for them (get-environment-info answered true there between the port move
 * and the isElectronPackaged member).
 */

import { installHeadlessTestPlatform, installWebviewTestPlatform } from '../helpers/platform';

import type * as userDataPathsModule from '../../src/ts/core/settings/userDataPaths';

describe('the environment info on the Android shells', () => {
    test('the app WebView pins isElectronPackaged and isBuiltApp false', () => {
        installWebviewTestPlatform();
        const { getEnvironmentInfo } =
            require('../../src/ts/core/settings/userDataPaths') as typeof userDataPathsModule;
        const info = getEnvironmentInfo();
        expect(info.isElectronPackaged).toBe(false);
        expect(info.isBuiltApp).toBe(false);
    });

    test('the headless service pins them false too', () => {
        installHeadlessTestPlatform();
        const { getEnvironmentInfo } =
            require('../../src/ts/core/settings/userDataPaths') as typeof userDataPathsModule;
        const info = getEnvironmentInfo();
        expect(info.isElectronPackaged).toBe(false);
        expect(info.isBuiltApp).toBe(false);
    });
});
