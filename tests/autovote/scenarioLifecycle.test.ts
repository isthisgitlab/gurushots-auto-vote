/**
 * The controller's execution modes and the priority full Stop, over the REAL Stop fence (settings/scenarioLifecycle.ts) on
 * the in-memory headless store: a Start or Resume request held at epoch E, a delayed timer and an old continuation never
 * arm or authorize work after a Stop; the fence is advanced to E+1 with `blocked`; only the user's own Run lifts it; a Stop the
 * store cannot save stays a local Stop and says so; the armed chain keeps one timer and runs no voting stage.
 */

jest.mock('../../src/ts/core/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        api: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        challengeTag: jest.fn((c: { id?: string | number } | null | undefined) => `[${c?.id}]`),
        withCategory: jest.fn(() => category),
    };
});

import settings = require('../../src/ts/core/settings');
import storageModule = require('../../src/ts/core/settings/storage');
import { createAutovoteController } from '../../src/ts/core/autovote/controller';
import type { createRunGate } from '../../src/ts/core/autovote/runGate';
import type { AutovoteHost } from '../../src/ts/core/autovote/controller';
import type { StopFencePort } from '../../src/ts/core/autovote/runGate';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import type { MemoryStore } from '../helpers/headlessStore';
import { invalid } from '../helpers/invalid';
import { isBoolean, isNumber, isShape, isString, nullable, parseJsonAs } from '../helpers/parseJson';

const FENCE_KEY = 'gs_scenario_stop_fence';
const STATE_KEY = 'gs_scenario_state';

type Fence = {
    stopEpoch: number;
    blocked: boolean;
    lastStop: { requestId: string } | null;
    lastArm: { epoch: number; at: number } | null;
};
const isFence = isShape<Fence>({
    stopEpoch: isNumber,
    blocked: isBoolean,
    lastStop: nullable(isShape<{ requestId: string }>({ requestId: isString })),
    lastArm: nullable(isShape<{ epoch: number; at: number }>({ epoch: isNumber, at: isNumber })),
});

let store: MemoryStore;

const fenceOnDisk = (): Fence => parseJsonAs(store.keys.get(FENCE_KEY) ?? '', isFence);

/** The real fence, as the controller's host reaches it. `hold.read` parks the next read until released. */
const hold: { read: Promise<void> | null } = { read: null };
const port: StopFencePort = {
    read: async () => {
        const parked = hold.read;
        hold.read = null;
        if (parked) await parked;
        return settings.readStopFence();
    },
    initialize: () => settings.initializeStopFence(),
    recordFullStop: (requestId, at) => settings.recordFullStop(requestId, at),
    clearStopBlock: (epoch) => settings.clearStopBlock(epoch),
    isArmAllowed: (epoch) => settings.isArmAllowed(epoch),
    armIfAllowed: (epoch, at) => settings.armIfAllowed(epoch, at),
};

const deferred = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
};

const MIN = 60_000;

const makeHost = (overrides: Partial<AutovoteHost> = {}): AutovoteHost => {
    const now = Math.floor(Date.now() / 1000);
    const far = invalid<Challenge[]>([{ id: 1, title: 'Far', type: 'regular', close_time: now + 100_000 }]);
    const host: AutovoteHost = {
        runVotingCycle: jest.fn(),
        runArmedCycle: jest.fn(),
        getSettings: jest.fn(),
        getSetting: jest.fn(),
        getEffectiveSetting: jest.fn(),
        getGlobalDefault: jest.fn(),
        getActiveChallenges: jest.fn(),
        getScenarioStatus: jest.fn(),
        setCancelVoting: jest.fn(),
        setSetting: jest.fn(),
        getEnvironmentInfo: jest.fn(),
        callOrNull: async (call) => {
            try {
                return await call();
            } catch {
                return null;
            }
        },
        logRendererDebug: jest.fn(),
        logRendererWarning: jest.fn(),
        logRendererError: jest.fn(),
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle),
        background: { start: jest.fn(), stop: jest.fn(), update: jest.fn(), status: jest.fn() },
        formatTime: (ms) => new Date(ms).toLocaleTimeString('en-GB'),
        translate: (key) => key,
        notifier: null,
        getOnChallengesRefresh: () => undefined,
        stopFence: port,
        withdrawInstallation: jest.fn(() => 'withdrawn' as const),
        reArmInstallation: jest.fn(() => 'restored' as const),
        ...overrides,
    };
    jest.mocked(host.getSettings).mockResolvedValue(
        invalid({ app: { checkFrequencyMin: 5, checkFrequencyMax: 5 }, hasToken: true }),
    );
    jest.mocked(host.getSetting).mockResolvedValue(null);
    jest.mocked(host.setSetting).mockResolvedValue(invalid(undefined));
    jest.mocked(host.getActiveChallenges).mockResolvedValue({ challenges: far });
    jest.mocked(host.getEffectiveSetting).mockImplementation((key) =>
        Promise.resolve(key === 'autoSubmitSchedule' ? [] : key === 'lastMinuteCheckFrequency' ? 1 : 10),
    );
    jest.mocked(host.runVotingCycle).mockResolvedValue(invalid({ success: true, challenges: far }));
    if (host.runArmedCycle)
        jest.mocked(host.runArmedCycle).mockResolvedValue(invalid({ success: true, challenges: far }));
    jest.mocked(host.background.start).mockResolvedValue(undefined);
    jest.mocked(host.background.stop).mockResolvedValue(undefined);
    jest.mocked(host.background.update).mockResolvedValue(undefined);
    jest.mocked(host.background.status).mockResolvedValue(invalid({ running: false, available: false }));
    jest.mocked(host.getEnvironmentInfo).mockResolvedValue(invalid({ launchedAt: Date.now() - 600_000 }));
    jest.mocked(host.getGlobalDefault).mockResolvedValue(60);
    return host;
};

