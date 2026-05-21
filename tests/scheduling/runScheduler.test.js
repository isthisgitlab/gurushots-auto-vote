/**
 * Verifies the start-anchored scheduling in normal mode: the gap between
 * cycle starts should be ~delayMs regardless of how long any single cycle
 * takes, and an overrunning cycle should pause MIN_CYCLE_GAP_MS before
 * firing again (rather than re-firing immediately).
 *
 * The normal-mode tests mock node-cron so it stays inert and the
 * setTimeout chain is exercised directly. The threshold-mode revert test
 * (further down) drives the captured cron callback manually to simulate
 * a tick.
 */

let mockCronCallback = null;
const mockCronJob = { start: jest.fn(), stop: jest.fn() };
jest.mock('node-cron', () => ({
    schedule: jest.fn((expr, cb) => {
        mockCronCallback = cb;
        return mockCronJob;
    }),
}));

jest.mock('../../src/js/settings', () => ({
    loadSettings: jest.fn(),
    getSetting: jest.fn(),
    getEffectiveSetting: jest.fn(),
}));

const settings = require('../../src/js/settings');
const cron = require('node-cron');
const { createScheduler } = require('../../src/js/scheduling/runScheduler');
const { MIN_CYCLE_GAP_MS, MS_PER_MINUTE } = require('../../src/js/scheduling/randomDelay');

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
    let runVotingCycle;
    let getActiveChallenges;
    let scheduler;

    beforeEach(() => {
        jest.useFakeTimers();
        settings.loadSettings.mockReturnValue({
            checkFrequencyMin: FIXED_DELAY_MIN,
            checkFrequencyMax: FIXED_DELAY_MIN,
        });
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
        const cycleStarts = [];
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
        const cycleStarts = [];
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

    test('overrun: next cycle starts MIN_CYCLE_GAP_MS after the slow cycle ends', async () => {
        const OVERRUN_MS = 5 * MS_PER_MINUTE; // 5 min cycle vs 3 min budget
        const cycleStarts = [];
        const cycleEnds = [];
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
        const cycleStarts = [];
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
        const cycleStarts = [];
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

describe('createScheduler — threshold-mode revert', () => {
    const LAST_MINUTE_THRESHOLD = 10; // minutes before close that triggers cron mode
    let runVotingCycle;
    let getActiveChallenges;
    let scheduler;
    let now;
    let lastMinuteCheckFrequencyValue; // mutable so a test can change it mid-cron

    beforeEach(() => {
        jest.useFakeTimers();
        mockCronCallback = null;
        lastMinuteCheckFrequencyValue = 1;
        settings.loadSettings.mockReturnValue({
            checkFrequencyMin: FIXED_DELAY_MIN,
            checkFrequencyMax: FIXED_DELAY_MIN,
        });
        settings.getSetting.mockReturnValue(FIXED_DELAY_MIN);
        settings.getEffectiveSetting.mockImplementation((key) => {
            if (key === 'lastMinuteThreshold') return LAST_MINUTE_THRESHOLD;
            if (key === 'lastMinuteCheckFrequency') return lastMinuteCheckFrequencyValue;
            return 1;
        });
        runVotingCycle = jest.fn().mockResolvedValue(true);
        now = Math.floor(Date.now() / 1000);
    });

    afterEach(() => {
        if (scheduler) scheduler.stop();
        scheduler = null;
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    // A regular challenge whose last-minute window opens 60s from now:
    // entryTime = close_time - threshold*60 = now + 60.
    const challengeEnteringIn60s = () => ({
        id: 42,
        title: 'Closing Soon',
        type: 'regular',
        close_time: now + LAST_MINUTE_THRESHOLD * 60 + 60,
    });

    // Drives start() → normal mode, then advances exactly 60s so the threshold
    // setTimeout fires and the scheduler switches into the 1-min cron. 60_000ms
    // is load-bearing: it equals timeUntilEntry for challengeEnteringIn60s
    // (entryTime = close_time - threshold*60 = now + 60). After the advance the
    // challenge sits at exactly close_time - now == threshold*60 — the inclusive
    // (<=) boundary of isAnyChallengeInThresholdWindow.
    const enterCronMode = async () => {
        scheduler = createScheduler({ runVotingCycle, getActiveChallenges });
        const startPromise = scheduler.start();
        await flushMicrotasks();
        await startPromise;

        await jest.advanceTimersByTimeAsync(60_000);
        await flushMicrotasks();
    };

    test('reuses the cycle challenge list and skips the post-cycle getActiveChallenges fetch', async () => {
        // The voting cycle now resolves with the active list it fetched; the
        // post-cycle threshold step must reuse it rather than fetch again (the
        // back-to-back duplicate request that showed up in the logs).
        runVotingCycle = jest.fn().mockResolvedValue({ success: true, challenges: [challengeEnteringIn60s()] });
        getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [] });

        scheduler = createScheduler({ runVotingCycle, getActiveChallenges });
        const startPromise = scheduler.start();
        await flushMicrotasks();
        await startPromise;

        // Initial cycle ran once; its list was reused, so getActiveChallenges
        // (only ever called by updateThresholdScheduling) was never hit.
        expect(runVotingCycle).toHaveBeenCalledTimes(1);
        expect(getActiveChallenges).not.toHaveBeenCalled();
    });

    test('falls back to fetching when the cycle hands over no list', async () => {
        // A non-array result (here the legacy boolean) must not short-circuit:
        // the threshold step still fetches a fresh list.
        runVotingCycle = jest.fn().mockResolvedValue(true);
        getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [] });

        scheduler = createScheduler({ runVotingCycle, getActiveChallenges });
        const startPromise = scheduler.start();
        await flushMicrotasks();
        await startPromise;

        expect(getActiveChallenges).toHaveBeenCalled();
    });

    test('reverts to normal cadence once no challenge is within its last-minute window', async () => {
        getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [challengeEnteringIn60s()] });

        await enterCronMode();

        // Switched into 1-min cron.
        expect(cron.schedule).toHaveBeenCalledWith('*/1 * * * *', expect.any(Function), expect.anything());
        expect(mockCronJob.start).toHaveBeenCalled();
        expect(typeof mockCronCallback).toBe('function');

        // The triggering challenge has now closed — nothing left in window.
        getActiveChallenges.mockResolvedValue({ challenges: [] });

        const callsBeforeTick = runVotingCycle.mock.calls.length;

        // Simulate a cron tick: runs a cycle, then updateThresholdScheduling
        // should detect the empty window and revert to normal mode.
        await mockCronCallback();
        await flushMicrotasks();

        expect(mockCronJob.stop).toHaveBeenCalled();
        // The tick itself ran one cycle.
        expect(runVotingCycle.mock.calls.length).toBe(callsBeforeTick + 1);

        // Normal 3-min chain is live again: advancing the normal delay fires
        // another cycle (the dead cron would never do this).
        const callsBeforeResume = runVotingCycle.mock.calls.length;
        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS);
        await flushMicrotasks();
        expect(runVotingCycle.mock.calls.length).toBe(callsBeforeResume + 1);
    });

    test('stays in cron mode while a challenge remains within its last-minute window', async () => {
        getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [challengeEnteringIn60s()] });

        await enterCronMode();

        expect(mockCronJob.start).toHaveBeenCalled();
        const stopCallsAfterSwitch = mockCronJob.stop.mock.calls.length;

        // Challenge is still open and within its window — a tick must NOT revert.
        const callsBeforeTick = runVotingCycle.mock.calls.length;
        await mockCronCallback();
        await flushMicrotasks();

        expect(runVotingCycle.mock.calls.length).toBe(callsBeforeTick + 1);
        expect(mockCronJob.stop.mock.calls.length).toBe(stopCallsAfterSwitch);
    });

    test('restarts the cron at the new frequency when lastMinuteCheckFrequency changes mid-cron', async () => {
        getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [challengeEnteringIn60s()] });

        await enterCronMode();

        expect(cron.schedule).toHaveBeenLastCalledWith('*/1 * * * *', expect.any(Function), expect.anything());
        const stopCallsAfterSwitch = mockCronJob.stop.mock.calls.length;

        // Operator raises the last-minute cadence from 1 to 5 minutes mid-cron;
        // the challenge is still in its window, so the running cron must restart
        // at */5 rather than wait for the next switch.
        lastMinuteCheckFrequencyValue = 5;

        await mockCronCallback();
        await flushMicrotasks();

        expect(cron.schedule).toHaveBeenLastCalledWith('*/5 * * * *', expect.any(Function), expect.anything());
        // The restart stopped the old (*/1) cron.
        expect(mockCronJob.stop.mock.calls.length).toBeGreaterThan(stopCallsAfterSwitch);
    });

    test('defers scheduling a threshold switch that is beyond the max timer delay', async () => {
        // close_time ~30 days out → entry is ~30 days away, exceeding Node's
        // 32-bit setTimeout ceiling. The switch must be deferred (no cron, no
        // threshold timer) instead of arming a timer that would fire immediately.
        const farFuture = () => ({
            id: 99,
            title: 'Weeks Away',
            type: 'regular',
            close_time: now + 30 * 24 * 3600,
        });
        getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [farFuture()] });

        scheduler = createScheduler({ runVotingCycle, getActiveChallenges });
        const startPromise = scheduler.start();
        await flushMicrotasks();
        await startPromise;

        // No switch armed: cron untouched and the only pending timer is the
        // normal-mode setTimeout (without the guard, a second threshold timer
        // would be armed → count of 2).
        expect(cron.schedule).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(1);
    });
});
