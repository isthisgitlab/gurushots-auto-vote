/**
 * Desktop startup clears a login a crashed run left behind (Stay Logged In off), under
 * the single-instance lock (onReady runs for no other instance), and never while a CLI
 * session holds its marker. The CLI and the Android service do not do this at all.
 */

const mockReleaseAppLock = jest.fn();
jest.mock('electron', () => ({
    app: { on: jest.fn() },
    BrowserWindow: { getAllWindows: jest.fn(() => []) },
    powerMonitor: { on: jest.fn() },
}));
jest.mock('../../src/ts/settings', () => ({
    getUserDataPath: jest.fn(() => '/u'),
    loadSettings: jest.fn(),
    setSetting: jest.fn(),
    seedIntentProfiles: jest.fn(),
}));
jest.mock('../../src/ts/settings/cliSessionLock', () => ({
    isCliSessionActive: jest.fn(() => Promise.resolve(false)),
    isWebServerActive: jest.fn(() => Promise.resolve(false)),
    holdDesktopAppLock: jest.fn(() => mockReleaseAppLock),
    refreshDesktopAppLock: jest.fn(),
}));
jest.mock('../../src/ts/api/randomizer', () => ({ initializeHeaders: jest.fn() }));
jest.mock('../../src/ts/logger', () => {
    const cat = { info: jest.fn(), error: jest.fn(), warning: jest.fn(), debug: jest.fn() };
    return { withCategory: jest.fn(() => cat), cleanup: jest.fn(), __cat: cat };
});
jest.mock('../../src/ts/services/AutoUpdater', () => ({
    AutoUpdater: jest.fn(() => ({ checkForUpdates: jest.fn().mockResolvedValue(undefined) })),
}));
jest.mock('../../src/ts/windows/lifecycle', () => ({ ensureExit: jest.fn() }));
jest.mock('../../src/ts/windows/quitGuard', () => ({ bypassQuitGuard: jest.fn() }));
jest.mock('../../src/ts/windows/suspendBoost', () => ({ applyImminentBoostsOnSuspend: jest.fn() }));
jest.mock('../../src/ts/ui/applicationMenu', () => ({ createApplicationMenu: jest.fn() }));
jest.mock('../../src/ts/index/windows', () => ({ checkAutoLogin: jest.fn() }));
jest.mock('../../src/ts/index/permissions', () => ({ installPermissionHandlers: jest.fn() }));
jest.mock('../../src/ts/index/state', () => ({ appState: {} }));

import { app, powerMonitor } from 'electron';
import loggerModule = require('../../src/ts/logger');
import settingsModule = require('../../src/ts/settings');
import lockModule = require('../../src/ts/settings/cliSessionLock');
import windowsModule = require('../../src/ts/index/windows');
import type * as startupModule from '../../src/ts/index/startup';
import type { ConfigV2 } from '../../src/ts/types/config';
import { invalid } from '../helpers/invalid';

const settings = jest.mocked(settingsModule);
const lock = jest.mocked(lockModule);
const windows = jest.mocked(windowsModule);
const cat = invalid<{
    __cat: {
        info: jest.Mock<void, [string, ...unknown[]]>;
        error: jest.Mock<void, [string, ...unknown[]]>;
        warning: jest.Mock<void, [string, ...unknown[]]>;
    };
}>(loggerModule).__cat;
const { onReady } = require('../../src/ts/index/startup') as typeof startupModule;

// Each onReady adds process listeners (SIGINT, SIGTERM, exit); the ones a test added are taken off again after it.
const SIGNAL_EVENTS = ['SIGINT', 'SIGTERM', 'exit'] as const;
let listenersBefore: Record<(typeof SIGNAL_EVENTS)[number], Function[]>;
beforeEach(() => {
    listenersBefore = {
        SIGINT: process.listeners('SIGINT'),
        SIGTERM: process.listeners('SIGTERM'),
        exit: process.listeners('exit'),
    };
});
afterEach(() => {
    for (const event of SIGNAL_EVENTS) {
        for (const listener of process.listeners(event)) {
            if (!listenersBefore[event].includes(listener)) process.removeListener(event, listener as () => void);
        }
    }
});

// The configuration the settings answer: what a test says about the sign-in state and the Stay Logged In choice.
const config = (over: { token?: string; stayLoggedIn?: boolean }) =>
    invalid<ConfigV2>({ auth: { token: over.token }, app: { stayLoggedIn: over.stayLoggedIn } });
const stored = (over: { token?: string; stayLoggedIn?: boolean }) =>
    settings.loadSettings.mockReturnValue(config(over));

