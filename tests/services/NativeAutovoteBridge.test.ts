/**
 * NativeAutovoteBridge wraps the custom AutoVoteBackground Capacitor plugin
 * (the native Foreground Service + AlarmManager that drives background voting).
 * These tests exercise its Capacitor-global guard, lazy plugin resolution, and
 * the { available } result shapes — all without a device. The guard flips
 * through the globalThis.Capacitor the module reads (its presence and its
 * platform probe), and the plugin is injected via globalThis.Capacitor.Plugins.
 * getPlugin() caches its lookup, so each test resets the module registry.
 */

import type { CapacitorGlobals, CapacitorPlugins } from '../../src/ts/types/capacitor';
import { invalid } from '../helpers/invalid';

const loadBridge = () =>
    require('../../src/ts/services/NativeAutovoteBridge') as typeof import('../../src/ts/services/NativeAutovoteBridge');

const g = globalThis as CapacitorGlobals;

describe('NativeAutovoteBridge', () => {
    beforeEach(() => {
        jest.resetModules();
        // On the native platform by default; the tests that say otherwise
        // delete or reshape the global.
        g.Capacitor = { isNativePlatform: () => true };
    });

    afterEach(() => {
        delete g.Capacitor;
    });

    describe('when not running on Capacitor', () => {
        beforeEach(() => {
            delete g.Capacitor;
        });

        test('isAvailable() is false and start/stop/getStatus report unavailable', async () => {
            const bridge = loadBridge();
            expect(bridge.isAvailable()).toBe(false);
            await expect(bridge.start()).resolves.toEqual({ running: false, available: false });
            await expect(bridge.stop()).resolves.toEqual({ running: false, available: false });
            await expect(bridge.getStatus()).resolves.toEqual({ running: false, available: false });
        });
    });

    test('says once that the plugin is not registered, however often it is asked for', () => {
        const warning = jest.fn();
        jest.mocked(
            require('../../src/ts/logger') as typeof import('../../src/ts/logger'),
        ).withCategory.mockReturnValue(invalid({ warning }));
        g.Capacitor = { isNativePlatform: () => true, Plugins: {} };
        const bridge = loadBridge();
        expect(bridge.isAvailable()).toBe(false);
        expect(bridge.compareAndWrite('gs_join_state', null, '{}')).toBeNull();
        expect(bridge.isAvailable()).toBe(false);
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith('AutoVoteBackground plugin not registered on this build');
    });

    test('reports unavailable when the plugin is not registered on the build', async () => {
        g.Capacitor = { isNativePlatform: () => true, Plugins: {} };
        const bridge = loadBridge();
        expect(bridge.isAvailable()).toBe(false);
        await expect(bridge.start()).resolves.toEqual({ running: false, available: false });
    });

    test('start/stop/getStatus spread the plugin result and mark available', async () => {
        const plugin = {
            start: jest.fn().mockResolvedValue({ running: true }),
            stop: jest.fn().mockResolvedValue({ running: false }),
            getStatus: jest.fn().mockResolvedValue({ running: true, nextDelayMs: 180000 }),
            compareAndWrite: jest.fn(),
            wipeLocalData: jest.fn(),
        };
        g.Capacitor = { isNativePlatform: () => true, Plugins: { AutoVoteBackground: plugin } };
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
            compareAndWrite: jest.fn(),
            wipeLocalData: jest.fn(),
        };
        g.Capacitor = { isNativePlatform: () => true, Plugins: { AutoVoteBackground: plugin } };
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
            compareAndWrite: jest.fn(),
            wipeLocalData: jest.fn(),
        };
        g.Capacitor = { isNativePlatform: () => true, Plugins: { AutoVoteBackground: plugin } };
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
            isNativePlatform: () => true,
            get Plugins(): CapacitorPlugins {
                throw new Error('bridge not ready');
            },
        };
        const bridge = loadBridge();

        expect(bridge.isAvailable()).toBe(false);
        expect(warning).toHaveBeenCalledWith('NativeAutovoteBridge.getPlugin failed', 'bridge not ready');
    });

    describe('compareAndWrite (the app window changing a store the service changes too)', () => {
        test('goes to the plugin with the key, what the caller read and the new value, and answers what it did', async () => {
            const compareAndWrite = jest.fn().mockResolvedValue({ saved: false, current: '{"a":1}' });
            g.Capacitor = {
                isNativePlatform: () => true,
                Plugins: { AutoVoteBackground: invalid({ compareAndWrite }) },
            };
            const bridge = loadBridge();
            await expect(bridge.compareAndWrite('gs_join_state', null, '{"b":1}')).resolves.toEqual({
                saved: false,
                current: '{"a":1}',
            });
            expect(compareAndWrite).toHaveBeenCalledWith({ key: 'gs_join_state', expected: null, value: '{"b":1}' });
        });

        test('is null where there is no plugin (a build without the service): the caller is the only writer', () => {
            g.Capacitor = { isNativePlatform: () => true, Plugins: {} };
            expect(loadBridge().compareAndWrite('gs_join_state', null, '{}')).toBeNull();
        });

        test('a rejection of the plugin reaches the caller, who treats it as not saved', async () => {
            const compareAndWrite = jest.fn().mockRejectedValue(new Error('not saved'));
            g.Capacitor = {
                isNativePlatform: () => true,
                Plugins: { AutoVoteBackground: invalid({ compareAndWrite }) },
            };
            await expect(loadBridge().compareAndWrite('gs_join_state', null, '{}')).rejects.toThrow('not saved');
        });
    });
});
