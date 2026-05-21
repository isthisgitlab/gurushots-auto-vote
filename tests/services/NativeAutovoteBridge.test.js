/**
 * NativeAutovoteBridge wraps the custom AutoVoteBackground Capacitor plugin
 * (the native Foreground Service + AlarmManager that drives background voting).
 * These tests exercise its runtime guard, lazy plugin resolution, and the
 * { available } result shapes — all without a device. runtime is mocked so
 * isCapacitor() can be flipped per-test; the plugin is injected via
 * globalThis.Capacitor.Plugins. getPlugin() caches its lookup, so each test
 * resets the module registry.
 */

jest.mock('../../src/js/runtime', () => ({
    isCapacitor: jest.fn(() => false),
}));

const loadBridge = () => require('../../src/js/services/NativeAutovoteBridge');

describe('NativeAutovoteBridge', () => {
    let runtime;

    beforeEach(() => {
        jest.resetModules();
        delete globalThis.Capacitor;
        runtime = require('../../src/js/runtime');
        runtime.isCapacitor.mockReturnValue(true);
    });

    afterEach(() => {
        delete globalThis.Capacitor;
    });

    describe('when not running on Capacitor', () => {
        beforeEach(() => runtime.isCapacitor.mockReturnValue(false));

        test('isAvailable() is false and start/stop/getStatus report unavailable', async () => {
            const bridge = loadBridge();
            expect(bridge.isAvailable()).toBe(false);
            await expect(bridge.start()).resolves.toEqual({ running: false, available: false });
            await expect(bridge.stop()).resolves.toEqual({ running: false, available: false });
            await expect(bridge.getStatus()).resolves.toEqual({ running: false, available: false });
        });
    });

    test('reports unavailable when the plugin is not registered on the build', async () => {
        globalThis.Capacitor = { Plugins: {} };
        const bridge = loadBridge();
        expect(bridge.isAvailable()).toBe(false);
        await expect(bridge.start()).resolves.toEqual({ running: false, available: false });
    });

    test('start/stop/getStatus spread the plugin result and mark available', async () => {
        const plugin = {
            start: jest.fn().mockResolvedValue({ running: true }),
            stop: jest.fn().mockResolvedValue({ running: false }),
            getStatus: jest.fn().mockResolvedValue({ running: true, nextDelayMs: 180000 }),
        };
        globalThis.Capacitor = { Plugins: { AutoVoteBackground: plugin } };
        const bridge = loadBridge();

        expect(bridge.isAvailable()).toBe(true);
        await expect(bridge.start()).resolves.toEqual({ running: true, available: true });
        await expect(bridge.stop()).resolves.toEqual({ running: false, available: true });
        await expect(bridge.getStatus()).resolves.toEqual({ running: true, nextDelayMs: 180000, available: true });
    });

    test('start/stop/getStatus surface a plugin throw as an error result (still available)', async () => {
        const plugin = {
            start: jest.fn().mockRejectedValue(new Error('boom')),
            stop: jest.fn().mockRejectedValue(new Error('stop boom')),
            getStatus: jest.fn().mockRejectedValue(new Error('status boom')),
        };
        globalThis.Capacitor = { Plugins: { AutoVoteBackground: plugin } };
        const bridge = loadBridge();

        await expect(bridge.start()).resolves.toEqual({ running: false, available: true, error: 'boom' });
        await expect(bridge.stop()).resolves.toEqual({ running: false, available: true, error: 'stop boom' });
        await expect(bridge.getStatus()).resolves.toEqual({ running: false, available: true, error: 'status boom' });
    });
});