let host: AutovoteHost;
let controller: ReturnType<typeof createAutovoteController>;

const settle = async (ms = 0) => {
    await jest.advanceTimersByTimeAsync(ms);
};

/** A controller over a host with a healthy fence, created and its epoch acknowledged (as a mount does). */
const mounted = async (overrides: Partial<AutovoteHost> = {}) => {
    host = makeHost(overrides);
    controller = createAutovoteController(host);
    await controller.maybeResume();
};

beforeEach(async () => {
    jest.useFakeTimers();
    store = installHeadlessStore();
    await storageModule.discardPendingWrites();
    storageModule.resumeWrites();
    hold.read = null;
    expect(await settings.initializeStopFence()).toEqual({ ok: true, created: true });
});

afterEach(async () => {
    controller?.dispose();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    removeHeadlessStore();
});

describe('priority full Stop against a held Start / Resume request', () => {
    test('a request held at epoch E, then a full Stop: nothing arms, the fence is at E+1 and blocked', async () => {
        await mounted();
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 0, blocked: false });
        const parked = deferred();
        hold.read = parked.promise;
        const held = controller.start();
        await settle();
        expect(controller.getState().executionMode).toBe('stopped');

        // The ordinary state cannot be read or written: a Stop does not depend on it.
        jest.mocked(host.getSetting).mockRejectedValue(new Error('unreadable'));
        jest.mocked(host.setSetting).mockRejectedValue(new Error('unwritable'));
        const stateBefore = store.keys.get(STATE_KEY);
        await controller.stop();

        expect(controller.getState().lastStop).toEqual({
            outcome: 'stopped',
            durable: true,
            epoch: 1,
            withdrawal: 'withdrawn',
        });
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 1, blocked: true });
        expect(jest.getTimerCount()).toBe(0);
        // Under the epoch the Stop will have: the one after the last acknowledged.
        expect(host.withdrawInstallation).toHaveBeenCalledWith(1);

        // The old request is delivered after the Stop.
        parked.release();
        await held;
        await settle(10 * MIN);
        expect(controller.getState()).toMatchObject({ executionMode: 'stopped', running: false });
        expect(controller.getState().startRefusal).toBe('superseded');
        expect(host.runVotingCycle).not.toHaveBeenCalled();
        expect(host.background.start).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
        // It did not lift the Stop it came before.
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 1, blocked: true });
        // Spend markers and the ordinary state were not touched by the Stop.
        expect(store.keys.get(STATE_KEY)).toBe(stateBefore);
    });

    test('a delayed timer of the old run authorizes no work, and a Stop recorded elsewhere ends the run', async () => {
        await mounted();
        const callbacks: Array<() => void> = [];
        const real = global.setTimeout;
        jest.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void, ms?: number) => {
            callbacks.push(cb);
            return real(cb, ms);
        }) as typeof setTimeout);
        await controller.start();
        expect(controller.getState().executionMode).toBe('voting');
        expect(jest.getTimerCount()).toBe(1);
        const cyclesBefore = jest.mocked(host.runVotingCycle).mock.calls.length;

        // Another executor's Stop: the fence moves under the armed timer.
        expect(await settings.recordFullStop('other-executor', 5)).toEqual({ ok: true, epoch: 1 });
        await settle(10 * MIN);
        expect(host.runVotingCycle).toHaveBeenCalledTimes(cyclesBefore);
        expect(controller.getState()).toMatchObject({ executionMode: 'stopped', running: false });
        expect(jest.getTimerCount()).toBe(0);
        expect(host.setCancelVoting).toHaveBeenLastCalledWith(true);

        // Delivering the old callback by hand changes nothing.
        for (const callback of callbacks) callback();
        await settle();
        expect(host.runVotingCycle).toHaveBeenCalledTimes(cyclesBefore);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a local Stop clears the timer at once; the old callback delivered afterwards does nothing', async () => {
        await mounted();
        const callbacks: Array<() => void> = [];
        const real = global.setTimeout;
        jest.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void, ms?: number) => {
            callbacks.push(cb);
            return real(cb, ms);
        }) as typeof setTimeout);
        await controller.start();
        const cyclesBefore = jest.mocked(host.runVotingCycle).mock.calls.length;
        await controller.stop();
        expect(jest.getTimerCount()).toBe(0);
        for (const callback of callbacks) callback();
        await settle(MIN);
        expect(host.runVotingCycle).toHaveBeenCalledTimes(cyclesBefore);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a fence that cannot be read arms nothing: a startup resume and the user Run are both refused', async () => {
        store.keys.set(FENCE_KEY, '{"nope":1}');
        host = makeHost();
        jest.mocked(host.getSetting).mockResolvedValue(true);
        controller = createAutovoteController(host);
        await controller.maybeResume();
        await settle(MIN);
        expect(controller.getState().executionMode).toBe('stopped');
        await controller.start();
        expect(controller.getState()).toMatchObject({ executionMode: 'stopped', startRefusal: 'fence-unreadable' });
        expect(host.runVotingCycle).not.toHaveBeenCalled();
        expect(store.keys.get(FENCE_KEY)).toBe('{"nope":1}');
    });

    test('a missing fence is created before work is admitted', async () => {
        store.keys.delete(FENCE_KEY);
        host = makeHost();
        controller = createAutovoteController(host);
        await controller.start();
        expect(controller.getState().executionMode).toBe('voting');
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 0, blocked: false });
    });
});

