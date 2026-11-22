/**
 * The node family as a whole: the platform createNodePlatform builds with the
 * windows the shell passes. The log context is the default rule, computed
 * from the family's Electron check and the context module's CLI-start flag —
 * both are mocked here with live flags, and no case calls getContext.
 */

const mockContextFlags = { isElectron: false, startedViaCli: false };

const mockLock = {
    isCliSessionActive: jest.fn<Promise<boolean>, []>(async () => false),
    isDesktopAppActive: jest.fn<Promise<boolean>, []>(async () => false),
    isWebServerActive: jest.fn<Promise<boolean>, []>(async () => false),
    MARKER_NAME_RE: /^(?:m-1|m-2)\.lock$/,
    APP_LOCK_FILE_NAME: 'desktop-app.lock',
};

jest.mock('../../../src/ts/core/logger/context', () => ({
    __esModule: true,
    get startedViaCli() {
        return mockContextFlags.startedViaCli;
    },
}));
jest.mock('../../../src/ts/platforms/node/paths', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../../src/ts/platforms/node/paths')>(
        '../../../src/ts/platforms/node/paths',
    ),
    isElectron: () => mockContextFlags.isElectron,
}));
jest.mock('../../../src/ts/platforms/node/cliSessionLock', () => mockLock);

import { createNodePlatform } from '../../../src/ts/platforms/node';

import type { PlatformWindows } from '../../../src/ts/core/platform/port';

// The CLI's windows: the explicit no-ops its shell module passes (a desktop
// command run has no windows to broadcast to or relaunch).
const windows: PlatformWindows = {
    broadcastSettingsChanged: () => undefined,
    broadcastEvent: () => undefined,
    afterWipe: () => undefined,
};

describe('the node platform: the remote-access status', () => {
    test('a shell with no pairing reports it unsupported', async () => {
        await expect(createNodePlatform(windows, 'cli').native.readScenarioHostStatus()).resolves.toEqual({
            supported: false,
        });
    });

    test('a shell that has one supplies its own reader, which the family hands on untouched', async () => {
        const status = { supported: true as const, remoteEnabled: true, remoteConnected: null };
        const read = jest.fn(async () => status);
        const p = createNodePlatform(windows, 'electron', {}, read);
        expect(p.native.readScenarioHostStatus).toBe(read);
        await expect(p.native.readScenarioHostStatus()).resolves.toBe(status);
    });
});

describe('the node platform', () => {
    test('it has no adapter, native services or Capacitor transport', () => {
        const p = createNodePlatform(windows, 'cli');
        expect(p.http.adapter).toBeNull();
        expect(p.native).toEqual({
            autovote: null,
            foregroundService: null,
            apkInstaller: null,
            readScenarioHostStatus: expect.any(Function),
        });
        expect(p.wipe.clearSession).toBeNull();
        expect(p.wipe.reloadAfterWipe).toBe(false);
        expect(p.wipe.listPreferenceKeys).toBeNull();
        expect(p.wipe.removePreferenceKeys).toBeNull();
    });

    test('the wipe finds no native plugin to ask, as localData answers without one', async () => {
        await expect(createNodePlatform(windows, 'cli').wipe.nativeWipe()).resolves.toBeNull();
    });

    test("the user-data markers are the CLI-session lock module's to hold and read", async () => {
        const wipe = createNodePlatform(windows, 'cli').wipe;
        mockLock.isCliSessionActive.mockResolvedValueOnce(true);
        await expect(wipe.markers.isCliSessionActive()).resolves.toBe(true);
        expect(mockLock.isCliSessionActive).toHaveBeenCalledTimes(1);
        await expect(wipe.markers.isDesktopAppActive()).resolves.toBe(false);
        await expect(wipe.markers.isWebServerActive()).resolves.toBe(false);
        expect(wipe.markers.isMarkerFile('m-1.lock')).toBe(true);
        expect(wipe.markers.isMarkerFile('desktop-app.lock')).toBe(true);
        expect(wipe.markers.isMarkerFile('other.lock')).toBe(false);
    });

    test('the windows are the ones the shell passes', () => {
        expect(createNodePlatform(windows, 'cli').windows).toBe(windows);
    });

    test('the constants name the node answers', () => {
        const c = createNodePlatform(windows, 'cli').capabilities;
        expect(c.executor).toBe('cli');
        expect(c.refreshMissionNeeds).toBe(false);
        expect(c.snapAllowed).toBe(true);
        expect(c.recoveryWording).toBe('file');
    });

    test('no background service owns the scenarios here', () => {
        expect(createNodePlatform(windows, 'cli').capabilities.backgroundServiceOwnsScenarios()).toBe(false);
    });

    test('the log context is the default rule over the electron check and the CLI-start flag, never getContext', () => {
        // (isElectron, startedViaCli): a CLI process of either kind answers
        // CLI; only the Electron main process, not started over the CLI,
        // answers GUI.
        mockContextFlags.isElectron = false;
        mockContextFlags.startedViaCli = false;
        expect(createNodePlatform(windows, 'cli').capabilities.logContext()).toBe('CLI');
        mockContextFlags.isElectron = false;
        mockContextFlags.startedViaCli = true;
        expect(createNodePlatform(windows, 'cli').capabilities.logContext()).toBe('CLI');
        mockContextFlags.isElectron = true;
        mockContextFlags.startedViaCli = false;
        expect(createNodePlatform(windows, 'cli').capabilities.logContext()).toBe('GUI');
        mockContextFlags.isElectron = true;
        mockContextFlags.startedViaCli = true;
        expect(createNodePlatform(windows, 'cli').capabilities.logContext()).toBe('CLI');
    });

    test('the hourly cleanup is armed only for an Electron or CLI start', () => {
        mockContextFlags.isElectron = true;
        mockContextFlags.startedViaCli = false;
        expect(createNodePlatform(windows, 'cli').capabilities.logCleanup).toBe(true);
        mockContextFlags.isElectron = false;
        mockContextFlags.startedViaCli = true;
        expect(createNodePlatform(windows, 'cli').capabilities.logCleanup).toBe(true);
        mockContextFlags.startedViaCli = false;
        expect(createNodePlatform(windows, 'cli').capabilities.logCleanup).toBe(false);
    });
});
