/**
 * Verifies the single-timer scheduler.
 *
 * Normal mode keeps the start-anchored spacing: the gap between cycle starts
 * should be ~delayMs regardless of how long any single cycle takes, and an
 * overrunning cycle should pause MIN_CYCLE_GAP_MS before firing again.
 *
 * In threshold mode the next delay is decided each cycle by
 * computeNextCycleDelayMs, so the chain caps to an
 * upcoming boundary (approaching), holds a fixed fast cadence while in-window
 * (last-minute), and reverts to the random cadence once the window clears.
 */

jest.mock('../../src/ts/core/settings', () => {
    const loadSettings = jest.fn();
    let cell: { stopEpoch: number; blocked: boolean; lastStop: null } | null = null;
    return {
        // The priority Stop fence over an in-memory cell, as the settings facade answers it (the fence itself is tested in
        // tests/settings/scenario-lifecycle.test.ts).
        readStopFence: jest.fn(() => (cell ? { state: 'ok', fence: cell } : { state: 'missing' })),
        initializeStopFence: jest.fn(async () => {
            const created = cell === null;
            cell ??= { stopEpoch: 0, blocked: false, lastStop: null };
            return { ok: true, created };
        }),
        recordFullStop: jest.fn(async () => {
            cell = { stopEpoch: (cell?.stopEpoch ?? 0) + 1, blocked: true, lastStop: null };
            return { ok: true, epoch: cell.stopEpoch };
        }),
        clearStopBlock: jest.fn(async (expected: number) => {
            if (!cell || cell.stopEpoch !== expected) return { ok: false, reason: 'stale-epoch' };
            cell = { ...cell, blocked: false };
            return { ok: true };
        }),
        isArmAllowed: jest.fn((epoch: number) => cell !== null && !cell.blocked && cell.stopEpoch === epoch),
        armIfAllowed: jest.fn(async (epoch: number) => {
            if (!cell) return { ok: false, reason: 'missing' };
            if (cell.blocked) return { ok: false, reason: 'blocked' };
            return cell.stopEpoch === epoch ? { ok: true } : { ok: false, reason: 'stale-epoch' };
        }),
        withdrawInstallationPublication: jest.fn(() => ({ ok: true, changed: false })),
        restoreInstallationPublication: jest.fn(() => ({ ok: true, changed: false })),
        __resetFence: () => {
            cell = null;
        },
        getPhaseSchedules: jest.fn(() => ({ kind: 'none' })),
        scenarioSubjectAvailable: jest.fn(() => true),
        scenarioSubjectReason: jest.fn(() => null),
        loadSettings,
        // The cadence settings of a decision are captured through the installation read: with no installation scenario the
        // saved app block the test gives `loadSettings`.
        captureInstallationSettings: jest.fn((keys: string[]) => {
            const app: Record<string, unknown> = (loadSettings() as { app?: Record<string, unknown> })?.app ?? {};
            return { ok: true, values: Object.fromEntries(keys.map((key) => [key, app[key]])) };
        }),
        getSetting: jest.fn(),
        getEffectiveSetting: jest.fn(),
        consumeChosenPhotos: jest.fn(() => false),
    };
});

import { invalid } from '../helpers/invalid';

import settingsModule = require('../../src/ts/core/settings');
import loggerModule = require('../../src/ts/core/logger');
const settings = jest.mocked(settingsModule);
import type * as runSchedulerModule from '../../src/ts/shells/cli/runScheduler';
import type * as randomDelayModule from '../../src/ts/core/scheduling/randomDelay';
const { createScheduler } = require('../../src/ts/shells/cli/runScheduler') as typeof runSchedulerModule;
type SchedulerDeps = Parameters<typeof createScheduler>[0];
const { MIN_CYCLE_GAP_MS, MS_PER_MINUTE } =
    require('../../src/ts/core/scheduling/randomDelay') as typeof randomDelayModule;

const FIXED_DELAY_MIN = 3;
const FIXED_DELAY_MS = FIXED_DELAY_MIN * MS_PER_MINUTE;

// Drain any chained .then() callbacks queued by start() / runVotingCycle
// without advancing fake timer time. Jest's modern fake timers also fake
// setImmediate, so we cannot rely on it here — chain Promise.resolve()
// enough times to clear typical await chains.
const flushMicrotasks = async () => {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
};