describe('who may lift a Stop', () => {
    test('a fresh user Run at the acknowledged epoch re-arms; a startup resume and a scenario request cannot', async () => {
        await mounted();
        await controller.start();
        const oldRequest = controller.captureRequest!();
        await controller.stop();
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 1, blocked: true });

        // A scenario request from before the Stop is obsolete; one made now is refused while the fence is blocked.
        expect(await controller.requestVotingStages!(true, oldRequest)).toEqual({ ok: false, reason: 'obsolete' });
        expect(await controller.requestVotingStages!(true, controller.captureRequest!())).toEqual({
            ok: false,
            reason: 'obsolete',
        });
        // The startup resume of the next launch is refused as well.
        jest.mocked(host.getSetting).mockResolvedValue(true);
        await controller.maybeResume();
        await settle(MIN);
        expect(controller.getState().executionMode).toBe('stopped');
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 1, blocked: true });

        // The user's own Run lifts it.
        await controller.start();
        expect(controller.getState()).toMatchObject({ executionMode: 'voting', running: true, stopEpoch: 1 });
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 1, blocked: false });
        expect(jest.getTimerCount()).toBe(1);
    });

    test('a Stop the user has not seen (another executor, after the last acknowledgment) is not lifted by one Run', async () => {
        await mounted();
        expect(await settings.recordFullStop('other', 9)).toEqual({ ok: true, epoch: 1 });
        await controller.start();
        expect(controller.getState()).toMatchObject({ executionMode: 'stopped', startRefusal: 'stop-epoch-moved' });
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 1, blocked: true });
        // Acknowledged now: the next Run is the user's.
        await controller.start();
        expect(controller.getState().executionMode).toBe('voting');
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 1, blocked: false });
    });

    test('a block the fence refuses to clear refuses the Run', async () => {
        await mounted();
        await controller.start();
        await controller.stop();
        const real = store.compareAndWriteKey!;
        store.compareAndWriteKey = () => false;
        await controller.start();
        expect(controller.getState()).toMatchObject({ executionMode: 'stopped', startRefusal: 'block-not-cleared' });
        store.compareAndWriteKey = real;
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 1, blocked: true });
    });
});

describe('a Stop the fence cannot save', () => {
    test('local cancellation holds, the result says it is not durable, and no re-arm until a later save succeeds', async () => {
        await mounted();
        await controller.start();
        const stateBefore = store.keys.get(STATE_KEY);
        const real = store.compareAndWriteKey!;
        store.compareAndWriteKey = () => false;

        await controller.stop();
        expect(controller.getState()).toMatchObject({
            executionMode: 'stopped',
            running: false,
            lastStop: { outcome: 'stopped-locally', durable: false, reason: 'not-saved', withdrawal: 'withdrawn' },
        });
        expect(jest.getTimerCount()).toBe(0);
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 0, blocked: false });
        expect(store.keys.get(STATE_KEY)).toBe(stateBefore);

        // The current process cannot re-arm while the Stop is unsaved.
        await controller.start();
        expect(controller.getState()).toMatchObject({ executionMode: 'stopped', startRefusal: 'stop-not-saved' });
        expect(jest.getTimerCount()).toBe(0);

        // A later save succeeds: the Stop is recorded first, then the user's Run lifts it.
        store.compareAndWriteKey = real;
        await controller.start();
        expect(controller.getState().executionMode).toBe('voting');
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 1, blocked: false });
    });

    test('a host without a fence stops locally and says so, and Run works as it always did', async () => {
        await mounted({ stopFence: null });
        await controller.start();
        expect(controller.getState().executionMode).toBe('voting');
        await controller.stop();
        expect(controller.getState().lastStop).toEqual({
            outcome: 'stopped-locally',
            durable: false,
            reason: 'no-fence',
            withdrawal: 'withdrawn',
        });
        await controller.start();
        expect(controller.getState().executionMode).toBe('voting');
    });

    test('a fence that throws is a Stop that is not saved', async () => {
        await mounted({ stopFence: { ...port, recordFullStop: () => Promise.reject(new Error('boom')) } });
        await controller.stop();
        expect(controller.getState().lastStop).toEqual({
            outcome: 'stopped-locally',
            durable: false,
            reason: 'not-saved',
            withdrawal: 'withdrawn',
        });
    });
});

