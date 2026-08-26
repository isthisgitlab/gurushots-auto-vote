/**
 * Direct tests for the shared cadence-chain factory
 * (src/js/scheduling/cadenceChain.js) through a fake transport.
 *
 * Both hosts (runScheduler.js for CLI/Android, AutovoteContext.jsx for the
 * GUI) are thin adapters over this factory — these tests are the guard that
 * keeps a future edit from passing one host's suite while silently breaking
 * the other's: the loop invariants (fresh settings per decision, prefetched
 * reuse, anchored normal wait vs raw threshold delay, error fallback, guards)
 * are asserted here once, against the factory itself.
 */

const { createCadenceChain, DECISION_ERROR_MESSAGE } = require('../../src/js/scheduling/cadenceChain');
const { MS_PER_MINUTE, MIN_CYCLE_GAP_MS } = require('../../src/js/scheduling/randomDelay');

const FIXED_DELAY_MIN = 3;
const FIXED_DELAY_MS = FIXED_DELAY_MIN * MS_PER_MINUTE;

// Drain chained .then() callbacks without advancing fake-timer time (modern
// fake timers also fake setImmediate, so chain plain microtasks instead).
const flushMicrotasks = async () => {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
};

// Fake transport: a host-owned timer slot plus jest.fn()s for every seam.
const makeDeps = (overrides = {}) => {
    let running = true;
    let timer = null;
    const deps = {
        isRunning: jest.fn(() => running),
        getTimer: jest.fn(() => timer),
        setTimer: jest.fn((handle) => {
            timer = handle;
        }),
        loadSettings: jest.fn(() => ({
            checkFrequencyMin: FIXED_DELAY_MIN,
            checkFrequencyMax: FIXED_DELAY_MIN,
            timezone: 'UTC',
        })),
        fetchChallenges: jest.fn(async () => ({ challenges: [] })),
        resolveLastMinuteCheckMinutes: jest.fn(() => 1),
        resolveThreshold: jest.fn(() => 10),
        resolveScheduledFill: jest.fn(() => ({ enabled: false, timesOfDay: [], beforeEndSecs: [] })),
        runCycle: jest.fn(async () => true),
        log: {
            cadence: jest.fn(),
            decisionError: jest.fn(),
            cycleError: jest.fn(),
        },
        ...overrides,
    };
    deps._setRunning = (value) => {
        running = value;
    };
    return deps;
};

// Challenge far from closing → normal mode.
const farChallenge = () => ({
    id: 1,
    title: 'Far Away',
    type: 'regular',
    close_time: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
});

// Challenge already inside its 10-minute window → last-minute mode.
const inWindowChallenge = () => ({
    id: 2,
    title: 'In Window',
    type: 'regular',
    close_time: Math.floor(Date.now() / 1000) + 120,
});