describe('createScheduler — normal-mode cycle spacing', () => {
    let runVotingCycle: jest.MockedFunction<SchedulerDeps['runVotingCycle']>;
    let getActiveChallenges: jest.MockedFunction<SchedulerDeps['getActiveChallenges']>;
    let scheduler: ReturnType<typeof createScheduler> | null;

    beforeEach(() => {
        jest.useFakeTimers();
        settings.loadSettings.mockReturnValue(
            invalid({ app: { checkFrequencyMin: FIXED_DELAY_MIN, checkFrequencyMax: FIXED_DELAY_MIN } }),
        );
        settings.getSetting.mockReturnValue(FIXED_DELAY_MIN);
        settings.getEffectiveSetting.mockReturnValue(1);
        getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [] });
    });

    afterEach(() => {
        if (scheduler) scheduler.stop();
        scheduler = null;
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    test('fast cycle: second cycle starts ~delayMs after first cycle starts', async () => {
        const cycleStarts: number[] = [];
        runVotingCycle = jest.fn().mockImplementation(async () => {
            cycleStarts.push(Date.now());
            return true;
        });
        scheduler = createScheduler({ runVotingCycle, getActiveChallenges });

        const startPromise = scheduler.start();
        await flushMicrotasks();
        await startPromise;

        expect(cycleStarts).toHaveLength(1);

        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS);
        await flushMicrotasks();

        expect(cycleStarts).toHaveLength(2);
        const gap = cycleStarts[1] - cycleStarts[0];
        expect(gap).toBe(FIXED_DELAY_MS);
    });

    test('slow cycle within budget: gap measured from start equals delayMs', async () => {
        const SLOW_MS = 90_000; // 90 s, well under the 3-min budget
        const cycleStarts: number[] = [];
        runVotingCycle = jest.fn().mockImplementation(async () => {
            cycleStarts.push(Date.now());
            await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
            return true;
        });
        scheduler = createScheduler({ runVotingCycle, getActiveChallenges });

        const startPromise = scheduler.start();
        // Let the mock push cycleStarts[0] synchronously, then complete its
        // internal 90 s await so start() can resolve.
        await flushMicrotasks();
        await jest.advanceTimersByTimeAsync(SLOW_MS);
        await flushMicrotasks();
        await startPromise;

        expect(cycleStarts).toHaveLength(1);

        // After cycle #1 ended at t=90s, scheduler should sleep for
        // (3min - 90s) = 90s so the second cycle starts at t=180s.
        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS - SLOW_MS);
        await flushMicrotasks();

        expect(cycleStarts).toHaveLength(2);
        const gap = cycleStarts[1] - cycleStarts[0];
        expect(gap).toBe(FIXED_DELAY_MS);
    });

    // Deliberately no separate forward-wall-clock-jump test: a forward jump
    // during a cycle drives remainingMs negative exactly like this overrun
    // case, hitting the identical Math.max(MIN_CYCLE_GAP_MS, remainingMs)
    // clamp — the backward-jump test below covers the other (Math.min) branch.
    test('overrun: next cycle starts MIN_CYCLE_GAP_MS after the slow cycle ends', async () => {
        const OVERRUN_MS = 5 * MS_PER_MINUTE; // 5 min cycle vs 3 min budget
        const cycleStarts: number[] = [];
        const cycleEnds: number[] = [];
        runVotingCycle = jest.fn().mockImplementation(async () => {
            cycleStarts.push(Date.now());
            await new Promise((resolve) => setTimeout(resolve, OVERRUN_MS));
            cycleEnds.push(Date.now());
            return true;
        });
        scheduler = createScheduler({ runVotingCycle, getActiveChallenges });

        const startPromise = scheduler.start();
        await flushMicrotasks();
        await jest.advanceTimersByTimeAsync(OVERRUN_MS);
        await flushMicrotasks();
        await startPromise;

        expect(cycleStarts).toHaveLength(1);
        expect(cycleEnds).toHaveLength(1);

        // Cycle #1 ran from t=0 to t=5min. Target start for #2 was t=3min
        // (already in the past), so the scheduler clamps to MIN_CYCLE_GAP_MS
        // after the cycle finished — i.e. #2 starts at t=5min+5s, NOT t=5min.
        await jest.advanceTimersByTimeAsync(MIN_CYCLE_GAP_MS - 1);
        expect(cycleStarts).toHaveLength(1);

        await jest.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(cycleStarts).toHaveLength(2);
        expect(cycleStarts[1] - cycleEnds[0]).toBe(MIN_CYCLE_GAP_MS);
    });

    test('backward wall-clock jump: waitMs is capped at delayMs (no inflated wait)', async () => {
        const JUMP_BACK_MS = 10 * MS_PER_MINUTE;
        const cycleStarts: number[] = [];
        let jumped = false;
        runVotingCycle = jest.fn().mockImplementation(async () => {
            cycleStarts.push(Date.now());
            // Simulate the wall clock jumping backward (NTP correction,
            // suspend/resume) during cycle 1. Without the upper-bound
            // clamp the next wait would be ~delayMs + JUMP_BACK_MS.
            if (!jumped) {
                jest.setSystemTime(Date.now() - JUMP_BACK_MS);
                jumped = true;
            }
            return true;
        });
        scheduler = createScheduler({ runVotingCycle, getActiveChallenges });

        const startPromise = scheduler.start();
        await flushMicrotasks();
        await startPromise;

        expect(cycleStarts).toHaveLength(1);

        // With the clamp, cycle 2 must fire within delayMs of the post-jump
        // moment — NOT delayMs + JUMP_BACK_MS.
        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS);
        await flushMicrotasks();

        expect(cycleStarts).toHaveLength(2);
    });

    test('stop() prevents further cycles from firing', async () => {
        const cycleStarts: number[] = [];
        runVotingCycle = jest.fn().mockImplementation(async () => {
            cycleStarts.push(Date.now());
            return true;
        });
        scheduler = createScheduler({ runVotingCycle, getActiveChallenges });

        const startPromise = scheduler.start();
        await flushMicrotasks();
        await startPromise;

        expect(cycleStarts).toHaveLength(1);
        scheduler.stop();

        await jest.advanceTimersByTimeAsync(10 * MS_PER_MINUTE);
        await flushMicrotasks();

        expect(cycleStarts).toHaveLength(1);
    });
});