describe('the final arming decision races a Stop in both orders', () => {
    test('the Stop first: the Run that was held reads the moved fence and arms nothing', async () => {
        await mounted();
        const parked = deferred();
        hold.read = parked.promise;
        const held = controller.start();
        await settle();
        await controller.stop();
        parked.release();
        await held;
        expect(controller.getState().executionMode).toBe('stopped');
        expect(host.runVotingCycle).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('the Run first, held at its setup: the Stop lands, and no continuation of the older epoch survives', async () => {
        await mounted();
        const parked = deferred();
        jest.mocked(host.background.start).mockImplementation(() => parked.promise);
        const held = controller.start();
        await settle();
        expect(controller.getState().executionMode).toBe('voting');
        await controller.stop();
        expect(controller.getState().executionMode).toBe('stopped');
        parked.release();
        await held;
        await settle(10 * MIN);
        expect(host.runVotingCycle).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
        expect(controller.getState().executionMode).toBe('stopped');
    });

    test('the Stop lands while the first cycle runs: its result is not handed to the chain', async () => {
        await mounted();
        const parked = deferred();
        jest.mocked(host.runVotingCycle).mockImplementation(() =>
            parked.promise.then(() => invalid({ success: true })),
        );
        const held = controller.start();
        await settle();
        await controller.stop();
        parked.release();
        await held;
        await settle(10 * MIN);
        expect(jest.getTimerCount()).toBe(0);
    });
});

describe('the armed chain', () => {
    test('arming keeps exactly one timer and runs no voting stage; Resume voting is the same chain', async () => {
        await mounted();
        await controller.arm!();
        expect(controller.getState()).toMatchObject({ executionMode: 'armed', running: false });
        expect(host.runArmedCycle).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(1);

        await settle(30 * MIN);
        expect(jest.mocked(host.runArmedCycle!).mock.calls.length).toBeGreaterThan(1);
        expect(host.runVotingCycle).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(1);

        // A scenario's startAutovote: armed -> voting under the chain that is there.
        const request = controller.captureRequest!();
        expect(await controller.requestVotingStages!(true, request)).toEqual({
            ok: true,
            mode: 'voting',
            changed: true,
        });
        expect(controller.getState()).toMatchObject({ executionMode: 'voting', running: true });
        expect(jest.getTimerCount()).toBe(1);
        const armedCalls = jest.mocked(host.runArmedCycle!).mock.calls.length;
        await settle(30 * MIN);
        expect(host.runVotingCycle).toHaveBeenCalled();
        expect(jest.mocked(host.runArmedCycle!).mock.calls.length).toBe(armedCalls);
        expect(jest.getTimerCount()).toBe(1);
        // Already voting: nothing changes.
        expect(await controller.requestVotingStages!(true, request)).toEqual({
            ok: true,
            mode: 'voting',
            changed: false,
        });

        // stopAutovote: voting -> armed, not a full Stop.
        expect(await controller.requestVotingStages!(false, request)).toEqual({
            ok: true,
            mode: 'armed',
            changed: true,
        });
        expect(controller.getState()).toMatchObject({ executionMode: 'armed', running: false, lastStop: null });
        expect(jest.getTimerCount()).toBe(1);
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 0, blocked: false });

        // Full Stop ends the armed chain.
        await controller.stop();
        expect(controller.getState().executionMode).toBe('stopped');
        expect(jest.getTimerCount()).toBe(0);
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 1, blocked: true });
    });

    test('the user Run while armed is Resume voting: no second chain', async () => {
        await mounted();
        await controller.arm!();
        await controller.start();
        expect(controller.getState()).toMatchObject({ executionMode: 'voting', running: true });
        expect(jest.getTimerCount()).toBe(1);
        // Run while voting changes nothing.
        await controller.start();
        expect(jest.getTimerCount()).toBe(1);
    });

    test('a scenario request cannot act on a stopped controller, and a host without an armed cycle cannot be armed', async () => {
        await mounted();
        expect(await controller.requestVotingStages!(true, controller.captureRequest!())).toEqual({
            ok: false,
            reason: 'not-armed',
        });
        await controller.start();
        const request = controller.captureRequest!();
        controller.dispose();

        await mounted({ runArmedCycle: null });
        await controller.arm!();
        expect(controller.getState()).toMatchObject({ executionMode: 'stopped', startRefusal: 'no-armed-cycle' });
        await controller.start();
        expect(await controller.requestVotingStages!(false, controller.captureRequest!())).toEqual({
            ok: false,
            reason: 'unsupported',
        });
        expect(request.generation).toBe(0);
    });

    test('an armed controller is not armed twice, and a Stop during the arm leaves nothing armed', async () => {
        await mounted();
        const parked = deferred();
        hold.read = parked.promise;
        const held = controller.arm!();
        await settle();
        await controller.stop();
        parked.release();
        await held;
        expect(controller.getState().executionMode).toBe('stopped');
        expect(jest.getTimerCount()).toBe(0);
        await controller.start();
        await controller.arm!();
        expect(controller.getState().executionMode).toBe('voting');
    });
});

