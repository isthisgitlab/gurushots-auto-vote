/**
 * Desktop startup clears a login a crashed run left behind (Stay Logged In off), under
 * the single-instance lock (onReady runs for no other instance), and never while a CLI
 * session holds its marker. The CLI and the Android service do not do this at all.
 */

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
jest.mock('../../src/ts/settings/cliSessionLock', () => ({ isCliSessionActive: jest.fn(() => false) }));
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

import loggerModule = require('../../src/ts/logger');
import settingsModule = require('../../src/ts/settings');
import lockModule = require('../../src/ts/settings/cliSessionLock');
import type * as startupModule from '../../src/ts/index/startup';
import type { AppSettings } from '../../src/ts/types/settings';
import { invalid } from '../helpers/invalid';

const settings = jest.mocked(settingsModule);
const lock = jest.mocked(lockModule);
const cat = invalid<{
    __cat: { info: jest.Mock<void, [string, ...unknown[]]>; error: jest.Mock<void, [string, ...unknown[]]> };
}>(loggerModule).__cat;
const { onReady } = require('../../src/ts/index/startup') as typeof startupModule;

const stored = (over: Partial<AppSettings>) => settings.loadSettings.mockReturnValue(invalid(over));

describe('desktop startup clears a leftover login', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        lock.isCliSessionActive.mockReturnValue(false);
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

    test('it is cleared before the auto-login decision reads the settings', async () => {
        stored({ token: 'left-over', stayLoggedIn: false });

        await onReady();

        const clearedAt = settings.setSetting.mock.invocationCallOrder[0];
        const autoLoginReadAt = settings.loadSettings.mock.invocationCallOrder.at(-1)!;
        expect(clearedAt).toBeLessThan(autoLoginReadAt);
    });

    test('with a CLI session holding its marker it is kept', async () => {
        stored({ token: 'cli-uses-this', stayLoggedIn: false });
        lock.isCliSessionActive.mockReturnValue(true);

        await onReady();

        expect(settings.setSetting).not.toHaveBeenCalled();
        expect(cat.info).toHaveBeenCalledWith(expect.stringContaining('a CLI session is running'), null);
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
