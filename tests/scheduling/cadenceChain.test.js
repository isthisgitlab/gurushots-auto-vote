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

const {
    createCadenceChain,
    DECISION_ERROR_MESSAGE,
    OFFLINE_RETRY_MS,
} = require('../../src/js/scheduling/cadenceChain');
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

// Challenge whose pre-final-window top-up window opens within the next normal
// cadence tick → pre-final-window mode (only when a resolveFinalWindowTopUp dep is
// supplied). close in 4600s, lead 900s → window start at now+100s: strictly
// after now and inside the 3-min normal delay, so the cap fires.
const topUpSoonChallenge = () => ({
    id: 3,
    title: 'Pre Final Window',
    type: 'regular',
    close_time: Math.floor(Date.now() / 1000) + 4600,
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

    test('normal mode caps the wait to OFFLINE_RETRY_MS when the re-arm fetch reports an outage', async () => {
        // The API is unreachable: the chain's own re-arm fetch returns an empty
        // list flagged fetchFailed. Recovery to a healthy badge is gated on the
        // NEXT successful cycle, so the wait must track reconnection (~30s), not
        // the user's full checkFrequencyMax cadence — otherwise a reconnect can
        // sit under an 'Error' badge for a whole cadence interval.
        const deps = makeDeps({
            fetchChallenges: jest.fn(async () => ({ challenges: [], fetchFailed: true })),
        });
        const chain = createCadenceChain(deps);

        // Non-array hand-over → the chain fetches for itself and sees the outage.
        // Previous start is "now", so an uncapped normal wait would be the full
        // 3-min cadence; the cap must shorten it to 30s.
        await chain.scheduleNext(false, Date.now());

        await jest.advanceTimersByTimeAsync(OFFLINE_RETRY_MS - 1);
        await flushMicrotasks();
        expect(deps.runCycle).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(deps.runCycle).toHaveBeenCalledTimes(1);

        // Sanity: the cap is well inside the untouched normal cadence.
        expect(OFFLINE_RETRY_MS).toBeLessThan(FIXED_DELAY_MS);
    });

    test('normal mode keeps the full cadence when the re-arm fetch succeeds (online)', async () => {
        // Regression guard: fetchFailed absent → the offline cap must NOT apply,
        // so a healthy connection still waits the user's full cadence.
        const deps = makeDeps({
            fetchChallenges: jest.fn(async () => ({ challenges: [farChallenge()] })),
        });
        const chain = createCadenceChain(deps);

        await chain.scheduleNext(false, Date.now());

        // Still armed past the 30s offline cap...
        await jest.advanceTimersByTimeAsync(OFFLINE_RETRY_MS);
        await flushMicrotasks();
        expect(deps.runCycle).not.toHaveBeenCalled();
        // ...only fires at the full 3-min normal cadence.
        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS - OFFLINE_RETRY_MS);
        await flushMicrotasks();
        expect(deps.runCycle).toHaveBeenCalledTimes(1);
    });

    test('a persistent outage re-caps every consecutive re-arm, then releases on reconnect', async () => {
        // The cap must apply to EACH re-arm's own fetch, not just the first —
        // otherwise a multi-cycle outage recovers on only the first tick and then
        // falls back to the full cadence while still offline. runCycle returns a
        // non-array (the default), so every re-arm re-fetches for itself. The
        // fetcher reports the outage for the first two fetches, then reconnects.
        let fetchCalls = 0;
        const deps = makeDeps({
            fetchChallenges: jest.fn(async () => {
                fetchCalls += 1;
                return fetchCalls <= 2 ? { challenges: [], fetchFailed: true } : { challenges: [farChallenge()] };
            }),
        });
        const chain = createCadenceChain(deps);

        // Initial arm: fetch #1 → outage → capped to 30s → cycle 1 fires at 30s.
        await chain.scheduleNext(false, Date.now());
        await jest.advanceTimersByTimeAsync(OFFLINE_RETRY_MS);
        await flushMicrotasks();
        expect(deps.runCycle).toHaveBeenCalledTimes(1);

        // Re-arm after cycle 1: fetch #2 → still down → capped again → cycle 2 at +30s.
        await jest.advanceTimersByTimeAsync(OFFLINE_RETRY_MS);
        await flushMicrotasks();
        expect(deps.runCycle).toHaveBeenCalledTimes(2);

        // Re-arm after cycle 2: fetch #3 → reconnected → the cap is released, so
        // another 30s is NOT enough to fire...
        await jest.advanceTimersByTimeAsync(OFFLINE_RETRY_MS);
        await flushMicrotasks();
        expect(deps.runCycle).toHaveBeenCalledTimes(2);
        // ...only the full 3-min cadence fires cycle 3.
        await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS - OFFLINE_RETRY_MS);
        await flushMicrotasks();
        expect(deps.runCycle).toHaveBeenCalledTimes(3);
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

    test('pre-final-window mode caps to the top-up boundary and logs the top-up branch', async () => {
        // resolveFinalWindowTopUp is threaded unconditionally (unlike scheduledFill,
        // which is timezone-gated), so a host that supplies it arms the cap.
        const deps = makeDeps({
            resolveFinalWindowTopUp: jest.fn(() => ({ enabled: true, leadSec: 900 })),
        });
        const chain = createCadenceChain(deps);

        // Window opens at now+100s → wait is capped to ~100s, not the 3-min normal.
        await chain.scheduleNext([topUpSoonChallenge()]);

        await jest.advanceTimersByTimeAsync(100_000 - 1);
        await flushMicrotasks();
        expect(deps.runCycle).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(deps.runCycle).toHaveBeenCalledTimes(1);

        expect(deps.log.cadence).toHaveBeenCalledWith(
            'pre-final-window',
            expect.stringContaining('pre-final-window top-up for "Pre Final Window"'),
        );
        expect(deps.log.cadence).toHaveBeenCalledWith(
            'pre-final-window',
            expect.stringContaining('15m pre-final-window boundary'),
        );
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

    // The optional overslept hook. A setTimeout is a floor, not a promise: an
    // OS suspend, macOS App Nap, or Chromium's hidden-page freezing can hold a
    // renderer timer for tens of minutes, during which the chain's whole
    // "never sleep past a boundary" guarantee is void and any fill / boost /
    // turbo / emergency window inside the gap is missed with nothing logged.
    describe('overslept hook', () => {
        test('fires with (lateMs, waitMs) when the host was suspended past the due time', async () => {
            const overslept = jest.fn();
            const deps = makeDeps();
            deps.log.overslept = overslept;
            const chain = createCadenceChain(deps);

            await chain.scheduleNext([farChallenge()]);

            // Jump the wall clock WITHOUT firing the timer — exactly the shape
            // of a suspend: time passed, the timer did not run.
            jest.setSystemTime(Date.now() + 50 * MS_PER_MINUTE);
            await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS);
            await flushMicrotasks();

            expect(deps.runCycle).toHaveBeenCalledTimes(1);
            expect(overslept).toHaveBeenCalledTimes(1);
            expect(overslept).toHaveBeenCalledWith(50 * MS_PER_MINUTE, FIXED_DELAY_MS);
        });

        test('stays silent on a punctual timer', async () => {
            const overslept = jest.fn();
            const deps = makeDeps();
            deps.log.overslept = overslept;
            const chain = createCadenceChain(deps);

            await chain.scheduleNext([farChallenge()]);
            await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS);
            await flushMicrotasks();

            expect(deps.runCycle).toHaveBeenCalledTimes(1);
            expect(overslept).not.toHaveBeenCalled();
        });

        test('a throwing hook still runs the cycle — observability only', async () => {
            const deps = makeDeps();
            deps.log.overslept = jest.fn(() => {
                throw new Error('log sink down');
            });
            const chain = createCadenceChain(deps);

            await chain.scheduleNext([farChallenge()]);
            jest.setSystemTime(Date.now() + 50 * MS_PER_MINUTE);
            await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS);
            await flushMicrotasks();

            expect(deps.runCycle).toHaveBeenCalledTimes(1);
        });

        test('absence is fine — a host without the hook still runs the cycle', async () => {
            const deps = makeDeps(); // log.overslept undefined
            const chain = createCadenceChain(deps);

            await chain.scheduleNext([farChallenge()]);
            jest.setSystemTime(Date.now() + 50 * MS_PER_MINUTE);
            await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS);
            await flushMicrotasks();

            expect(deps.runCycle).toHaveBeenCalledTimes(1);
        });
    });

    // The optional onCycleChallenges hook — the OS deadline-notification layer's
    // per-cycle entry point. It lives OUTSIDE the decision try/catch and is never
    // awaited, so a bug in the (least-tested) notification code can neither kill
    // the loop nor trip the decision fallback that would discard the
    // boundary-aware cadence. These are the load-bearing safety guards.
    describe('onCycleChallenges hook', () => {
        test('fires once per cycle with the resolved challenge list and now (seconds)', async () => {
            const onCycleChallenges = jest.fn();
            const list = [farChallenge()];
            const deps = makeDeps({ onCycleChallenges });
            const chain = createCadenceChain(deps);

            await chain.scheduleNext(list);

            expect(onCycleChallenges).toHaveBeenCalledTimes(1);
            const [challengesArg, nowArg] = onCycleChallenges.mock.calls[0];
            expect(challengesArg).toBe(list);
            expect(nowArg).toBe(Math.floor(Date.now() / 1000));
        });

        test('a synchronously-throwing hook does NOT log a decision error and does NOT degrade the cadence', async () => {
            // In-window challenge with a 2-min last-minute cadence. If the hook's
            // throw leaked into the decision catch, the chain would log
            // decisionError and fall back to the plain random (3-min) cadence,
            // discarding the fast boundary-aware cadence — the exact regression
            // this feature must never cause.
            const deps = makeDeps({
                resolveLastMinuteCheckMinutes: jest.fn(() => 2),
                onCycleChallenges: jest.fn(() => {
                    throw new Error('notify boom');
                }),
            });
            const chain = createCadenceChain(deps);

            await chain.scheduleNext([inWindowChallenge()]);

            expect(deps.log.decisionError).not.toHaveBeenCalled();
            expect(deps.log.cadence).toHaveBeenCalledWith(
                'last-minute',
                expect.stringContaining('Last-minute cadence'),
            );

            // Fires at the 2-min last-minute cadence, not the 3-min fallback.
            await jest.advanceTimersByTimeAsync(2 * MS_PER_MINUTE - 1);
            await flushMicrotasks();
            expect(deps.runCycle).not.toHaveBeenCalled();
            await jest.advanceTimersByTimeAsync(1);
            await flushMicrotasks();
            expect(deps.runCycle).toHaveBeenCalledTimes(1);
        });

        test('an async-rejecting hook is swallowed — the cycle still arms and runs', async () => {
            const deps = makeDeps({
                onCycleChallenges: jest.fn(async () => {
                    throw new Error('async notify boom');
                }),
            });
            const chain = createCadenceChain(deps);

            await chain.scheduleNext([farChallenge()]);
            await jest.advanceTimersByTimeAsync(FIXED_DELAY_MS);
            await flushMicrotasks();

            expect(deps.runCycle).toHaveBeenCalledTimes(1);
        });

        test('skipped on an EARLY decision-failure (settings throw, before the list resolves)', async () => {
            const onCycleChallenges = jest.fn();
            const deps = makeDeps({
                onCycleChallenges,
                loadSettings: jest.fn(() => {
                    throw new Error('settings unavailable');
                }),
            });
            const chain = createCadenceChain(deps);

            await chain.scheduleNext([farChallenge()]);

            expect(deps.log.decisionError).toHaveBeenCalledTimes(1);
            expect(onCycleChallenges).not.toHaveBeenCalled();
        });

        test('skipped on a LATE decision-failure too (throw AFTER the list is resolved)', async () => {
            // resolveLastMinuteCheckMinutes runs after the challenge list is
            // captured; a throw here still lands in the decision catch. The hook
            // must be skipped on EVERY decision failure, so the catch nulls the
            // captured snapshot. (Guards the doc/invariant the reviewer flagged.)
            const onCycleChallenges = jest.fn();
            const deps = makeDeps({
                onCycleChallenges,
                resolveLastMinuteCheckMinutes: jest.fn(() => {
                    throw new Error('resolver boom');
                }),
            });
            const chain = createCadenceChain(deps);

            await chain.scheduleNext([farChallenge()]);

            expect(deps.log.decisionError).toHaveBeenCalledTimes(1);
            expect(onCycleChallenges).not.toHaveBeenCalled();
        });

        test('absence is fine — omitting the hook never throws (Node-host shape)', async () => {
            const deps = makeDeps(); // no onCycleChallenges
            const chain = createCadenceChain(deps);
            await expect(chain.scheduleNext([farChallenge()])).resolves.toBeUndefined();
        });
    });
});

