/**
 * NativeAutovoteBridge wraps the custom AutoVoteBackground Capacitor plugin
 * (the native Foreground Service + AlarmManager that drives background voting).
 * These tests exercise its runtime guard, lazy plugin resolution, and the
 * { available } result shapes — all without a device. runtime is mocked so
 * isCapacitor() can be flipped per-test; the plugin is injected via
 * globalThis.Capacitor.Plugins. getPlugin() caches its lookup, so each test
 * resets the module registry.
 */

import type * as RuntimeModule from '../../src/ts/runtime';
import type { CapacitorGlobals, CapacitorPlugins } from '../../src/ts/types/capacitor';
import { invalid } from '../helpers/invalid';

jest.mock('../../src/ts/runtime', () => ({
    isCapacitor: jest.fn(() => false),
}));

const loadBridge = () =>
    require('../../src/ts/services/NativeAutovoteBridge') as typeof import('../../src/ts/services/NativeAutovoteBridge');

const g = globalThis as CapacitorGlobals;

describe('NativeAutovoteBridge', () => {
    let runtime: jest.MockedObject<typeof RuntimeModule>;

    beforeEach(() => {
        jest.resetModules();
        delete g.Capacitor;
        runtime = jest.mocked(require('../../src/ts/runtime') as typeof RuntimeModule);
        runtime.isCapacitor.mockReturnValue(true);
    });

    afterEach(() => {
        delete g.Capacitor;
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
        g.Capacitor = { Plugins: {} };
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
        g.Capacitor = { Plugins: { AutoVoteBackground: plugin } };
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
        g.Capacitor = { Plugins: { AutoVoteBackground: plugin } };
        const bridge = loadBridge();

        await expect(bridge.start()).resolves.toEqual({ running: false, available: true, error: 'boom' });
        await expect(bridge.stop()).resolves.toEqual({ running: false, available: true, error: 'stop boom' });
        await expect(bridge.getStatus()).resolves.toEqual({ running: false, available: true, error: 'status boom' });
    });

    test('a start/stop failure is logged, a getStatus failure is not (it polls)', async () => {
        const error = jest.fn();
        jest.mocked(
            require('../../src/ts/logger') as typeof import('../../src/ts/logger'),
        ).withCategory.mockReturnValue(invalid({ error }));
        const startFailure = new Error('boom');
        const stopFailure = new Error('stop boom');
        const plugin = {
            start: jest.fn().mockRejectedValue(startFailure),
            stop: jest.fn().mockRejectedValue(stopFailure),
            getStatus: jest.fn().mockRejectedValue(new Error('status boom')),
        };
        g.Capacitor = { Plugins: { AutoVoteBackground: plugin } };
        const bridge = loadBridge();

        await bridge.getStatus();
        expect(error).not.toHaveBeenCalled();

        await bridge.start();
        await bridge.stop();
        expect(error).toHaveBeenCalledTimes(2);
        expect(error).toHaveBeenNthCalledWith(1, 'AutoVoteBackground.start failed', startFailure);
        expect(error).toHaveBeenNthCalledWith(2, 'AutoVoteBackground.stop failed', stopFailure);
    });

    test('reports unavailable (and logs) when reading the plugin registry throws', async () => {
        const warning = jest.fn();
        jest.mocked(
            require('../../src/ts/logger') as typeof import('../../src/ts/logger'),
        ).withCategory.mockReturnValueOnce(invalid({ warning }));
        g.Capacitor = {
            get Plugins(): CapacitorPlugins {
                throw new Error('bridge not ready');
            },
        };
        const bridge = loadBridge();

        expect(bridge.isAvailable()).toBe(false);
        expect(warning).toHaveBeenCalledWith('NativeAutovoteBridge.getPlugin failed', 'bridge not ready');
    });
});