describe('the run gate over a fence the test controls', () => {
    const { createRunGate } = jest.requireActual<typeof import('../../src/ts/core/autovote/runGate')>(
        '../../src/ts/core/autovote/runGate',
    );
    type FenceRead = Awaited<ReturnType<StopFencePort['read']>>;
    const ok = (stopEpoch: number, blocked = false): FenceRead => ({
        state: 'ok',
        fence: { stopEpoch, blocked, lastStop: null, lastArm: null },
    });
    const fake = (read: () => FenceRead | Promise<FenceRead>, rest: Partial<StopFencePort> = {}): StopFencePort => ({
        read,
        initialize: async () => ({ ok: true, created: true }),
        recordFullStop: async () => ({ ok: true, epoch: 1 }),
        clearStopBlock: async () => ({ ok: true }),
        isArmAllowed: () => true,
        armIfAllowed: async () => ({ ok: true }),
        ...rest,
    });

    test('without a fence: Run is local, a startup request is refused only after a Stop, and nothing is read', async () => {
        const gate = createRunGate(null);
        expect(gate.fenced).toBe(false);
        expect(await gate.captureFresh()).toEqual({ epoch: null, generation: 0 });
        expect(await gate.admitUser(gate.capture())).toMatchObject({ ok: true });
        expect(await gate.admits(gate.capture())).toBe(true);
        expect(await gate.admitUnattended(gate.capture())).toMatchObject({ ok: true });
        expect(gate.admitLocal('startup', gate.capture())).toMatchObject({ ok: true });
        const before = gate.capture();
        gate.latch();
        expect(gate.current(before)).toBe(false);
        expect(gate.admitLocal('user', before)).toEqual({ ok: false, reason: 'superseded' });
        expect(gate.admitLocal('startup', gate.capture())).toEqual({ ok: false, reason: 'superseded' });
        expect(await gate.admitUnattended(gate.capture())).toEqual({ ok: false, reason: 'superseded' });
        expect(gate.admitLocal('user', gate.capture())).toMatchObject({ ok: true });
        expect(await gate.persistStop('s', 1)).toEqual({
            outcome: 'stopped-locally',
            durable: false,
            reason: 'no-fence',
        });
    });

    test('a request with no known epoch is not admitted against a fence; a fence that cannot be created reads as unreadable', async () => {
        const gate = createRunGate(fake(() => ok(0)));
        expect(await gate.admits(gate.capture())).toBe(false);
        expect(await gate.captureFresh()).toEqual({ epoch: 0, generation: 0 });
        expect(await gate.admits(gate.capture())).toBe(true);

        const unmade = createRunGate(
            fake(() => ({ state: 'missing' }), { initialize: async () => ({ ok: false, reason: 'not-saved' }) }),
        );
        expect(await unmade.captureFresh()).toBeNull();
        expect(await unmade.admitUser(unmade.capture())).toEqual({ ok: false, reason: 'fence-unreadable' });

        // Created, then read as still missing: unreadable, never epoch 0.
        const never = createRunGate(fake(() => ({ state: 'missing' })));
        expect(await never.captureFresh()).toBeNull();
    });

    test('a request that a Stop overtook while the fence was read never lifts the block', async () => {
        let release!: () => void;
        const parked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const clear = jest.fn(async () => ({ ok: true as const }));
        const gate = createRunGate(
            fake(
                async () => {
                    await parked;
                    return ok(3, true);
                },
                { clearStopBlock: clear },
            ),
        );
        const request = gate.capture();
        const admitted = gate.admitUser(request);
        gate.latch();
        release();
        expect(await admitted).toEqual({ ok: false, reason: 'superseded' });
        expect(clear).not.toHaveBeenCalled();
    });

    test('a Stop that lands between the clear and the arm still wins', async () => {
        const gate = createRunGate(fake(() => ok(3, true)));
        const request = gate.capture();
        const port = { ...fake(() => ok(3, true)) };
        const racing = createRunGate({
            ...port,
            clearStopBlock: async () => {
                racing.latch();
                return { ok: true };
            },
        });
        expect(await racing.admitUser(racing.capture())).toEqual({ ok: false, reason: 'superseded' });
        expect(gate.current(request)).toBe(true);
    });
});