describe('createScheduler — threshold-aware cadence', () => {
    const LAST_MINUTE_THRESHOLD = 10; // minutes before close the window opens
    let runVotingCycle: jest.MockedFunction<SchedulerDeps['runVotingCycle']>;
    let getActiveChallenges: jest.MockedFunction<SchedulerDeps['getActiveChallenges']>;
    let scheduler: ReturnType<typeof createScheduler> | null;
    let now: number;
    let lastMinuteCheckFrequencyValue: number; // mutable so a test can change it mid-run

    beforeEach(() => {
        jest.useFakeTimers();
        lastMinuteCheckFrequencyValue = 1;
        settings.loadSettings.mockReturnValue(
            invalid({ app: { checkFrequencyMin: FIXED_DELAY_MIN, checkFrequencyMax: FIXED_DELAY_MIN } }),
        );
        settings.getSetting.mockReturnValue(FIXED_DELAY_MIN);
        settings.getEffectiveSetting.mockImplementation((key) => {
            if (key === 'lastMinuteThreshold') return LAST_MINUTE_THRESHOLD;
            if (key === 'lastMinuteCheckFrequency') return lastMinuteCheckFrequencyValue;
            return 1;
        });
        now = Math.floor(Date.now() / 1000);
    });

    afterEach(() => {
        if (scheduler) scheduler.stop();
        scheduler = null;
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    // Window opens 60s from now: entryTime = close_time - threshold*60 = now + 60.
    const challengeEnteringIn60s = () => ({
        id: 42,
        title: 'Closing Soon',
        type: 'regular',
        close_time: now + LAST_MINUTE_THRESHOLD * 60 + 60,
    });

    // Already inside its window: close_time - now (120s) <= threshold*60 (600s).
    const challengeInWindow = () => ({
        id: 42,
        title: 'In Window',
        type: 'regular',
        close_time: now + 120,
    });

    const startWith = async (cycleResult: unknown) => {
        runVotingCycle = jest.fn().mockResolvedValue(cycleResult);
        scheduler = createScheduler({ runVotingCycle, getActiveChallenges });
        const startPromise = scheduler.start();
        await flushMicrotasks();
        await startPromise;
    };

    test('caps the next delay to an upcoming scheduled-fill window start (mode: scheduled)', async () => {
        // Scheduled-fill window opens 90s out (before-end form); the random
        // delay is 3 min and the last-minute boundary is far away. The next
        // cycle must land on the window start, exercising the CLI resolver
        // wiring and the mode === 'scheduled' log branch.
        settings.getEffectiveSetting.mockImplementation((key) => {
            if (key === 'lastMinuteThreshold') return 5;
            if (key === 'lastMinuteCheckFrequency') return lastMinuteCheckFrequencyValue;
            if (key === 'useScheduledFill') return true;
            if (key === 'scheduledFillTime') return [];
            if (key === 'scheduledFillBeforeEnd') return [3600 - 90];
            return 1;
        });
        const challenge = { id: 7, title: 'Scheduled', type: 'regular', close_time: now + 3600 };
        await startWith({ success: true, challenges: [challenge] });

        expect(runVotingCycle).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(90_000 - 1);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(1); // window not open yet

        await jest.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(2); // fired at the window start
    });

    test('caps the next delay to an upcoming boundary instead of the random delay', async () => {
        // Boundary is 60s out; the random delay is 3 min. The next cycle must
        // land on the 60s boundary, not overshoot to 3 min.
        await startWith({ success: true, challenges: [challengeEnteringIn60s()] });

        expect(runVotingCycle).toHaveBeenCalledTimes(1); // initial cycle only

        await jest.advanceTimersByTimeAsync(60_000 - 1);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(1); // not yet — boundary not reached

        await jest.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(2); // fired at the boundary, well before 3 min
    });

    test('holds a fixed last-minute cadence while a challenge is in-window', async () => {
        lastMinuteCheckFrequencyValue = 2; // distinct from the 60s boundary cap
        await startWith({ success: true, challenges: [challengeInWindow()] });

        expect(runVotingCycle).toHaveBeenCalledTimes(1);

        // Fast cadence is lastMinuteCheckFrequency (2 min), not the 3-min random.
        await jest.advanceTimersByTimeAsync(2 * MS_PER_MINUTE - 1);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(2);
    });

    test('reverts to the normal random cadence once the window clears', async () => {
        // First cycle is in-window (fast 1-min cadence); afterwards the challenge
        // has closed, so every later cycle hands over an empty list.
        let list = [challengeInWindow()];
        runVotingCycle = jest.fn().mockImplementation(async () => ({ success: true, challenges: list }));
        scheduler = createScheduler({ runVotingCycle, getActiveChallenges });
        const startPromise = scheduler.start();
        await flushMicrotasks();
        await startPromise;

        // In-window → 1-min cadence: the 2nd cycle fires at 1 min.
        await jest.advanceTimersByTimeAsync(MS_PER_MINUTE);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(2);

        // Window now clears.
        list = [];
        // The 2nd cycle already scheduled the 3rd at the fast cadence (it saw the
        // in-window list); let it fire so the post-empty decision is made.
        await jest.advanceTimersByTimeAsync(MS_PER_MINUTE);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(3);

        // From here the cadence is the normal 3-min random: nothing fires before
        // 3 min, then a cycle does.
        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS - 1);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(3);

        await jest.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(4);
    });

    test('reflects a mid-run lastMinuteCheckFrequency change on the next in-window cycle', async () => {
        await startWith({ success: true, challenges: [challengeInWindow()] });

        // Operator raises the last-minute cadence from 1 to 5 minutes.
        lastMinuteCheckFrequencyValue = 5;

        // The next decision (after the initial cycle) already used freq 1, so the
        // 2nd cycle fires at 1 min; the cycle after that reflects freq 5.
        await jest.advanceTimersByTimeAsync(MS_PER_MINUTE);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(2);

        // 2nd cycle decided with freq 5 → next fires at 5 min, not 1.
        await jest.advanceTimersByTimeAsync(5 * MS_PER_MINUTE - 1);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(2);

        await jest.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(3);
    });

    test('picks up a mid-run per-challenge lastMinuteThreshold change and re-caps the cadence', async () => {
        // At the integration layer: a per-challenge threshold is changed
        // mid-run; the very next cycle must respect the new boundary instead
        // of riding out the already-armed random cadence. 1-min normal cadence
        // keeps the boundary arithmetic easy to follow.
        settings.loadSettings.mockReturnValue(invalid({ app: { checkFrequencyMin: 1, checkFrequencyMax: 1 } }));
        let thresholdMin = 5;
        settings.getEffectiveSetting.mockImplementation((key) => {
            if (key === 'lastMinuteThreshold') return thresholdMin;
            if (key === 'lastMinuteCheckFrequency') return lastMinuteCheckFrequencyValue;
            return 1;
        });
        // Closes in 1000s. threshold 5 → boundary 700s out, beyond the 60s normal
        // delay → normal cadence.
        const challenge = { id: 7, title: 'Cats', type: 'regular', close_time: now + 1000 };
        runVotingCycle = jest.fn().mockResolvedValue({ success: true, challenges: [challenge] });
        scheduler = createScheduler({ runVotingCycle, getActiveChallenges });
        const startPromise = scheduler.start();
        await flushMicrotasks();
        await startPromise;

        expect(runVotingCycle).toHaveBeenCalledTimes(1); // initial cycle, normal cadence armed

        // User tightens the per-challenge threshold to 15 min → boundary now at
        // abs t=100s (1000 - 900). Cycle #2 fires at the 60s normal boundary.
        thresholdMin = 15;
        await jest.advanceTimersByTimeAsync(60_000);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(2);

        // Cycle #2 re-evaluated with threshold 15: boundary is ~40s out, under the
        // 60s random delay, so the next cycle must be capped to ~40s — not another
        // full 60s. Nothing fires before the cap...
        await jest.advanceTimersByTimeAsync(40_000 - 1);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(2);

        // ...and the capped cycle fires at the new boundary.
        await jest.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(3);
    });

    test('reuses the cycle challenge list and skips the post-cycle getActiveChallenges fetch', async () => {
        getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [] });
        await startWith({ success: true, challenges: [challengeEnteringIn60s()] });

        // Initial cycle ran once; its list was reused to decide the delay, so
        // getActiveChallenges (the fetch-only fallback) was never hit.
        expect(runVotingCycle).toHaveBeenCalledTimes(1);
        expect(getActiveChallenges).not.toHaveBeenCalled();
    });

    test('falls back to fetching when the cycle hands over no list', async () => {
        getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [] });
        // A non-array result (a boolean) must trigger a fresh fetch.
        await startWith(true);

        expect(getActiveChallenges).toHaveBeenCalled();
    });

    test('a far-future boundary uses the normal cadence (no premature switch)', async () => {
        const farFuture = () => ({
            id: 99,
            title: 'Weeks Away',
            type: 'regular',
            close_time: now + 30 * 24 * 3600,
        });
        await startWith({ success: true, challenges: [farFuture()] });

        expect(runVotingCycle).toHaveBeenCalledTimes(1);
        // Exactly one pending timer (the next normal cycle), and it fires at the
        // normal 3-min cadence — the far boundary doesn't shorten it.
        expect(jest.getTimerCount()).toBe(1);

        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS - 1);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(runVotingCycle).toHaveBeenCalledTimes(2);
    });
});

