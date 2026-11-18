/**
 * src/ts/react/api/ipc.ts — the renderer's wrappers over the shell bridge:
 * pass-throughs keep the bridge's arguments, results and rejections; the
 * optional subscription tolerates a host without the event; the logRenderer*
 * helpers are best-effort and never throw.
 */
import * as ipc from '@/api/ipc';
import { mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';

/** The wrappers looked up by name, for the table-driven cases. */
type IpcByName = Record<string, (...args: unknown[]) => unknown>;
/** The bridge mocks looked up by name, for the same table-driven cases. */
const mockByName = invalid<Record<string, jest.Mock<Promise<unknown>, unknown[]>>>(mockApi);

beforeEach(() => {
    window.api = invalid(mockApi);
    jest.clearAllMocks();
});

afterEach(() => {
    window.api = invalid(mockApi);
});

describe('pass-through wrappers', () => {
    test('forward every argument and return the bridge result unchanged', async () => {
        mockApi.replaceChallengeOverrides.mockResolvedValueOnce(false);
        await expect(ipc.replaceChallengeOverrides('7', { a: 1 }, ['b'])).resolves.toBe(false);
        expect(mockApi.replaceChallengeOverrides).toHaveBeenCalledWith('7', { a: 1 }, ['b']);
    });

    test('propagate a rejection to the caller', async () => {
        mockApi.setTitleRules.mockRejectedValueOnce(new Error('ipc down'));
        await expect(ipc.setTitleRules([])).rejects.toThrow('ipc down');
    });

    test('resolve the bridge at call time, not import time', async () => {
        const getSettings = jest.fn().mockResolvedValue({ app: {} });
        window.api = invalid({ getSettings });
        await expect(ipc.getSettings()).resolves.toEqual({ app: {} });
        expect(getSettings).toHaveBeenCalledTimes(1);
    });

    test('return a subscription unsubscribe handle as-is', () => {
        const off = jest.fn();
        mockApi.onLogMessage.mockReturnValueOnce(off);
        const listener = jest.fn();
        expect(ipc.onLogMessage(listener)).toBe(off);
        expect(mockApi.onLogMessage).toHaveBeenCalledWith(listener);
    });
});

describe('scenario wrappers', () => {
    test.each([
        ['getScenarios', []],
        ['checkScenario', [{ name: 'Draft' }]],
        ['saveScenario', [{ name: 'Plan' }, { overwrite: false }]],
        ['renameScenario', ['Old', 'New']],
        ['deleteScenario', ['Plan']],
        ['previewScenarioImport', ['{}']],
        ['importScenario', ['{}', { overwrite: true }]],
        ['exportScenario', ['Plan']],
        ['getScenarioStatus', ['7']],
        ['resetScenarioState', ['7']],
        ['resetAllScenarioState', []],
        ['dryRunScenario', ['7']],
        ['simulateScenario', ['7', { name: 'Draft' }]],
    ])('%s forwards its arguments', async (method, args) => {
        mockByName[method].mockResolvedValueOnce({ success: true });
        await expect(invalid<IpcByName>(ipc)[method](...args)).resolves.toEqual({ success: true });
        expect(mockByName[method]).toHaveBeenCalledWith(...args);
    });
});

describe('onSettingsChanged', () => {
    test('subscribes and returns the unsubscribe handle', () => {
        const off = jest.fn();
        mockApi.onSettingsChanged.mockReturnValueOnce(off);
        const listener = jest.fn();
        expect(ipc.onSettingsChanged(listener)).toBe(off);
        expect(mockApi.onSettingsChanged).toHaveBeenCalledWith(listener);
    });

    test('returns undefined on a host without the event or without a bridge', () => {
        window.api = invalid({});
        expect(ipc.onSettingsChanged(jest.fn())).toBeUndefined();
        window.api = invalid(undefined);
        expect(ipc.onSettingsChanged(jest.fn())).toBeUndefined();
    });
});

describe('callOrNull', () => {
    test('resolves with the call result', async () => {
        await expect(ipc.callOrNull(() => Promise.resolve({ success: true }))).resolves.toEqual({ success: true });
    });

    test('turns a rejection or a missing bridge into null', async () => {
        await expect(ipc.callOrNull(() => Promise.reject(new Error('ipc down')))).resolves.toBeNull();
        window.api = invalid(undefined);
        await expect(ipc.callOrNull(() => ipc.getSettings())).resolves.toBeNull();
    });
});

describe('refreshMenu', () => {
    test('forwards to the host menu, or returns undefined without one', async () => {
        await ipc.refreshMenu();
        expect(mockApi.refreshMenu).toHaveBeenCalledTimes(1);
        window.api = invalid({});
        expect(ipc.refreshMenu()).toBeUndefined();
    });
});

describe.each([
    ['logRendererError', 'logError'],
    ['logRendererWarning', 'logWarning'],
    ['logRendererDebug', 'logDebug'],
])('%s', (helper, method) => {
    test(`hands the message to ${method} synchronously and resolves`, async () => {
        const pending = invalid<IpcByName>(ipc)[helper]('hello');
        expect(mockByName[method]).toHaveBeenCalledWith('hello');
        await expect(pending).resolves.toBeUndefined();
    });

    test('swallows a rejecting sink', async () => {
        mockByName[method].mockRejectedValueOnce(new Error('sink down'));
        await expect(invalid<IpcByName>(ipc)[helper]('x')).resolves.toBeUndefined();
    });

    test('swallows a sink that throws synchronously', async () => {
        window.api = invalid({
            [method]: () => {
                throw new Error('sync throw');
            },
        });
        await expect(invalid<IpcByName>(ipc)[helper]('x')).resolves.toBeUndefined();
    });

    test('tolerates a missing method or a missing bridge', async () => {
        window.api = invalid({});
        await expect(invalid<IpcByName>(ipc)[helper]('x')).resolves.toBeUndefined();
        window.api = invalid(undefined);
        await expect(invalid<IpcByName>(ipc)[helper]('x')).resolves.toBeUndefined();
    });
});

describe("the window controller's routes to the host", () => {
    const FENCE = { stopEpoch: 2, blocked: true, lastStop: { requestId: 'r', at: 1, durable: true }, lastArm: null };
    const failed = (error: string) => ({ success: false as const, error });

    describe('the priority Stop fence', () => {
        test('read answers the fence the host holds, and an unreadable one when the route fails', async () => {
            const port = ipc.createStopFencePort();
            mockApi.scenarioStopFence.mockResolvedValueOnce(
                invalid({ success: true, fence: { state: 'ok', fence: FENCE } }),
            );
            await expect(port.read()).resolves.toEqual({ state: 'ok', fence: FENCE });
            expect(mockApi.scenarioStopFence).toHaveBeenCalledWith();
            mockApi.scenarioStopFence.mockRejectedValueOnce(new Error('ipc down'));
            await expect(port.read()).resolves.toEqual({ state: 'unreadable', reason: 'read-failed' });
            mockApi.scenarioStopFence.mockResolvedValueOnce(invalid(failed('boom')));
            await expect(port.read()).resolves.toEqual({ state: 'unreadable', reason: 'read-failed' });
        });

        test('initialize asks the host to create a missing fence, and words a failure as the gate knows it', async () => {
            const port = ipc.createStopFencePort();
            mockApi.scenarioStopFence.mockResolvedValueOnce(
                invalid({ success: true, fence: { state: 'missing' }, created: true }),
            );
            await expect(port.initialize()).resolves.toEqual({ ok: true, created: true });
            expect(mockApi.scenarioStopFence).toHaveBeenLastCalledWith({ initialize: true });
            mockApi.scenarioStopFence.mockResolvedValueOnce(invalid({ success: true, fence: { state: 'missing' } }));
            await expect(port.initialize()).resolves.toEqual({ ok: true, created: false });
            mockApi.scenarioStopFence.mockResolvedValueOnce(invalid(failed('unreadable')));
            await expect(port.initialize()).resolves.toEqual({ ok: false, reason: 'unreadable' });
            mockApi.scenarioStopFence.mockResolvedValueOnce(invalid(failed('oversize')));
            await expect(port.initialize()).resolves.toEqual({ ok: false, reason: 'oversize' });
            mockApi.scenarioStopFence.mockRejectedValueOnce(new Error('ipc down'));
            await expect(port.initialize()).resolves.toEqual({ ok: false, reason: 'not-saved' });
        });

        test('recordFullStop records the Stop through its own route', async () => {
            const port = ipc.createStopFencePort();
            mockApi.recordFullStop.mockResolvedValueOnce(invalid({ success: true, epoch: 3 }));
            await expect(port.recordFullStop('req', 99)).resolves.toEqual({ ok: true, epoch: 3 });
            expect(mockApi.recordFullStop).toHaveBeenCalledWith('req', 99);
            mockApi.recordFullStop.mockResolvedValueOnce(invalid(failed('not-saved')));
            await expect(port.recordFullStop('req', 99)).resolves.toEqual({ ok: false, reason: 'not-saved' });
            mockApi.recordFullStop.mockResolvedValueOnce(invalid(failed('unreadable')));
            await expect(port.recordFullStop('req', 99)).resolves.toEqual({ ok: false, reason: 'unreadable' });
            mockApi.recordFullStop.mockRejectedValueOnce(new Error('ipc down'));
            await expect(port.recordFullStop('req', 99)).resolves.toEqual({ ok: false, reason: 'not-saved' });
        });

        test('clearStopBlock is the arm-autovote route and no other, with its refusals worded as the gate knows them', async () => {
            const port = ipc.createStopFencePort();
            mockApi.armAutovote.mockResolvedValueOnce(invalid({ success: true }));
            await expect(port.clearStopBlock(2)).resolves.toEqual({ ok: true });
            expect(mockApi.armAutovote).toHaveBeenCalledWith(2);
            mockApi.armAutovote.mockResolvedValueOnce(invalid(failed('stale-epoch')));
            await expect(port.clearStopBlock(2)).resolves.toEqual({ ok: false, reason: 'stale-epoch' });
            mockApi.armAutovote.mockResolvedValueOnce(invalid(failed('missing')));
            await expect(port.clearStopBlock(2)).resolves.toEqual({ ok: false, reason: 'missing' });
            mockApi.armAutovote.mockResolvedValueOnce(invalid(failed('unreadable')));
            await expect(port.clearStopBlock(2)).resolves.toEqual({ ok: false, reason: 'unreadable' });
            mockApi.armAutovote.mockRejectedValueOnce(new Error('ipc down'));
            await expect(port.clearStopBlock(2)).resolves.toEqual({ ok: false, reason: 'not-saved' });
        });

        test('nothing but clearStopBlock reaches arm-autovote', async () => {
            const port = ipc.createStopFencePort();
            mockApi.scenarioStopFence.mockResolvedValue(
                invalid({ success: true, fence: { state: 'missing' }, created: false, armAllowed: true }),
            );
            await port.read();
            await port.initialize();
            await port.isArmAllowed(2);
            await port.armIfAllowed(2, 1);
            await port.recordFullStop('r', 1);
            expect(mockApi.armAutovote).not.toHaveBeenCalled();
        });

        test('isArmAllowed asks the host about the epoch, and a failed route is not an allowance', async () => {
            const port = ipc.createStopFencePort();
            mockApi.scenarioStopFence.mockResolvedValueOnce(
                invalid({ success: true, fence: { state: 'missing' }, armAllowed: true }),
            );
            await expect(port.isArmAllowed(2)).resolves.toBe(true);
            expect(mockApi.scenarioStopFence).toHaveBeenLastCalledWith({ armEpoch: 2 });
            mockApi.scenarioStopFence.mockResolvedValueOnce(
                invalid({ success: true, fence: { state: 'missing' }, armAllowed: false }),
            );
            await expect(port.isArmAllowed(2)).resolves.toBe(false);
            mockApi.scenarioStopFence.mockResolvedValueOnce(invalid({ success: true, fence: { state: 'missing' } }));
            await expect(port.isArmAllowed(2)).resolves.toBe(false);
            mockApi.scenarioStopFence.mockRejectedValueOnce(new Error('ipc down'));
            await expect(port.isArmAllowed(2)).resolves.toBe(false);
        });

        test('armIfAllowed is the compare-and-set route, and its refusals keep their words', async () => {
            const port = ipc.createStopFencePort();
            mockApi.armIfAllowed.mockResolvedValueOnce(invalid({ success: true }));
            await expect(port.armIfAllowed(2, 5)).resolves.toEqual({ ok: true });
            expect(mockApi.armIfAllowed).toHaveBeenCalledWith(2);
            for (const reason of ['stale-epoch', 'blocked', 'missing'] as const) {
                mockApi.armIfAllowed.mockResolvedValueOnce(invalid(failed(reason)));
                await expect(port.armIfAllowed(2, 5)).resolves.toEqual({ ok: false, reason });
            }
            mockApi.armIfAllowed.mockResolvedValueOnce(invalid(failed('oversize')));
            await expect(port.armIfAllowed(2, 5)).resolves.toEqual({ ok: false, reason: 'oversize' });
            mockApi.armIfAllowed.mockRejectedValueOnce(new Error('ipc down'));
            await expect(port.armIfAllowed(2, 5)).resolves.toEqual({ ok: false, reason: 'not-saved' });
        });
    });

    describe('the installation publication, the wake sources and the armed cycle', () => {
        test("withdrawInstallationOnHost answers the host's outcome, and failed when it did not land", async () => {
            mockApi.withdrawInstallation.mockResolvedValueOnce(invalid({ success: true, outcome: 'withdrawn' }));
            await expect(ipc.withdrawInstallationOnHost(3)).resolves.toBe('withdrawn');
            expect(mockApi.withdrawInstallation).toHaveBeenCalledWith(3);
            mockApi.withdrawInstallation.mockResolvedValueOnce(invalid(failed('withdrawal-not-saved')));
            await expect(ipc.withdrawInstallationOnHost(3)).resolves.toBe('failed');
            mockApi.withdrawInstallation.mockRejectedValueOnce(new Error('ipc down'));
            await expect(ipc.withdrawInstallationOnHost(3)).resolves.toBe('failed');
        });

        test("rearmInstallationOnHost answers the host's outcome, and failed when it did not land", async () => {
            mockApi.rearmInstallation.mockResolvedValueOnce(invalid({ success: true, outcome: 'restored' }));
            await expect(ipc.rearmInstallationOnHost()).resolves.toBe('restored');
            mockApi.rearmInstallation.mockResolvedValueOnce(invalid(failed('restore-not-saved')));
            await expect(ipc.rearmInstallationOnHost()).resolves.toBe('failed');
            mockApi.rearmInstallation.mockRejectedValueOnce(new Error('ipc down'));
            await expect(ipc.rearmInstallationOnHost()).resolves.toBe('failed');
        });

        test('getAccountWakeFromHost gives the sources, or null when the host cannot', async () => {
            const wake = { installation: null, candidates: [], claimAt: null, missionExpiry: null };
            mockApi.getAccountWake.mockResolvedValueOnce(invalid({ success: true, wake }));
            await expect(ipc.getAccountWakeFromHost()).resolves.toEqual(wake);
            mockApi.getAccountWake.mockResolvedValueOnce(invalid(failed('no wake')));
            await expect(ipc.getAccountWakeFromHost()).resolves.toBeNull();
            mockApi.getAccountWake.mockRejectedValueOnce(new Error('ipc down'));
            await expect(ipc.getAccountWakeFromHost()).resolves.toBeNull();
        });

        test('runArmedCycle is the voting-cycle route in its armed mode', async () => {
            mockApi.runVotingCycle.mockResolvedValueOnce(invalid({ success: true }));
            await expect(ipc.runArmedCycle()).resolves.toEqual({ success: true });
            expect(mockApi.runVotingCycle).toHaveBeenCalledWith('armed');
        });
    });
});
