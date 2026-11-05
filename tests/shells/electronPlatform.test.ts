/**
 * The Electron shell's platform module: it installs the node family with the
 * shell's own members when it loads — the settings broadcast, the post-wipe
 * relaunch and the session clear are the module's own bodies, their electron
 * reads reached at call time, so the install runs before the logger loads and
 * no electron import happens at install time. electron is mocked; the
 * process.versions.electron flag is set, so the family's Electron reads
 * resolve the way they do in the main process. The installed object is
 * captured once: the setup file's afterEach reinstalls the node test platform
 * on the port, so the tests read the captured object, not the slot.
 */

import { APP_PARTITION } from '../../src/ts/shells/electron/index/session';
import { platform } from '../../src/ts/core/platform/port';
import { clearInstalledPlatform } from '../helpers/platform';

import type { ElectronPlatform } from '../../src/ts/core/platform/port';

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
require('../../src/ts/shells/electron/platform');
const installed: ElectronPlatform = platform() as ElectronPlatform;

// The version flag is what the family's Electron check reads, so every test
// has it the way the main process does.
beforeEach(() => {
    (process.versions as { electron?: string }).electron = '43.0.0';
});

afterEach(() => {
    delete (process.versions as { electron?: string }).electron;
});

// The electron reads are reached at call time — the install must run before
// the logger loads (whose own absence from the chain the bundle check proves)
// — so loading the module must not require electron at all.

describe('the Electron shell platform module', () => {
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

    test('paths.isPackaged reads the electron app the family guards', () => {
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

// The electron-deferral suite stands last: its jest.doMock registration is
// cleaned in its own afterEach, and nothing after it needs the file-level
// mocks.
describe('loading the Electron shell platform module defers electron', () => {
    afterEach(() => {
        jest.dontMock('electron');
    });

    test('loading installs the platform and does not require electron', () => {
        jest.isolateModules(() => {
            clearInstalledPlatform();
            jest.doMock('electron', () => {
                throw new Error('electron must not load at install time');
            });
            require('../../src/ts/shells/electron/platform');
            expect(platform()).toBeDefined();
            expect(platform().wipe.clearSession).not.toBeNull();
        });
    });
});