describe('createScheduler — execution modes and the Stop fence', () => {
    const log = { info: jest.fn(), warning: jest.fn(), debug: jest.fn(), error: jest.fn(), success: jest.fn() };
    const { currentAutovoteControl } =
        require('../../src/ts/core/autovote/control') as typeof import('../../src/ts/core/autovote/control');
    const fence = jest.requireMock<{ __resetFence: () => void }>('../../src/ts/core/settings');
    let scheduler: ReturnType<typeof createScheduler>;
    let runVotingCycle: jest.MockedFunction<SchedulerDeps['runVotingCycle']>;
    let runArmedCycle: jest.MockedFunction<NonNullable<SchedulerDeps['runArmedCycle']>>;

    const make = (overrides: Partial<SchedulerDeps> = {}) => {
        scheduler = createScheduler({
            runVotingCycle,
            runArmedCycle,
            getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [] }),
            ...overrides,
        });
        return scheduler;
    };

    beforeEach(() => {
        jest.mocked(loggerModule.withCategory).mockImplementation(() => invalid(log));
        jest.useFakeTimers();
        fence.__resetFence();
        settings.loadSettings.mockReturnValue(
            invalid({ app: { checkFrequencyMin: FIXED_DELAY_MIN, checkFrequencyMax: FIXED_DELAY_MIN } }),
        );
        settings.getSetting.mockReturnValue(FIXED_DELAY_MIN);
        settings.getEffectiveSetting.mockReturnValue(1);
        runVotingCycle = jest.fn().mockResolvedValue({ success: true, challenges: [] });
        runArmedCycle = jest.fn().mockResolvedValue({ success: true, challenges: [] });
    });

    afterEach(async () => {
        await scheduler?.stopAll();
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    test('Run creates the fence, runs, and registers the control; full Stop fences, cancels and unregisters', async () => {
        make();
        await scheduler.start();
        expect(scheduler.getMode()).toBe('voting');
        expect(scheduler.isRunning()).toBe(true);
        // The registered control answers the live mode (what a reader in this process, like the CLI status, prints).
        expect(currentAutovoteControl()?.mode()).toBe('voting');
        expect(currentAutovoteControl()).not.toBeNull();
        expect(jest.getTimerCount()).toBe(1);

        await expect(scheduler.stopAll()).resolves.toEqual({
            outcome: 'stopped',
            durable: true,
            epoch: 1,
            withdrawal: 'none',
        });
        expect(scheduler.getMode()).toBe('stopped');
        expect(scheduler.isRunning()).toBe(false);
        expect(currentAutovoteControl()).toBeNull();
        expect(jest.getTimerCount()).toBe(0);
        expect(settings.readStopFence()).toMatchObject({ fence: { stopEpoch: 1, blocked: true } });

        // The user's own Run lifts the block.
        await scheduler.start();
        expect(scheduler.getMode()).toBe('voting');
        expect(settings.readStopFence()).toMatchObject({ fence: { stopEpoch: 1, blocked: false } });
    });

    test('stop() is the same full Stop for a caller that does not wait', async () => {
        make();
        await scheduler.start();
        scheduler.stop();
        expect(scheduler.getMode()).toBe('stopped');
        expect(jest.getTimerCount()).toBe(0);
        await flushMicrotasks();
        expect(settings.readStopFence()).toMatchObject({ fence: { stopEpoch: 1, blocked: true } });
    });

    test('a Stop the fence cannot save stays local and says so; no Run until a later save succeeds', async () => {
        make();
        await scheduler.start();
        settings.recordFullStop.mockResolvedValueOnce({ ok: false, reason: 'not-saved' });
        await expect(scheduler.stopAll()).resolves.toEqual({
            outcome: 'stopped-locally',
            durable: false,
            reason: 'not-saved',
            withdrawal: 'none',
        });
        settings.recordFullStop.mockResolvedValueOnce({ ok: false, reason: 'not-saved' });
        await scheduler.start();
        expect(scheduler.getMode()).toBe('stopped');
        await scheduler.start();
        expect(scheduler.getMode()).toBe('voting');
    });

    test('a host with no fence stops locally and runs as it always did', async () => {
        make({ stopFence: null });
        await scheduler.start();
        await expect(scheduler.stopAll()).resolves.toEqual({
            outcome: 'stopped-locally',
            durable: false,
            reason: 'no-fence',
            withdrawal: 'none',
        });
        await scheduler.start();
        expect(scheduler.getMode()).toBe('voting');
    });

    test('Run while voting does nothing; a Stop during the first cycle hands nothing to the chain', async () => {
        make();
        await scheduler.start();
        await scheduler.start();
        expect(runVotingCycle).toHaveBeenCalledTimes(1);
        await scheduler.stopAll();

        let finish!: () => void;
        runVotingCycle.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = () => resolve({ success: true, challenges: [] });
                }),
        );
        const held = scheduler.start();
        await flushMicrotasks();
        await scheduler.stopAll();
        finish();
        await held;
        expect(jest.getTimerCount()).toBe(0);
    });

    test('armed: the installation-only cycle runs, no voting stage does, one timer; Resume voting is the same chain', async () => {
        make();
        await expect(scheduler.arm()).resolves.toBe(true);
        expect(scheduler.getMode()).toBe('armed');
        expect(runArmedCycle).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(1);
        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS + 1);
        expect(runArmedCycle).toHaveBeenCalledTimes(2);
        expect(runVotingCycle).not.toHaveBeenCalled();
        // Arming again does nothing.
        await expect(scheduler.arm()).resolves.toBe(false);

        await scheduler.start();
        expect(scheduler.getMode()).toBe('voting');
        expect(jest.getTimerCount()).toBe(1);
        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS + 1);
        expect(runVotingCycle).toHaveBeenCalled();
    });

    test('a Stop during the armed first cycle hands nothing to the chain', async () => {
        let finish!: () => void;
        runArmedCycle.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = () => resolve({ success: true, challenges: [] });
                }),
        );
        make();
        const held = scheduler.arm();
        await flushMicrotasks();
        await scheduler.stopAll();
        finish();
        await expect(held).resolves.toBe(true);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a Stop while the voting stages are being turned on makes the request obsolete', async () => {
        const fetched: Array<() => void> = [];
        make({
            getActiveChallenges: jest.fn(
                () =>
                    new Promise((resolve) => {
                        fetched.push(() => resolve({ challenges: [] }));
                    }),
            ),
        });
        await expect(scheduler.arm()).resolves.toBe(true);
        const captured = currentAutovoteControl()!.capture();
        const held = scheduler.requestVotingStages(true, captured);
        await flushMicrotasks();
        await scheduler.stopAll();
        for (const release of fetched) release();
        await expect(held).resolves.toEqual({ ok: false, reason: 'obsolete' });
    });

    test('a host with no fence arms locally, and an arm the fence refuses leaves it stopped', async () => {
        make({ stopFence: null });
        await expect(scheduler.arm()).resolves.toBe(true);
        expect(scheduler.getMode()).toBe('armed');
        await scheduler.stopAll();

        make();
        await scheduler.start();
        await scheduler.stopAll();
        // A Stop of another executor that this one has not seen.
        expect(await settings.recordFullStop('other', 9)).toMatchObject({ ok: true });
        await expect(scheduler.arm()).resolves.toBe(false);
        expect(scheduler.getMode()).toBe('stopped');
    });

    test('a host without an armed cycle cannot be armed', async () => {
        make({ runArmedCycle: null });
        await expect(scheduler.arm()).resolves.toBe(false);
        expect(scheduler.getMode()).toBe('stopped');
    });

    test('a block left by an earlier Stop is lifted by the first Run of a scheduler that has not seen it, and by an arm', async () => {
        make();
        expect(await settings.recordFullStop('earlier-run', 1)).toMatchObject({ ok: true });
        await expect(scheduler.arm()).resolves.toBe(true);
        expect(settings.readStopFence()).toMatchObject({ fence: { stopEpoch: 1, blocked: false } });
        await scheduler.stopAll();
        // A Stop the user has not seen (recorded by another executor after this one's last) refuses the Run.
        expect(await settings.recordFullStop('other', 2)).toMatchObject({ ok: true });
        await scheduler.start();
        expect(scheduler.getMode()).toBe('stopped');
        await scheduler.start();
        expect(scheduler.getMode()).toBe('voting');
    });

    test('an installation scenario asks for the voting stages through the registered control, bound to its capture', async () => {
        make();
        await scheduler.start();
        const control = currentAutovoteControl()!;
        const captured = control.capture();
        expect(await control.admits(captured)).toBe(true);
        expect(await control.request(false, captured)).toEqual({ ok: true, mode: 'armed', changed: true });
        expect(scheduler.getMode()).toBe('armed');
        expect(await control.request(false, captured)).toEqual({ ok: true, mode: 'armed', changed: false });
        expect(await control.request(true, captured)).toEqual({ ok: true, mode: 'voting', changed: true });
        expect(jest.getTimerCount()).toBe(1);

        // After a Stop the same request is obsolete, and a stopped scheduler is not armed.
        await scheduler.stopAll();
        expect(await scheduler.requestVotingStages(true, captured)).toEqual({ ok: false, reason: 'obsolete' });
        await scheduler.start();
        expect(await scheduler.requestVotingStages(true, captured)).toEqual({ ok: false, reason: 'obsolete' });
        await scheduler.stopAll();
        expect(await scheduler.requestVotingStages(true, { epoch: 0, generation: 99 })).toEqual({
            ok: false,
            reason: 'obsolete',
        });
    });

    test('a scheduler that cannot run an armed cycle cannot pause the voting stages', async () => {
        make({ runArmedCycle: null });
        await scheduler.start();
        const control = currentAutovoteControl()!;
        expect(await control.request(false, control.capture())).toEqual({ ok: false, reason: 'unsupported' });
        await scheduler.stopAll();
    });

    test('a request on a stopped scheduler is not armed, from a capture that is still current', async () => {
        make({ stopFence: null });
        // Without a fence a capture stays current while nothing stopped it.
        const request = await scheduler.requestVotingStages(true, { epoch: null, generation: 0 });
        expect(request).toEqual({ ok: false, reason: 'not-armed' });
    });

    test('a full Stop withdraws the installation’s publication under the epoch it will have, and reports it beside the fence', async () => {
        make();
        await scheduler.start();
        settings.withdrawInstallationPublication.mockReturnValueOnce({ ok: true, changed: true });
        await expect(scheduler.stopAll()).resolves.toEqual({
            outcome: 'stopped',
            durable: true,
            epoch: 1,
            withdrawal: 'withdrawn',
        });
        expect(settings.withdrawInstallationPublication).toHaveBeenLastCalledWith(1);
        // Nothing published to withdraw.
        await scheduler.start();
        await expect(scheduler.stopAll()).resolves.toMatchObject({ withdrawal: 'none' });
    });

    test('a withdrawal that cannot be written is reported failed, and the cancellation and the fence stand', async () => {
        make();
        await scheduler.start();
        settings.withdrawInstallationPublication.mockReturnValueOnce({ ok: false, reason: 'not-saved' });
        await expect(scheduler.stopAll()).resolves.toEqual({
            outcome: 'stopped',
            durable: true,
            epoch: 1,
            withdrawal: 'failed',
        });
        expect(scheduler.getMode()).toBe('stopped');
        expect(jest.getTimerCount()).toBe(0);
        expect(settings.readStopFence()).toMatchObject({ fence: { stopEpoch: 1, blocked: true } });
    });

    test('the user’s Run and arm lift the withdrawal before the first cycle; a re-arm that fails is said', async () => {
        const order: string[] = [];
        settings.restoreInstallationPublication.mockImplementation(
            () => (order.push('lift'), { ok: true, changed: true }),
        );
        runVotingCycle.mockImplementation(async () => (order.push('cycle'), { success: true, challenges: [] }));
        runArmedCycle.mockImplementation(async () => (order.push('armed'), { success: true, challenges: [] }));
        make();
        await scheduler.start();
        expect(order.slice(0, 2)).toEqual(['lift', 'cycle']);
        await scheduler.stopAll();
        order.length = 0;
        await expect(scheduler.arm()).resolves.toBe(true);
        expect(order.slice(0, 2)).toEqual(['lift', 'armed']);
        await scheduler.stopAll();

        settings.restoreInstallationPublication.mockReturnValueOnce({ ok: false, reason: 'not-saved' });
        await scheduler.start();
        expect(log.warning).toHaveBeenCalledWith(
            'The installation scenario could not be re-armed: its withdrawal still stands',
        );
        expect(scheduler.getMode()).toBe('voting');
    });

    test('the voting stages come back on under an armed scheduler without lifting anything', async () => {
        make();
        await scheduler.arm();
        settings.restoreInstallationPublication.mockClear();
        await scheduler.start();
        expect(scheduler.getMode()).toBe('voting');
        expect(settings.restoreInstallationPublication).not.toHaveBeenCalled();
    });

    test('a Stop recorded elsewhere ends the run at the next timer, and the scheduler stops arming', async () => {
        make();
        await scheduler.start();
        expect(await settings.recordFullStop('other-executor', 1)).toMatchObject({ ok: true });
        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS + 1);
        expect(runVotingCycle).toHaveBeenCalledTimes(1);
        expect(scheduler.getMode()).toBe('stopped');
        expect(jest.getTimerCount()).toBe(0);
    });
});
