/**
 * ForegroundServiceController is a thin wrapper around the Android foreground-
 * service plugin — it owns ONLY the persistent "auto-vote running" notification.
 * These tests cover the runtime guard (no-op off Capacitor), the permission
 * check/request branches, and the success / throw-swallowing paths of
 * start/update/stop, without a device. The plugin module and runtime are mocked.
 */

const mockFsPlugin = {
    checkPermissions: jest.fn(),
    requestPermissions: jest.fn(),
    startForegroundService: jest.fn(),
    updateForegroundService: jest.fn(),
    stopForegroundService: jest.fn(),
};

jest.mock('@capawesome-team/capacitor-android-foreground-service', () => ({ ForegroundService: mockFsPlugin }));
jest.mock('../../src/js/runtime', () => ({
    isCapacitor: jest.fn(() => false),
}));

describe('ForegroundServiceController', () => {
    let runtime;
    let controller;

    beforeEach(() => {
        jest.resetModules();
        runtime = require('../../src/js/runtime');
        runtime.isCapacitor.mockReturnValue(true);
        // Happy defaults; individual tests override as needed.
        mockFsPlugin.checkPermissions.mockResolvedValue({ display: 'granted' });
        mockFsPlugin.requestPermissions.mockResolvedValue({ display: 'granted' });
        mockFsPlugin.startForegroundService.mockResolvedValue(undefined);
        mockFsPlugin.updateForegroundService.mockResolvedValue(undefined);
        mockFsPlugin.stopForegroundService.mockResolvedValue(undefined);
        controller = require('../../src/js/services/ForegroundServiceController');
    });

    describe('when not running on Capacitor (no-op)', () => {
        beforeEach(() => runtime.isCapacitor.mockReturnValue(false));

        test('start resolves false and never touches the plugin', async () => {
            await expect(controller.start()).resolves.toBe(false);
            expect(mockFsPlugin.startForegroundService).not.toHaveBeenCalled();
        });

        test('requestPermissions returns granted without calling the plugin', async () => {
            await expect(controller.requestPermissions()).resolves.toEqual({ display: 'granted' });
            expect(mockFsPlugin.checkPermissions).not.toHaveBeenCalled();
        });

        test('update and stop are silent no-ops', async () => {
            await expect(controller.update({ body: 'x' })).resolves.toBeUndefined();
            await expect(controller.stop()).resolves.toBeUndefined();
            expect(mockFsPlugin.updateForegroundService).not.toHaveBeenCalled();
            expect(mockFsPlugin.stopForegroundService).not.toHaveBeenCalled();
        });
    });

    test('requestPermissions short-circuits when display is already granted', async () => {
        mockFsPlugin.checkPermissions.mockResolvedValue({ display: 'granted' });
        const res = await controller.requestPermissions();
        expect(res).toEqual({ display: 'granted' });
        expect(mockFsPlugin.requestPermissions).not.toHaveBeenCalled();
    });

    test('requestPermissions requests when not yet granted', async () => {
        mockFsPlugin.checkPermissions.mockResolvedValue({ display: 'prompt' });
        mockFsPlugin.requestPermissions.mockResolvedValue({ display: 'granted' });
        const res = await controller.requestPermissions();
        expect(mockFsPlugin.requestPermissions).toHaveBeenCalled();
        expect(res).toEqual({ display: 'granted' });
    });

    test('requestPermissions returns denied when the plugin throws', async () => {
        mockFsPlugin.checkPermissions.mockRejectedValue(new Error('no perms'));
        await expect(controller.requestPermissions()).resolves.toEqual({ display: 'denied' });
    });

    test('start requests permissions, starts the service, and returns true', async () => {
        const ok = await controller.start({ title: 'T', body: 'B' });
        expect(ok).toBe(true);
        expect(mockFsPlugin.startForegroundService).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'T', body: 'B', smallIcon: 'ic_launcher_foreground' }),
        );
    });

    test('start returns false when startForegroundService throws', async () => {
        mockFsPlugin.startForegroundService.mockRejectedValue(new Error('start failed'));
        await expect(controller.start()).resolves.toBe(false);
    });

    test('update is a no-op when body is missing', async () => {
        await controller.update({ title: 'T' });
        expect(mockFsPlugin.updateForegroundService).not.toHaveBeenCalled();
    });

    test('update forwards to the plugin when body is provided', async () => {
        await controller.update({ body: 'next cycle 3m' });
        expect(mockFsPlugin.updateForegroundService).toHaveBeenCalledWith(
            expect.objectContaining({ body: 'next cycle 3m' }),
        );
    });

    test('update swallows a plugin throw (service not running yet)', async () => {
        mockFsPlugin.updateForegroundService.mockRejectedValue(new Error('not running'));
        await expect(controller.update({ body: 'x' })).resolves.toBeUndefined();
    });

    test('stop calls the plugin and swallows throws', async () => {
        await controller.stop();
        expect(mockFsPlugin.stopForegroundService).toHaveBeenCalled();

        mockFsPlugin.stopForegroundService.mockRejectedValue(new Error('stop failed'));
        await expect(controller.stop()).resolves.toBeUndefined();
    });
});
