/**
 * The node family as a whole: the platform createNodePlatform builds with the
 * windows the shell passes. The log context is the default rule, computed
 * from the context module's two flags — logger/context is mocked here with
 * live flags, and no case calls getContext.
 */

const mockContextFlags = { isElectronApp: false, startedViaCli: false };

jest.mock('../../../src/ts/logger/context', () => ({
    __esModule: true,
    get isElectronApp() {
        return mockContextFlags.isElectronApp;
    },
    get startedViaCli() {
        return mockContextFlags.startedViaCli;
    },
}));

import { createNodePlatform } from '../../../src/ts/platforms/node';

import type { PlatformWindows } from '../../../src/ts/platform/port';

// The CLI's windows: the explicit no-ops its shell module passes (a desktop
// command run has no windows to broadcast to or relaunch).
const windows: PlatformWindows = {
    broadcastSettingsChanged: () => undefined,
    afterWipe: () => undefined,
};

describe('the node platform', () => {
    test('it has no adapter, native services or Capacitor transport', () => {
        const p = createNodePlatform(windows);
        expect(p.http.adapter).toBeNull();
        expect(p.native).toEqual({ autovote: null, foregroundService: null, apkInstaller: null });
        expect(p.wipe.clearSession).toBeNull();
        expect(p.wipe.reloadAfterWipe).toBe(false);
        expect(p.wipe.listPreferenceKeys).toBeNull();
        expect(p.wipe.removePreferenceKeys).toBeNull();
    });

    test('the wipe finds no native plugin to ask, as localData answers without one', async () => {
        await expect(createNodePlatform(windows).wipe.nativeWipe()).resolves.toBeNull();
    });

    test('the windows are the ones the shell passes', () => {
        expect(createNodePlatform(windows).windows).toBe(windows);
    });

    test('the constants name the node answers', () => {
        const c = createNodePlatform(windows).capabilities;
        expect(c.refreshMissionNeeds).toBe(false);
        expect(c.snapAllowed).toBe(true);
        expect(c.recoveryWording).toBe('file');
    });

    test('no background service owns the scenarios here', () => {
        expect(createNodePlatform(windows).capabilities.backgroundServiceOwnsScenarios()).toBe(false);
    });

    test('the log context is the default rule over the context flags, never getContext', () => {
        // (isElectronApp, startedViaCli): a CLI process of either kind answers
        // CLI; only the Electron main process, not started over the CLI,
        // answers GUI.
        mockContextFlags.isElectronApp = false;
        mockContextFlags.startedViaCli = false;
        expect(createNodePlatform(windows).capabilities.logContext()).toBe('CLI');
        mockContextFlags.isElectronApp = false;
        mockContextFlags.startedViaCli = true;
        expect(createNodePlatform(windows).capabilities.logContext()).toBe('CLI');
        mockContextFlags.isElectronApp = true;
        mockContextFlags.startedViaCli = false;
        expect(createNodePlatform(windows).capabilities.logContext()).toBe('GUI');
        mockContextFlags.isElectronApp = true;
        mockContextFlags.startedViaCli = true;
        expect(createNodePlatform(windows).capabilities.logContext()).toBe('CLI');
    });

    test('the hourly cleanup is armed only for an Electron or CLI start', () => {
        mockContextFlags.isElectronApp = true;
        mockContextFlags.startedViaCli = false;
        expect(createNodePlatform(windows).capabilities.logCleanup).toBe(true);
        mockContextFlags.isElectronApp = false;
        mockContextFlags.startedViaCli = true;
        expect(createNodePlatform(windows).capabilities.logCleanup).toBe(true);
        mockContextFlags.startedViaCli = false;
        expect(createNodePlatform(windows).capabilities.logCleanup).toBe(false);
    });
});
