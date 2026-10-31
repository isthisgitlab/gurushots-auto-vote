/**
 * The headless family as a whole: the platform createHeadlessPlatform builds.
 * The adapter builder is mocked at its family http module; the service is
 * itself the native side, so nothing is passed in.
 */

const mockAdapter = jest.fn<AxiosPromise, []>();

jest.mock('../../../src/ts/platforms/headless/http', () => ({
    __esModule: true,
    getHeadlessHttpAdapter: jest.fn((): AxiosAdapter => mockAdapter),
}));

import { installHeadlessTestPlatform } from '../../helpers/platform';
import { platform } from '../../../src/ts/platform/port';
import { createHeadlessPlatform } from '../../../src/ts/platforms/headless';

import type { AxiosAdapter, AxiosPromise } from 'axios';
import type { PlatformWindows } from '../../../src/ts/platform/port';

const headlessHttp = jest.mocked(
    require('../../../src/ts/platforms/headless/http') as typeof import('../../../src/ts/platforms/headless/http'),
);

// The service's windows: the explicit no-ops its shell module passes (a bare
// service WebView has no windows to broadcast to or relaunch).
const windows: PlatformWindows = {
    broadcastSettingsChanged: () => undefined,
    afterWipe: () => undefined,
};

describe('the headless platform', () => {
    test('the adapter is the AndroidHeadlessHttp one, resolved on read', () => {
        const p = createHeadlessPlatform(windows);
        expect(p.http.adapter).toBe(mockAdapter);
        expect(headlessHttp.getHeadlessHttpAdapter).toHaveBeenCalled();
    });

    test('the service is itself the native side, and the windows are the no-ops the shell passes', () => {
        const p = createHeadlessPlatform(windows);
        expect(p.native).toEqual({ autovote: null, foregroundService: null, apkInstaller: null });
        expect(p.windows).toBe(windows);
    });

    test('the wipe reaches nothing from the service', async () => {
        const wipe = createHeadlessPlatform(windows).wipe;
        expect(wipe.clearSession).toBeNull();
        expect(wipe.listPreferenceKeys).toBeNull();
        expect(wipe.removePreferenceKeys).toBeNull();
        expect(wipe.reloadAfterWipe).toBe(false);
        await expect(wipe.nativeWipe()).resolves.toBeNull();
        // The desktop processes that hold the user-data markers never run here.
        await expect(wipe.markers.isCliSessionActive()).resolves.toBe(false);
        await expect(wipe.markers.isDesktopAppActive()).resolves.toBe(false);
        await expect(wipe.markers.isWebServerActive()).resolves.toBe(false);
        expect(wipe.markers.isMarkerFile('cli-session-1.lock')).toBe(false);
    });

    test('the capabilities name the service answers', () => {
        const c = createHeadlessPlatform(windows).capabilities;
        expect(c.refreshMissionNeeds).toBe(true);
        expect(c.snapAllowed).toBe(false);
        expect(c.backgroundServiceOwnsScenarios()).toBe(false);
        expect(c.recoveryWording).toBe('store');
        expect(c.logContext()).toBe('CLI');
        expect(c.logCleanup).toBe(false);
    });
});

describe('the headless test installer', () => {
    test('it installs the family, and overrides replace a member group whole', () => {
        const installed = installHeadlessTestPlatform({
            native: { autovote: null, foregroundService: null, apkInstaller: null },
        });
        expect(platform()).toBe(installed);
        expect(installed.native).toEqual({ autovote: null, foregroundService: null, apkInstaller: null });
    });

    test('a plain install puts the family on the port', () => {
        const installed = installHeadlessTestPlatform();
        expect(platform()).toBe(installed);
        expect(installed.http.adapter).toBe(mockAdapter);
    });
});