// The gate itself, unit-tested away from the timer plumbing.
describe('oversleptBy', () => {
    const { oversleptBy, OVERSLEEP_ABSOLUTE_MS, OVERSLEEP_ALWAYS_MS } = require('../../src/js/scheduling/cadenceChain');

    test('an on-time (or early) fire is never late', () => {
        expect(oversleptBy(3 * MS_PER_MINUTE, 3 * MS_PER_MINUTE)).toBe(0);
        expect(oversleptBy(3 * MS_PER_MINUTE, 3 * MS_PER_MINUTE - 500)).toBe(0);
    });

    test('a minute of slip on a long wait is noise, not a stall', () => {
        // 45-minute wait, 90s late → past the absolute floor, but a trivial
        // fraction and nowhere near the always-report ceiling.
        expect(oversleptBy(45 * MS_PER_MINUTE, 45 * MS_PER_MINUTE + 90_000)).toBe(0);
    });

    test('the relative gate catches a short cadence badly overshot', () => {
        // 1-minute last-minute cadence, 90s late. This is the case that
        // actually costs a deadline, so it must be reported.
        expect(oversleptBy(MS_PER_MINUTE, MS_PER_MINUTE + 90_000)).toBe(90_000);
    });

    test('the absolute floor is exclusive — exactly one minute late stays quiet', () => {
        expect(oversleptBy(MS_PER_MINUTE, MS_PER_MINUTE + OVERSLEEP_ABSOLUTE_MS)).toBe(0);
        expect(oversleptBy(MS_PER_MINUTE, MS_PER_MINUTE + OVERSLEEP_ABSOLUTE_MS + 1)).toBe(OVERSLEEP_ABSOLUTE_MS + 1);
    });

    test('the relative gate is exclusive — exactly half the wait stays quiet', () => {
        // 10-minute wait, 5 minutes late: exactly 50%, and exactly at the
        // always-report ceiling. Both gates are strict `>`, so neither fires.
        const waitMs = 10 * MS_PER_MINUTE;
        expect(oversleptBy(waitMs, waitMs + waitMs * 0.5)).toBe(0);
        expect(oversleptBy(waitMs, waitMs + waitMs * 0.5 + 1)).toBe(waitMs * 0.5 + 1);
    });

    // checkFrequencyMin/Max are user-settable with no upper bound, so the
    // relative gate alone leaves a hole: on a long cadence a stall can be many
    // minutes yet a small fraction. The absolute ceiling closes it.
    test('a long cadence still reports a multi-minute stall below the relative gate', () => {
        const waitMs = 30 * MS_PER_MINUTE;
        const lateMs = 12 * MS_PER_MINUTE; // 40% — under the relative gate
        expect(lateMs).toBeLessThan(waitMs * 0.5);
        expect(oversleptBy(waitMs, waitMs + lateMs)).toBe(lateMs);
    });

    test('the always-report ceiling is exclusive at its own boundary', () => {
        // 60-minute wait so the relative gate cannot be what fires.
        const waitMs = 60 * MS_PER_MINUTE;
        expect(oversleptBy(waitMs, waitMs + OVERSLEEP_ALWAYS_MS)).toBe(0);
        expect(oversleptBy(waitMs, waitMs + OVERSLEEP_ALWAYS_MS + 1)).toBe(OVERSLEEP_ALWAYS_MS + 1);
    });

    test('reports the shape that was seen in production: a 51-minute freeze on a 3-minute cadence', () => {
        const waitMs = 3 * MS_PER_MINUTE;
        expect(oversleptBy(waitMs, waitMs + 51 * MS_PER_MINUTE)).toBe(51 * MS_PER_MINUTE);
    });
});

// One wording, shared by both hosts, because it lands on the GUI's Logs page
// where a user is trying to work out why a slot went unfilled.
describe('formatOversleptMessage', () => {
    const { formatOversleptMessage } = require('../../src/js/scheduling/cadenceChain');

    test('states what happened, why, and what to do next', () => {
        const message = formatOversleptMessage(51 * MS_PER_MINUTE, 3 * MS_PER_MINUTE);

        expect(message).toContain('51.0 min');
        expect(message).toContain('3.0 min');
        expect(message).toMatch(/suspended|throttled/);
        expect(message).toMatch(/did not happen/);
        // The remediation half — without it the user is told they lost a fill
        // and given nothing to do about it.
        expect(message).toMatch(/keep the app window open/i);
        expect(message).toMatch(/cli/i);
    });

    test('carries no emoji — every logger surface prefixes its own', () => {
        expect(formatOversleptMessage(MS_PER_MINUTE, MS_PER_MINUTE)).not.toMatch(/⚠/);
    });
});
