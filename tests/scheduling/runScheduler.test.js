/**
 * Verifies the start-anchored scheduling in normal mode: the gap between
 * cycle starts should be ~delayMs regardless of how long any single cycle
 * takes, and an overrunning cycle should pause MIN_CYCLE_GAP_MS before
 * firing again (rather than re-firing immediately).
 *
 * Threshold-mode (node-cron) is out of scope — we mock node-cron so it
 * stays inert and the normal-mode setTimeout chain is exercised directly.
 */

jest.mock('node-cron', () => ({
    schedule: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
}));

jest.mock('../../src/js/settings', () => ({
    loadSettings: jest.fn(),
    getSetting: jest.fn(),
    getEffectiveSetting: jest.fn(),
}));

const settings = require('../../src/js/settings');
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
