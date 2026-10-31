/**
 * The background hosts the autovote controller's host carries: the Capacitor
 * one over the two bridges (the native AutoVote plugin when available, the
 * foreground-notification-only controller when not) and the no-op one
 * (Electron, web shell).
 */

import * as foregroundService from '../../src/ts/services/ForegroundServiceController';
import * as nativeAutovote from '../../src/ts/services/NativeAutovoteBridge';
import type * as hostsModule from '../../src/ts/bridge/capacitorBackgroundHost';
import type * as noopModule from '../../src/ts/react/contexts/noopBackgroundHost';
import { invalid } from '../helpers/invalid';

const { capacitorBackgroundHost } = require('../../src/ts/bridge/capacitorBackgroundHost') as typeof hostsModule;
const { noopBackgroundHost } = require('../../src/ts/react/contexts/noopBackgroundHost') as typeof noopModule;

jest.mock('../../src/ts/services/ForegroundServiceController', () => ({
    __esModule: true,
    start: jest.fn(),
    stop: jest.fn(),
    update: jest.fn(),
}));

jest.mock('../../src/ts/services/NativeAutovoteBridge', () => ({
    __esModule: true,
    start: jest.fn(),
    stop: jest.fn(),
    getStatus: jest.fn(),
}));

describe('capacitorBackgroundHost', () => {
    beforeEach(() => {
        jest.mocked(nativeAutovote.start)
            .mockReset()
            .mockResolvedValue(invalid({ available: false }));
        jest.mocked(nativeAutovote.stop)
            .mockReset()
            .mockResolvedValue(invalid({ available: false }));
        jest.mocked(foregroundService.start).mockReset().mockResolvedValue(true);
        jest.mocked(foregroundService.stop).mockReset().mockResolvedValue(undefined);
        jest.mocked(foregroundService.update).mockReset().mockResolvedValue(undefined);
    });

    it('start hands scheduling to the native plugin when it is available', async () => {
        jest.mocked(nativeAutovote.start).mockResolvedValue(invalid({ available: true }));
        await capacitorBackgroundHost.start('Preparing');
        expect(nativeAutovote.start).toHaveBeenCalledTimes(1);
        expect(foregroundService.start).not.toHaveBeenCalled();
    });

    it('start falls back to the foreground notification when the plugin is unavailable', async () => {
        await capacitorBackgroundHost.start('Preparing');
        expect(foregroundService.start).toHaveBeenCalledWith({ body: 'Preparing' });
    });

    it('stop mirrors start: the plugin tears down its own notification, else the controller stops', async () => {
        await capacitorBackgroundHost.stop();
        expect(nativeAutovote.stop).toHaveBeenCalledTimes(1);
        expect(foregroundService.stop).toHaveBeenCalledTimes(1);

        jest.mocked(nativeAutovote.stop).mockResolvedValue(invalid({ available: true }));
        await capacitorBackgroundHost.stop();
        expect(foregroundService.stop).toHaveBeenCalledTimes(1);
    });

    it('update passes the translated body only — the service keeps its own app-name title', async () => {
        await capacitorBackgroundHost.update('a title', 'Last cycle: 12:00:00');
        expect(foregroundService.update).toHaveBeenCalledWith({ body: 'Last cycle: 12:00:00' });
    });

    it('status reads the native plugin', async () => {
        jest.mocked(nativeAutovote.getStatus)
            .mockReset()
            .mockResolvedValue(invalid({ running: true, available: true }));
        await expect(capacitorBackgroundHost.status()).resolves.toEqual({ running: true, available: true });
        expect(nativeAutovote.getStatus).toHaveBeenCalledTimes(1);
    });
});

describe('noopBackgroundHost', () => {
    it('answers unavailable and resolves every call without effect', async () => {
        await expect(noopBackgroundHost.status()).resolves.toEqual({ running: false, available: false });
        await expect(noopBackgroundHost.start('Preparing')).resolves.toBeUndefined();
        await expect(noopBackgroundHost.update('title', 'body')).resolves.toBeUndefined();
        await expect(noopBackgroundHost.stop()).resolves.toBeUndefined();
    });
});