describe('a Stop at every await of a mode change leaves nothing behind', () => {
    const armedController = async () => {
        await mounted();
        await controller.arm!();
        expect(controller.getState().executionMode).toBe('armed');
    };

    test.each([
        ['the launch marker', 'autovoteStartedLaunch'],
        ['the running flag', 'autovoteRunning'],
    ])('turning the voting stages on, held at %s', async (_label, key) => {
        await armedController();
        const parked = deferred();
        let held1 = false;
        jest.mocked(host.setSetting).mockImplementation(async (k) => {
            // Only the first write of the key is held: the Stop's own write of the flag must not wait on it.
            if (k === key && !held1) {
                held1 = true;
                await parked.promise;
            }
            return invalid(undefined);
        });
        const request = controller.captureRequest!();
        const held = controller.requestVotingStages!(true, request);
        await settle();
        await controller.stop();
        parked.release();
        expect(await held).toEqual({ ok: false, reason: 'obsolete' });
        expect(jest.getTimerCount()).toBe(0);
        expect(host.runVotingCycle).not.toHaveBeenCalled();
    });

    test('turning the voting stages on, held at the background start', async () => {
        await armedController();
        const parked = deferred();
        jest.mocked(host.background.start).mockImplementation(() => parked.promise as Promise<undefined>);
        const held = controller.requestVotingStages!(true, controller.captureRequest!());
        await settle();
        await controller.stop();
        parked.release();
        expect(await held).toEqual({ ok: false, reason: 'obsolete' });
        expect(jest.getTimerCount()).toBe(0);
    });

    test('the user Run while armed, refused: the refusal is shown and the chain stays armed', async () => {
        await armedController();
        const real = store.compareAndWriteKey!;
        // Another executor's Stop the user has not seen.
        expect(await settings.recordFullStop('other', 3)).toEqual({ ok: true, epoch: 1 });
        await controller.start();
        expect(controller.getState()).toMatchObject({ executionMode: 'armed', startRefusal: 'stop-epoch-moved' });
        store.compareAndWriteKey = real;
    });

    test('a startup resume while armed does nothing', async () => {
        await armedController();
        jest.mocked(host.getSetting).mockResolvedValue(true);
        await controller.maybeResume();
        await settle(MIN);
        expect(controller.getState().executionMode).toBe('armed');
        expect(host.runVotingCycle).not.toHaveBeenCalled();
    });

    test.each([
        ['the running flag', 'persist'],
        ['the background stop', 'background'],
    ])('turning the voting stages off, held at %s', async (_label, where) => {
        await mounted();
        await controller.start();
        const parked = deferred();
        let heldOnce = false;
        if (where === 'persist') {
            jest.mocked(host.setSetting).mockImplementation(async (k) => {
                if (k === 'autovoteRunning' && !heldOnce) {
                    heldOnce = true;
                    await parked.promise;
                }
                return invalid(undefined);
            });
        } else {
            jest.mocked(host.background.stop).mockImplementation(() => {
                if (heldOnce) return Promise.resolve(undefined);
                heldOnce = true;
                return parked.promise as Promise<undefined>;
            });
        }
        const held = controller.requestVotingStages!(false, controller.captureRequest!());
        await settle();
        expect(controller.getState().executionMode).toBe('armed');
        await controller.stop();
        parked.release();
        expect(await held).toEqual({ ok: false, reason: 'obsolete' });
        expect(jest.getTimerCount()).toBe(0);
    });

    test('two Runs at once make one run, and an arm racing a Run leaves one chain', async () => {
        await mounted();
        await Promise.all([controller.start(), controller.start()]);
        expect(jest.getTimerCount()).toBe(1);
        expect(host.runVotingCycle).toHaveBeenCalledTimes(1);
        await controller.stop();

        await mounted();
        await Promise.all([controller.arm!(), controller.start()]);
        expect(jest.getTimerCount()).toBe(1);
    });

    test('a withdrawal that rejects with nothing to say is still logged', async () => {
        await mounted({ withdrawInstallation: jest.fn(() => Promise.reject(undefined)) });
        await controller.stop();
        expect(host.logRendererWarning).toHaveBeenCalledWith(expect.stringContaining('could not be withdrawn'));
    });

    test('a native service found running at launch, while armed, is not started a second time', async () => {
        await armedController();
        jest.mocked(host.getSetting).mockResolvedValue(true);
        jest.mocked(host.background.status).mockResolvedValue(invalid({ running: true, available: true }));
        await controller.maybeResume();
        await settle(MIN);
        expect(controller.getState().executionMode).toBe('armed');
        expect(jest.getTimerCount()).toBe(1);
    });

    test('a withdrawal that fails is logged and the Stop still lands', async () => {
        await mounted({ withdrawInstallation: jest.fn(() => Promise.reject(new Error('no route'))) });
        await controller.start();
        await controller.stop();
        expect(host.logRendererWarning).toHaveBeenCalledWith(expect.stringContaining('no route'));
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 1, blocked: true });
        // The failure is reported in the result; the local cancellation and the fence stand.
        expect(controller.getState().lastStop).toMatchObject({
            outcome: 'stopped',
            durable: true,
            withdrawal: 'failed',
        });
        expect(controller.getState().executionMode).toBe('stopped');
    });

    test('a withdrawal the host reports failed, or has no route for, is said in the Stop result', async () => {
        await mounted({ withdrawInstallation: jest.fn(() => 'failed' as const) });
        await controller.stop();
        expect(controller.getState().lastStop).toMatchObject({ outcome: 'stopped', withdrawal: 'failed' });
        controller.dispose();
        await mounted({ withdrawInstallation: jest.fn(async () => 'none' as const) });
        await controller.stop();
        expect(controller.getState().lastStop).toMatchObject({ withdrawal: 'none' });
    });

    test('a Stop with no withdrawal route and nothing running only fences', async () => {
        await mounted({ withdrawInstallation: null });
        await controller.stop();
        expect(controller.getState()).toMatchObject({
            executionMode: 'stopped',
            lastStop: { outcome: 'stopped', epoch: 1, withdrawal: 'no-route' },
        });
        expect(host.setCancelVoting).not.toHaveBeenCalled();
        expect(host.background.stop).not.toHaveBeenCalled();
    });

    test('a Stop cancels a pending startup hold and the session it would have resumed', async () => {
        host = makeHost();
        jest.mocked(host.getSetting).mockResolvedValue(true);
        jest.mocked(host.getEnvironmentInfo).mockResolvedValue(invalid({ launchedAt: Date.now() - 1000 }));
        jest.mocked(host.getGlobalDefault).mockResolvedValue(60);
        controller = createAutovoteController(host);
        await controller.maybeResume();
        expect(controller.getState().pendingStartAt).not.toBeNull();
        await controller.stop();
        expect(controller.getState().pendingStartAt).toBeNull();
        expect(host.setSetting).toHaveBeenCalledWith('autovoteRunning', false);
        await settle(2 * MIN);
        expect(host.runVotingCycle).not.toHaveBeenCalled();
    });

    test('a startup resume held across a Stop never starts; one that the fence allows does', async () => {
        host = makeHost();
        jest.mocked(host.getSetting).mockResolvedValue(true);
        jest.mocked(host.getEnvironmentInfo).mockResolvedValue(invalid({ launchedAt: Date.now() - 1000 }));
        jest.mocked(host.getGlobalDefault).mockResolvedValue(5);
        controller = createAutovoteController(host);
        await controller.maybeResume();
        expect(controller.getState().pendingStartAt).not.toBeNull();
        expect(await settings.recordFullStop('other', 3)).toEqual({ ok: true, epoch: 1 });
        await settle(10_000);
        expect(controller.getState()).toMatchObject({ executionMode: 'stopped', startRefusal: 'superseded' });
        expect(host.runVotingCycle).not.toHaveBeenCalled();

        controller.dispose();
        host = makeHost();
        jest.mocked(host.getSetting).mockResolvedValue(true);
        jest.mocked(host.getEnvironmentInfo).mockResolvedValue(invalid({ launchedAt: Date.now() - 600_000 }));
        controller = createAutovoteController(host);
        // Blocked by the Stop above: refused at once, and the block stays.
        await controller.maybeResume();
        expect(controller.getState().executionMode).toBe('stopped');
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 1, blocked: true });
        await controller.start();
        expect(controller.getState().executionMode).toBe('voting');
    });

    test('an armed controller reads no active challenge', async () => {
        await armedController();
        await settle(30 * MIN);
        expect(host.getActiveChallenges).not.toHaveBeenCalled();
    });
});

