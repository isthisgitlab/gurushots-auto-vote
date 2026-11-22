/**
 * NativeAutovoteBridge wraps the custom AutoVoteBackground Capacitor plugin
 * (the native Foreground Service + AlarmManager that drives background voting).
 * These tests exercise its Capacitor-global guard, lazy plugin resolution, and
 * the { available } result shapes — all without a device. The guard flips
 * through the globalThis.Capacitor the module reads (its presence and its
 * platform probe), and the plugin is injected via globalThis.Capacitor.Plugins.
 * getPlugin() caches its lookup, so each test resets the module registry.
 */

import type { CapacitorGlobals, CapacitorPlugins } from '../../src/ts/core/types/capacitor';
import { invalid } from '../helpers/invalid';

const loadBridge = () =>
    require('../../src/ts/shells/capacitor/NativeAutovoteBridge') as typeof import('../../src/ts/shells/capacitor/NativeAutovoteBridge');

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
            require('../../src/ts/core/logger') as typeof import('../../src/ts/core/logger'),
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
            stopAll: jest.fn(),
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
            stopAll: jest.fn(),
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
            require('../../src/ts/core/logger') as typeof import('../../src/ts/core/logger'),
        ).withCategory.mockReturnValue(invalid({ error }));
        const startFailure = new Error('boom');
        const stopFailure = new Error('stop boom');
        const plugin = {
            start: jest.fn().mockRejectedValue(startFailure),
            stop: jest.fn().mockRejectedValue(stopFailure),
            getStatus: jest.fn().mockRejectedValue(new Error('status boom')),
            compareAndWrite: jest.fn(),
            stopAll: jest.fn(),
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
            require('../../src/ts/core/logger') as typeof import('../../src/ts/core/logger'),
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

    describe("stopAll (the user's full Stop, straight to the native service)", () => {
        // The bridge keeps the plugin it first finds: each call starts from a fresh module.
        const withPlugin = (stopAll: jest.Mock<Promise<unknown>, [{ requestId: string; at: number }]>) => {
            jest.resetModules();
            g.Capacitor = { isNativePlatform: () => true, Plugins: { AutoVoteBackground: invalid({ stopAll }) } };
            return loadBridge();
        };

        test("is null where there is no plugin: the caller's own record is the whole Stop", async () => {
            g.Capacitor = { isNativePlatform: () => true, Plugins: {} };
            await expect(loadBridge().stopAll('stop-a', 1)).resolves.toBeNull();
        });

        test('sends the request id and the time, and answers the epoch the native fence holds', async () => {
            const stopAll = jest.fn<Promise<unknown>, [{ requestId: string; at: number }]>().mockResolvedValue({
                stopped: true,
                durable: true,
                epoch: 4,
            });
            await expect(withPlugin(stopAll).stopAll('stop-a', 1700)).resolves.toEqual({ durable: true, epoch: 4 });
            expect(stopAll).toHaveBeenCalledWith({ requestId: 'stop-a', at: 1700 });
        });

        test('a Stop the fence did not take says why, and the cancellation is not undone', async () => {
            for (const reason of ['unreadable', 'oversize', 'not-saved'] as const) {
                const stopAll = jest
                    .fn<Promise<unknown>, [{ requestId: string; at: number }]>()
                    .mockResolvedValue({ stopped: true, durable: false, reason });
                await expect(withPlugin(stopAll).stopAll('stop-a', 1)).resolves.toEqual({ durable: false, reason });
            }
        });

        test("an answer that is not the plugin's shape is a Stop that is not durable", async () => {
            for (const answer of [
                null,
                'ok',
                { stopped: true, durable: true },
                { stopped: true, durable: true, epoch: 1.5 },
                { stopped: true, durable: false, reason: 'weird' },
                { stopped: true, durable: false },
            ]) {
                const stopAll = jest
                    .fn<Promise<unknown>, [{ requestId: string; at: number }]>()
                    .mockResolvedValue(answer);
                await expect(withPlugin(stopAll).stopAll('stop-a', 1)).resolves.toEqual({
                    durable: false,
                    reason: 'not-saved',
                });
            }
        });

        test('a call the plugin rejects is logged and is a Stop that is not durable', async () => {
            const error = jest.fn();
            const failure = new Error('invalid stop');
            const bridge = withPlugin(
                jest.fn<Promise<unknown>, [{ requestId: string; at: number }]>().mockRejectedValue(failure),
            );
            // After the fresh module: the logger the bridge loaded is the one to stand in for.
            jest.mocked(
                require('../../src/ts/core/logger') as typeof import('../../src/ts/core/logger'),
            ).withCategory.mockReturnValue(invalid({ error }));
            await expect(bridge.stopAll('stop-a', 1)).resolves.toEqual({ durable: false, reason: 'not-saved' });
            expect(error).toHaveBeenCalledWith('AutoVoteBackground.stopAll failed', failure);
        });
    });
});
