/**
 * Verifies the single-timer scheduler.
 *
 * Normal mode keeps the start-anchored spacing: the gap between cycle starts
 * should be ~delayMs regardless of how long any single cycle takes, and an
 * overrunning cycle should pause MIN_CYCLE_GAP_MS before firing again.
 *
 * Threshold mode no longer uses a separate node-cron switch — the next delay is
 * decided each cycle by computeNextCycleDelayMs, so the chain caps to an
 * upcoming boundary (approaching), holds a fixed fast cadence while in-window
 * (last-minute), and reverts to the random cadence once the window clears.
 */

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

describe('createScheduler — threshold-aware cadence', () => {
    const LAST_MINUTE_THRESHOLD = 10; // minutes before close the window opens
    let runVotingCycle;
    let getActiveChallenges;
    let scheduler;
    let now;
    let lastMinuteCheckFrequencyValue; // mutable so a test can change it mid-run

    beforeEach(() => {
        jest.useFakeTimers();
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

    const startWith = async (cycleResult) => {
        runVotingCycle = jest.fn().mockResolvedValue(cycleResult);
        scheduler = createScheduler({ runVotingCycle, getActiveChallenges });
        const startPromise = scheduler.start();
        await flushMicrotasks();
        await startPromise;
    };

    test('caps the next delay to an upcoming boundary instead of the random delay', async () => {
        // Boundary is 60s out; the random delay is 3 min. The next cycle must
        // land on the 60s boundary, not overshoot to 3 min. This is the
        // reported-bug regression lock.
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
        // The reported bug, at the integration layer: a per-challenge threshold
        // is changed mid-run; the very next cycle must respect the new boundary
        // instead of riding out the old random cadence. 1-min normal cadence
        // keeps the boundary arithmetic easy to follow.
        settings.loadSettings.mockReturnValue({ checkFrequencyMin: 1, checkFrequencyMax: 1 });
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
        // A non-array result (legacy boolean) must trigger a fresh fetch.
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