describe('the remaining refusals', () => {
    const { createRunGate } = jest.requireActual<typeof import('../../src/ts/core/autovote/runGate')>(
        '../../src/ts/core/autovote/runGate',
    );

    test('a Run captured before a Stop is superseded at once, without reading the fence', async () => {
        const read = jest.fn(() => settings.readStopFence());
        const gate = createRunGate({ ...port, read });
        const request = gate.capture();
        gate.latch();
        expect(await gate.admitUser(request)).toEqual({ ok: false, reason: 'superseded' });
        expect(read).not.toHaveBeenCalled();
    });

    test('a host with no fence: Run while armed is Resume voting', async () => {
        await mounted({ stopFence: null });
        await controller.arm!();
        expect(controller.getState().executionMode).toBe('armed');
        await controller.start();
        expect(controller.getState()).toMatchObject({ executionMode: 'voting', running: true });
        expect(jest.getTimerCount()).toBe(1);
    });

    test('an arm a Stop elsewhere overtook is refused, and shows why', async () => {
        await mounted();
        expect(await settings.recordFullStop('other', 3)).toEqual({ ok: true, epoch: 1 });
        await controller.arm!();
        expect(controller.getState()).toMatchObject({ executionMode: 'stopped', startRefusal: 'stop-epoch-moved' });
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a Run and an arm at once: the first made the chain, the second leaves it as it is', async () => {
        await mounted();
        await Promise.all([controller.start(), controller.arm!()]);
        expect(controller.getState().executionMode).toBe('voting');
        expect(jest.getTimerCount()).toBe(1);
        expect(host.runArmedCycle).not.toHaveBeenCalled();
    });
});

describe('an explicit re-arm lifts the withdrawal, before the next publication', () => {
    test('the user’s Run and arm lift it before the first cycle runs; a startup resume does not', async () => {
        const order: string[] = [];
        await mounted({ reArmInstallation: jest.fn(() => (order.push('lift'), 'restored' as const)) });
        jest.mocked(host.runVotingCycle).mockImplementation(
            async () => (order.push('cycle'), invalid({ success: true })),
        );
        jest.mocked(host.runArmedCycle!).mockImplementation(
            async () => (order.push('armed'), invalid({ success: true })),
        );
        await controller.start();
        expect(order.slice(0, 2)).toEqual(['lift', 'cycle']);
        await controller.stop();
        order.length = 0;
        await controller.arm!();
        expect(order.slice(0, 2)).toEqual(['lift', 'armed']);
        await controller.stop();
    });

    test('a startup resume never lifts it', async () => {
        const reArm = jest.fn(() => 'restored' as const);
        await mounted({ reArmInstallation: reArm });
        jest.mocked(host.getSetting).mockResolvedValue(true);
        await controller.maybeResume();
        await settle(MIN);
        expect(controller.getState().executionMode).toBe('voting');
        expect(reArm).not.toHaveBeenCalled();
    });

    test('a lift that fails or throws is said, and the run goes on (the installation publishes nothing until the next re-arm)', async () => {
        await mounted({ reArmInstallation: jest.fn(() => 'failed' as const) });
        await controller.start();
        expect(host.logRendererWarning).toHaveBeenCalledWith(expect.stringContaining('its withdrawal still stands'));
        expect(controller.getState().executionMode).toBe('voting');
        await controller.stop();
        controller.dispose();
        await mounted({ reArmInstallation: jest.fn(() => Promise.reject(new Error('no route'))) });
        await controller.arm!();
        expect(host.logRendererWarning).toHaveBeenCalledWith(expect.stringContaining('no route'));
        expect(controller.getState().executionMode).toBe('armed');
        controller.dispose();
        await mounted({ reArmInstallation: jest.fn(() => Promise.reject(undefined)) });
        await controller.start();
        expect(host.logRendererWarning).toHaveBeenCalledWith(expect.stringContaining('could not be re-armed'));
    });

    test('a host with no route to lift it has nothing to lift', async () => {
        await mounted({ reArmInstallation: null });
        await controller.start();
        expect(controller.getState().executionMode).toBe('voting');
    });

    test('a Stop that lands while it is lifted leaves nothing running', async () => {
        const parked = deferred();
        await mounted({ reArmInstallation: jest.fn(async () => (await parked.promise, 'restored' as const)) });
        const held = controller.start();
        await settle();
        await controller.stop();
        parked.release();
        await held;
        expect(host.runVotingCycle).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);

        controller.dispose();
        const parkedArm = deferred();
        await mounted({ reArmInstallation: jest.fn(async () => (await parkedArm.promise, 'restored' as const)) });
        const heldArm = controller.arm!();
        await settle();
        await controller.stop();
        parkedArm.release();
        await heldArm;
        expect(host.runArmedCycle).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });
});

