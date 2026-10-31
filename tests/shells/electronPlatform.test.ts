/**
 * The Electron shell's platform module: it installs the node family with the
 * shell's own members when it loads. The shell members are checked against
 * the code they wrap — the settings broadcast and the post-wipe relaunch are
 * the settings.handlers exports, and the wipe's session clear is the
 * localData export. electron is mocked; runtime is a partial mock with
 * isElectron true, so the guarded electron reads resolve the way they do in
 * the main process. The installed object is captured once: the setup file's
 * afterEach reinstalls the node test platform on the port, so the tests read
 * the captured object, not the slot.
 */

import { APP_PARTITION } from '../../src/ts/index/session';
import { platform } from '../../src/ts/platform/port';
import { clearInstalledPlatform } from '../helpers/platform';

import type { ElectronPlatform } from '../../src/ts/platform/port';

/** One session the wipe clears: the fake answers what clearElectronSession calls. */
interface FakeSessionTarget {
    clearStorageData: jest.Mock<Promise<void>, []>;
    clearCache: jest.Mock<Promise<void>, []>;
}

/** A window the broadcast reaches (or skips, when destroyed). */
interface FakeBrowserWindow {
    isDestroyed: () => boolean;
    webContents: { send: jest.Mock<void, [string, unknown]> };
}

/** The electron mock's shape, as the guarded reads consume it. */
interface FakeElectron {
    BrowserWindow: { getAllWindows: jest.Mock<FakeBrowserWindow[], []> };
    app: {
        isPackaged: boolean;
        relaunch: jest.Mock<void, []>;
        exit: jest.Mock<void, [number]>;
        getPath: jest.Mock<string, [string]>;
    };
    session: { fromPartition: jest.Mock<FakeSessionTarget, [string]>; defaultSession: FakeSessionTarget };
}

jest.mock('../../src/ts/runtime', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/runtime')>('../../src/ts/runtime'),
    isElectron: () => true,
    isPackaged: () => true,
}));

jest.mock('electron', () => ({
    __esModule: true,
    BrowserWindow: { getAllWindows: jest.fn<FakeBrowserWindow[], []>() },
    app: {
        isPackaged: true,
        relaunch: jest.fn<void, []>(),
        exit: jest.fn<void, [number]>(),
        getPath: jest.fn<string, [string]>(),
    },
    session: {
        fromPartition: jest.fn<FakeSessionTarget, [string]>(() => ({
            clearStorageData: jest.fn<Promise<void>, []>(),
            clearCache: jest.fn<Promise<void>, []>(),
        })),
        defaultSession: {
            clearStorageData: jest.fn<Promise<void>, []>(),
            clearCache: jest.fn<Promise<void>, []>(),
        },
    },
}));

const electron = require('electron') as FakeElectron;

// Requiring the module installs the platform; the slot is cleared first,
// because the setup file installed the node test platform before this file
// loaded.
clearInstalledPlatform();
require('../../src/ts/index/platform');
const installed: ElectronPlatform = platform() as ElectronPlatform;

const settingsHandlers =
    require('../../src/ts/ipc/settings.handlers') as typeof import('../../src/ts/ipc/settings.handlers');
const localData = require('../../src/ts/settings/localData') as typeof import('../../src/ts/settings/localData');

describe('the Electron shell platform module', () => {
    test('the module installs the platform, with the shell members it wraps', () => {
        expect(installed.wipe.clearSession).toBe(localData.clearElectronSession);
        expect(installed.windows.broadcastSettingsChanged).toBe(settingsHandlers.broadcastSettingsChanged);
        expect(installed.windows.afterWipe).toBe(settingsHandlers.afterWipe);
    });

    test('the broadcast sends the new settings to every live window, never a destroyed one', () => {
        const send = (): FakeBrowserWindow['webContents']['send'] => jest.fn<void, [string, unknown]>();
        const live: FakeBrowserWindow = { isDestroyed: () => false, webContents: { send: send() } };
        const dead: FakeBrowserWindow = { isDestroyed: () => true, webContents: { send: send() } };
        electron.BrowserWindow.getAllWindows.mockReturnValue([live, dead]);
        const settings = { theme: 'dark' };
        installed.windows.broadcastSettingsChanged(settings);
        expect(live.webContents.send).toHaveBeenCalledWith('settings-changed', settings);
        expect(dead.webContents.send).not.toHaveBeenCalled();
    });

    test('afterWipe relaunches and exits once the reply is out', () => {
        jest.useFakeTimers();
        try {
            installed.windows.afterWipe();
            expect(electron.app.relaunch).not.toHaveBeenCalled();
            jest.advanceTimersByTime(200);
            expect(electron.app.relaunch).toHaveBeenCalledTimes(1);
            expect(electron.app.exit).toHaveBeenCalledWith(0);
        } finally {
            jest.useRealTimers();
        }
    });

    test('the wipe clears the app partition and the default session', async () => {
        await installed.wipe.clearSession();
        expect(electron.session.fromPartition).toHaveBeenCalledWith(APP_PARTITION);
        // The mock's recorded return value is the partition fake the factory built.
        const partition = electron.session.fromPartition.mock.results[0]!.value as FakeSessionTarget;
        for (const target of [partition, electron.session.defaultSession]) {
            expect(target.clearStorageData).toHaveBeenCalledTimes(1);
            expect(target.clearCache).toHaveBeenCalledTimes(1);
        }
    });

    test('paths ride on the runtime seam the family delegates to', () => {
        expect(installed.paths.isPackaged()).toBe(true);
    });

    test('the capabilities answer the Electron values', () => {
        const capabilities = installed.capabilities;
        expect(capabilities.refreshMissionNeeds).toBe(false);
        expect(capabilities.snapAllowed).toBe(true);
        expect(capabilities.backgroundServiceOwnsScenarios()).toBe(false);
        expect(capabilities.recoveryWording).toBe('file');
        // Electron main, not started through the CLI (the logger context's
        // default rule).
        expect(capabilities.logContext()).toBe('GUI');
        expect(capabilities.logCleanup).toBe(true);
    });
});