describe('createCadenceChain', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    test('not-running guard: never reads settings, never arms, clears the timer slot', async () => {
        const deps = makeDeps();
        deps._setRunning(false);
        const chain = createCadenceChain(deps);

        await chain.scheduleNext();

        expect(deps.loadSettings).not.toHaveBeenCalled();
        expect(deps.setTimer).toHaveBeenCalledWith(null);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('running flipped off mid-decision: decides but never arms', async () => {
        const deps = makeDeps();
        const chain = createCadenceChain(deps);
        // The settings read is the first await — flip running off inside it so
        // the post-decision re-check is what must prevent the arm.
        deps.loadSettings.mockImplementation(() => {
            deps._setRunning(false);
            return { checkFrequencyMin: FIXED_DELAY_MIN, checkFrequencyMax: FIXED_DELAY_MIN };
        });

        await chain.scheduleNext([farChallenge()]);

        expect(deps.loadSettings).toHaveBeenCalledTimes(1);
        expect(deps.setTimer).toHaveBeenCalledWith(null);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('reads settings fresh on every decision (once per cycle)', async () => {
        const deps = makeDeps();
        const chain = createCadenceChain(deps);

        await chain.scheduleNext([farChallenge()]);
        expect(deps.loadSettings).toHaveBeenCalledTimes(1);

        // Fire the armed cycle; its completion re-arms → a second fresh read.
        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS);
        await flushMicrotasks();
        expect(deps.runCycle).toHaveBeenCalledTimes(1);
        expect(deps.loadSettings).toHaveBeenCalledTimes(2);
    });

    test('prefetched array is reused — no fetch; non-array falls back to fetching', async () => {
        const deps = makeDeps();
        const chain = createCadenceChain(deps);

        await chain.scheduleNext([farChallenge()]);
        expect(deps.fetchChallenges).not.toHaveBeenCalled();

        // A legacy truthy-but-not-array hand-over must fetch fresh, with the
        // fresh settings snapshot handed to the fetcher (token transport).
        const deps2 = makeDeps();
        const chain2 = createCadenceChain(deps2);
        await chain2.scheduleNext(true);
        expect(deps2.fetchChallenges).toHaveBeenCalledTimes(1);
        expect(deps2.fetchChallenges).toHaveBeenCalledWith(deps2.loadSettings.mock.results[0].value);
    });

    test('normal mode anchors the wait to the previous cycle start', async () => {
        const deps = makeDeps();
        const chain = createCadenceChain(deps);

        // Previous cycle started 60s ago → wait is delayMs - 60s, not delayMs.
        await chain.scheduleNext([farChallenge()], Date.now() - 60_000);

        expect(deps.runCycle).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS - 60_000 - 1);
        await flushMicrotasks();
        expect(deps.runCycle).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(deps.runCycle).toHaveBeenCalledTimes(1);

        expect(deps.log.cadence).toHaveBeenCalledWith('normal', expect.stringContaining('Next cycle in'));
    });

    test('normal mode with an overrun cycle floors the wait at MIN_CYCLE_GAP_MS', async () => {
        const deps = makeDeps();
        const chain = createCadenceChain(deps);

        // Previous cycle started 10 minutes ago (way past the 3-min budget).
        await chain.scheduleNext([farChallenge()], Date.now() - 10 * MS_PER_MINUTE);

        await jest.advanceTimersByTimeAsync(MIN_CYCLE_GAP_MS - 1);
        await flushMicrotasks();
        expect(deps.runCycle).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(deps.runCycle).toHaveBeenCalledTimes(1);
    });

    test('threshold mode uses decision.delayMs raw — no anchoring to the previous start', async () => {
        const deps = makeDeps({ resolveLastMinuteCheckMinutes: jest.fn(() => 2) });
        const chain = createCadenceChain(deps);

        // In-window challenge → fixed 2-min cadence. The ancient previous start
        // must NOT shrink the wait (anchoring is a normal-mode-only rule).
        await chain.scheduleNext([inWindowChallenge()], Date.now() - 60 * MS_PER_MINUTE);

        await jest.advanceTimersByTimeAsync(2 * MS_PER_MINUTE - 1);
        await flushMicrotasks();
        expect(deps.runCycle).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(deps.runCycle).toHaveBeenCalledTimes(1);

        expect(deps.log.cadence).toHaveBeenCalledWith('last-minute', expect.stringContaining('Last-minute cadence'));
    });

    test('decision error → decisionError log + fallback to the plain random cadence', async () => {
        const deps = makeDeps();
        const boom = new Error('decision boom');
        // First read (decision) explodes; second read (fallback) succeeds.
        deps.loadSettings
            .mockImplementationOnce(() => {
                throw boom;
            })
            .mockImplementation(() => ({ checkFrequencyMin: FIXED_DELAY_MIN, checkFrequencyMax: FIXED_DELAY_MIN }));
        const chain = createCadenceChain(deps);

        await chain.scheduleNext([inWindowChallenge()]);

        expect(deps.log.decisionError).toHaveBeenCalledWith(boom);
        expect(deps.loadSettings).toHaveBeenCalledTimes(2);
        expect(deps.log.cadence).not.toHaveBeenCalled();

        // The fallback cadence is the plain random (fixed 3-min) delay — not
        // the in-window fast cadence the failed decision would have picked.
        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS - 1);
        await flushMicrotasks();
        expect(deps.runCycle).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(deps.runCycle).toHaveBeenCalledTimes(1);
    });

    test('decision error with the fallback settings read failing too → default cadence, loop survives', async () => {
        const deps = makeDeps({
            loadSettings: jest.fn(() => {
                throw new Error('settings unavailable');
            }),
        });
        const chain = createCadenceChain(deps);

        await chain.scheduleNext();

        expect(deps.log.decisionError).toHaveBeenCalledTimes(1);
        // getRandomCheckFrequencyMs({}) → legacy 3-minute default.
        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS);
        await flushMicrotasks();
        expect(deps.runCycle).toHaveBeenCalledTimes(1);
    });

    test('cycle rejection → cycleError log, chain still re-arms with a fresh fetch', async () => {
        const boom = new Error('cycle boom');
        const deps = makeDeps({
            runCycle: jest.fn().mockRejectedValue(boom),
        });
        const chain = createCadenceChain(deps);

        await chain.scheduleNext([farChallenge()]);
        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS);
        await flushMicrotasks();

        expect(deps.runCycle).toHaveBeenCalledTimes(1);
        expect(deps.log.cycleError).toHaveBeenCalledWith(boom);
        // Re-armed: the failed cycle handed over no list, so the next decision
        // fetched fresh, and another timer is pending.
        expect(deps.fetchChallenges).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(1);
    });

    test("a completed cycle's array result is handed to the next decision as prefetched", async () => {
        const handedOver = [farChallenge()];
        const deps = makeDeps({ runCycle: jest.fn(async () => handedOver) });
        const chain = createCadenceChain(deps);

        await chain.scheduleNext([farChallenge()]);
        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS);
        await flushMicrotasks();

        expect(deps.runCycle).toHaveBeenCalledTimes(1);
        // Neither the initial prefetched decision nor the post-cycle re-arm
        // (which reused the cycle's list) ever hit the fetcher.
        expect(deps.fetchChallenges).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(1);
    });

    test('stale timer (slot cleared by the host) neither runs a cycle nor re-arms', async () => {
        const deps = makeDeps();
        const chain = createCadenceChain(deps);

        await chain.scheduleNext([farChallenge()]);
        expect(jest.getTimerCount()).toBe(1);

        // Host takes over (rearm/stop): clears the slot; the armed timeout is
        // now stale and must decline even though running is still true.
        deps.setTimer(null);
        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS);
        await flushMicrotasks();

        expect(deps.runCycle).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('host clearing the slot mid-cycle blocks the finally re-arm', async () => {
        const deps = makeDeps();
        let releaseCycle;
        deps.runCycle.mockImplementation(
            () =>
                new Promise((resolve) => {
                    releaseCycle = () => resolve(true);
                }),
        );
        const chain = createCadenceChain(deps);

        await chain.scheduleNext([farChallenge()]);
        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS);
        await flushMicrotasks();
        expect(deps.runCycle).toHaveBeenCalledTimes(1); // cycle in flight

        // Host stops/re-arms while the cycle hangs, then the cycle finishes:
        // its finally must see the changed slot and decline to re-arm.
        deps.setTimer(null);
        releaseCycle();
        await flushMicrotasks();

        expect(deps.loadSettings).toHaveBeenCalledTimes(1); // no second decision
        expect(jest.getTimerCount()).toBe(0);
    });

    test('exports the canonical decision-error message both hosts compose their logs from', () => {
        expect(DECISION_ERROR_MESSAGE).toBe('Error computing next cycle delay; using normal cadence');
    });

    // The optional onScheduled hook — the GUI's next-action countdown source.
    // Node hosts pass none, so it must be optional-chained; when present it must
    // fire with the armed delay on arm and null when the chain stops arming.
    describe('onScheduled hook', () => {
        test('fires with the armed waitMs on a normal-mode arm', async () => {
            const onScheduled = jest.fn();
            const deps = makeDeps({ onScheduled });
            const chain = createCadenceChain(deps);

            await chain.scheduleNext([farChallenge()]);

            expect(onScheduled).toHaveBeenCalledTimes(1);
            expect(onScheduled).toHaveBeenCalledWith(FIXED_DELAY_MS);
        });

        test('fires with null when not running (before any decision)', async () => {
            const onScheduled = jest.fn();
            const deps = makeDeps({ onScheduled });
            deps._setRunning(false);
            const chain = createCadenceChain(deps);

            await chain.scheduleNext();

            expect(onScheduled).toHaveBeenCalledWith(null);
        });

        test('fires with null when running flips off mid-decision', async () => {
            const onScheduled = jest.fn();
            const deps = makeDeps({ onScheduled });
            deps.loadSettings.mockImplementation(() => {
                deps._setRunning(false);
                return { checkFrequencyMin: FIXED_DELAY_MIN, checkFrequencyMax: FIXED_DELAY_MIN };
            });
            const chain = createCadenceChain(deps);

            await chain.scheduleNext([farChallenge()]);

            expect(onScheduled).toHaveBeenLastCalledWith(null);
        });

        test('absence is fine — omitting onScheduled never throws (Node-host shape)', async () => {
            const deps = makeDeps(); // no onScheduled
            const chain = createCadenceChain(deps);
            await expect(chain.scheduleNext([farChallenge()])).resolves.toBeUndefined();
        });
    });
});