describe('the final arming decision is the fence’s compare-and-set', () => {
    test('a Run records the arming at the epoch it was admitted at', async () => {
        await mounted();
        await controller.start();
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 0, blocked: false, lastArm: { epoch: 0 } });
    });

    test('a Stop that lands between the Run’s read and its arming refuses the Run, and nothing arms', async () => {
        const armIfAllowed = jest.fn(async (epoch: number, at: number) => {
            // The Stop of another executor lands first.
            expect(await settings.recordFullStop('other', 1)).toEqual({ ok: true, epoch: 1 });
            return settings.armIfAllowed(epoch, at);
        });
        await mounted({ stopFence: { ...port, armIfAllowed } });
        await controller.start();
        expect(controller.getState()).toMatchObject({ executionMode: 'stopped', startRefusal: 'arm-refused' });
        expect(jest.getTimerCount()).toBe(0);
        expect(host.runVotingCycle).not.toHaveBeenCalled();
        expect(fenceOnDisk()).toMatchObject({ stopEpoch: 1, blocked: true, lastArm: null });
    });

    test('a Stop that lands after the arming wins: the older epoch’s run is cancelled and cannot arm again', async () => {
        await mounted();
        await controller.start();
        expect(await settings.recordFullStop('other', 3)).toEqual({ ok: true, epoch: 1 });
        await settle(10 * MIN);
        expect(controller.getState().executionMode).toBe('stopped');
        expect(await settings.armIfAllowed(0, 4)).toEqual({ ok: false, reason: 'blocked' });
    });

    test('a startup resume and a scenario request to turn the voting stages on arm only through it', async () => {
        const armIfAllowed = jest.fn((epoch: number, at: number) => settings.armIfAllowed(epoch, at));
        await mounted({ stopFence: { ...port, armIfAllowed } });
        await controller.arm!();
        armIfAllowed.mockClear();
        expect(await controller.requestVotingStages!(true, controller.captureRequest!())).toMatchObject({
            ok: true,
            mode: 'voting',
        });
        expect(armIfAllowed).toHaveBeenCalledTimes(1);
        // Turning them off, or no change, only reads the fence.
        armIfAllowed.mockClear();
        await controller.requestVotingStages!(false, controller.captureRequest!());
        expect(armIfAllowed).not.toHaveBeenCalled();
        await controller.stop();
        controller.dispose();

        await mounted({ stopFence: { ...port, armIfAllowed } });
        await controller.arm!();
        armIfAllowed.mockResolvedValueOnce({ ok: false, reason: 'blocked' });
        expect(await controller.requestVotingStages!(true, controller.captureRequest!())).toEqual({
            ok: false,
            reason: 'obsolete',
        });
    });

    test('a startup resume the CAS refuses starts nothing', async () => {
        host = makeHost({ stopFence: { ...port, armIfAllowed: async () => ({ ok: false, reason: 'blocked' }) } });
        jest.mocked(host.getSetting).mockResolvedValue(true);
        controller = createAutovoteController(host);
        await controller.maybeResume();
        await settle(MIN);
        expect(controller.getState()).toMatchObject({ executionMode: 'stopped', startRefusal: 'superseded' });
        expect(host.runVotingCycle).not.toHaveBeenCalled();
    });

    test('the gate: a request with no epoch, or one a Stop overtook, is not armed; without a fence it is', async () => {
        const { createRunGate } = jest.requireActual<typeof import('../../src/ts/core/autovote/runGate')>(
            '../../src/ts/core/autovote/runGate',
        );
        const unfenced = createRunGate(null);
        expect(await unfenced.armsAt(unfenced.capture())).toBe(true);
        const fenced = createRunGate(port);
        expect(await fenced.armsAt(fenced.capture())).toBe(false);
        const fresh = await fenced.captureFresh();
        expect(await fenced.armsAt(fresh!)).toBe(true);
        fenced.latch();
        expect(await fenced.armsAt(fresh!)).toBe(false);
        // A Stop that lands while the CAS is made.
        const racing = createRunGate({
            ...port,
            armIfAllowed: async (epoch, at) => {
                racing.latch();
                return settings.armIfAllowed(epoch, at);
            },
        });
        const request = await racing.captureFresh();
        expect(await racing.armsAt(request!)).toBe(false);
        const request2 = await createRunGate({ ...port, armIfAllowed: port.armIfAllowed }).captureFresh();
        expect(request2).toEqual({ epoch: 0, generation: 0 });
    });

    test('an arming the CAS lets through but a Stop overtook while it was made arms nothing', async () => {
        let gate!: ReturnType<typeof createRunGate>;
        const { createRunGate: make } = jest.requireActual<typeof import('../../src/ts/core/autovote/runGate')>(
            '../../src/ts/core/autovote/runGate',
        );
        gate = make({
            ...port,
            armIfAllowed: async (epoch, at) => {
                const allowed = await settings.armIfAllowed(epoch, at);
                gate.latch();
                return allowed;
            },
        });
        const request = gate.capture();
        expect(await gate.admitUser(request)).toEqual({ ok: false, reason: 'superseded' });
    });
});