describe('desktop startup clears a leftover login', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        lock.isCliSessionActive.mockResolvedValue(false);
        lock.isWebServerActive.mockResolvedValue(false);
        settings.setSetting.mockReturnValue(true);
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('a token saved with Stay Logged In off is cleared', async () => {
        stored({ token: 'left-over', stayLoggedIn: false });

        await onReady();

        expect(settings.setSetting).toHaveBeenCalledTimes(1);
        expect(settings.setSetting).toHaveBeenCalledWith('token', '');
        expect(cat.info).toHaveBeenCalledWith(expect.stringContaining('Cleared a saved token'), null);
    });

    test('the first window opens without waiting for an old marker to be read, and the token is cleared once it has been', async () => {
        stored({ token: 'left-over', stayLoggedIn: false });
        let answer: (active: boolean) => void = () => {};
        lock.isCliSessionActive.mockReturnValue(
            new Promise<boolean>((resolve) => {
                answer = resolve;
            }),
        );

        await onReady();

        expect(windows.checkAutoLogin).toHaveBeenCalledTimes(1);
        expect(settings.setSetting).not.toHaveBeenCalled();

        answer(false);
        await jest.advanceTimersByTimeAsync(0);

        expect(settings.setSetting).toHaveBeenCalledWith('token', '');
    });

    test.each([
        ['a new login', { token: 'fresh-login', stayLoggedIn: false }],
        ['Stay Logged In turned on', { token: 'left-over', stayLoggedIn: true }],
    ])('%s made while the marker was being read is never cleared', async (_name, meanwhile) => {
        stored({ token: 'left-over', stayLoggedIn: false });
        let answer: (active: boolean) => void = () => {};
        lock.isCliSessionActive.mockReturnValue(
            new Promise<boolean>((resolve) => {
                answer = resolve;
            }),
        );

        await onReady();
        stored(meanwhile);
        answer(false);
        await jest.advanceTimersByTimeAsync(0);

        expect(settings.setSetting).not.toHaveBeenCalled();
    });

    test('with a CLI session holding its marker it is kept', async () => {
        stored({ token: 'cli-uses-this', stayLoggedIn: false });
        lock.isCliSessionActive.mockResolvedValue(true);

        await onReady();

        expect(settings.setSetting).not.toHaveBeenCalled();
        expect(cat.info).toHaveBeenCalledWith(expect.stringContaining('another session is running'), null);
    });

    test('with a web server holding its marker it is kept', async () => {
        stored({ token: 'web-uses-this', stayLoggedIn: false });
        lock.isWebServerActive.mockResolvedValue(true);

        await onReady();

        expect(settings.setSetting).not.toHaveBeenCalled();
        expect(cat.info).toHaveBeenCalledWith(expect.stringContaining('another session is running'), null);
    });

    test('every message it logs survives the log redactor unchanged', async () => {
        const { redactMessage } =
            jest.requireActual<typeof import('../../src/ts/logger/sanitize')>('../../src/ts/logger/sanitize');
        stored({ token: 'cli-uses-this', stayLoggedIn: false });
        lock.isCliSessionActive.mockResolvedValueOnce(true);
        await onReady();
        stored({ token: 'left-over', stayLoggedIn: false });
        settings.setSetting.mockReturnValue(true);
        await onReady();

        const messages = cat.info.mock.calls.map(([message]) => message);
        expect(messages.length).toBeGreaterThanOrEqual(2);
        for (const message of messages) expect(redactMessage(message)).toBe(message);
    });

    test.each([
        ['Stay Logged In is on', { token: 'keep', stayLoggedIn: true }],
        ['there is no token', { token: '', stayLoggedIn: false }],
    ])('nothing is written when %s', async (_name, over) => {
        stored(over);

        await onReady();

        expect(settings.setSetting).not.toHaveBeenCalled();
        expect(lock.isCliSessionActive).not.toHaveBeenCalled();
    });

    test('a write that was refused says nothing of having cleared it', async () => {
        stored({ token: 'left-over', stayLoggedIn: false });
        settings.setSetting.mockReturnValue(false);

        await onReady();

        expect(cat.info).not.toHaveBeenCalledWith(expect.stringContaining('Cleared a saved token'), null);
    });

    test('a failure never stops startup', async () => {
        settings.loadSettings.mockImplementationOnce(() => {
            throw new Error('unreadable');
        });
        stored({ token: '', stayLoggedIn: false });

        await expect(onReady()).resolves.toBeUndefined();

        expect(cat.error).toHaveBeenCalledWith(
            expect.stringContaining('Failed to clear a leftover token'),
            expect.any(Error),
        );
    });
});

describe('desktop startup marks the app as running', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        settings.loadSettings.mockReturnValue(config({ token: '', stayLoggedIn: false }));
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('it holds the marker before anything else and gives it up when the app quits', async () => {
        await onReady();

        expect(lock.holdDesktopAppLock).toHaveBeenCalledTimes(1);
        expect(lock.holdDesktopAppLock.mock.invocationCallOrder[0]).toBeLessThan(
            settings.seedIntentProfiles.mock.invocationCallOrder[0],
        );
        expect(jest.mocked(app.on)).toHaveBeenCalledWith('will-quit', mockReleaseAppLock);
    });

    test('a marker that cannot be written is logged and never stops startup', async () => {
        lock.holdDesktopAppLock.mockImplementationOnce(() => {
            throw new Error('read-only');
        });

        await expect(onReady()).resolves.toBeUndefined();

        expect(cat.warning).toHaveBeenCalledWith(
            expect.stringContaining('Could not mark the app as running'),
            expect.any(Error),
        );
        expect(jest.mocked(app.on)).not.toHaveBeenCalledWith('will-quit', expect.anything());
    });

    test('waking from sleep refreshes the marker at once', async () => {
        await onReady();

        expect(jest.mocked(powerMonitor.on)).toHaveBeenCalledWith('resume', lock.refreshDesktopAppLock);
    });
});
