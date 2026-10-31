/**
 * The autovote controller (src/ts/autovote/controller.ts) driven directly
 * through a hand-built host: start/stop/toggle lifecycle, the voting-cycle
 * outcome handling, the mount-time auto-resume hold, and the transport glue
 * the controller hands to the shared cadence chain. These are the cases the
 * AutovoteContext suite used to carry, now host-level — no DOM, no window;
 * the background service is a jest.fn() host member instead of the two mocked
 * service modules.
 */

import type * as controllerModule from '../../src/ts/autovote/controller';
import type { AutovoteHost } from '../../src/ts/autovote/controller';
import { formatOversleptMessage } from '../../src/ts/scheduling/cadenceChain';

const { createAutovoteController } = require('../../src/ts/autovote/controller') as typeof controllerModule;

import type { AutovoteState } from '../../src/ts/autovote/state';
import type * as cadenceChainModule from '../../src/ts/scheduling/cadenceChain';
import type { Challenge } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

type ChainDeps = Parameters<typeof cadenceChainModule.createCadenceChain>[0];

const captured: { chainDeps: ChainDeps | null } = { chainDeps: null };

jest.mock('../../src/ts/scheduling/cadenceChain', () => {
    const actual = jest.requireActual<typeof cadenceChainModule>('../../src/ts/scheduling/cadenceChain');
    return {
        ...actual,
        createCadenceChain: (deps: ChainDeps) => {
            captured.chainDeps = deps;
            return actual.createCadenceChain(deps);
        },
    };
});

const MIN = 60_000;
const SEC = 1000;

const deferred = () => {
    let resolve!: (value?: unknown) => void;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
};

// What the host's translate seam answers, mirroring the page translator's
// key → template → filled-text flow the old suite asserted through.
const WORDS: Record<string, string> = {
    'app.title': 'GuruShots Auto Vote',
    'app.autovoteNotificationPreparing': 'Preparing the first cycle',
    'app.autovoteNotificationLastCycle': 'Last cycle: {time}',
};
const fillTemplate = (text: string, vars?: Record<string, string>): string =>
    vars === undefined
        ? text
        : text.replace(/\{(\w+)\}/g, (_match, name: string) => {
              const value = vars[name];
              return value === null || value === undefined ? '' : String(value);
          });
const translate = (key: string, vars?: Record<string, string>): string => fillTemplate(WORDS[key] ?? key, vars);

const makeHost = (overrides: Partial<AutovoteHost> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const far = invalid<Challenge[]>([{ id: 1, title: 'Far', type: 'regular', close_time: now + 100_000 }]);
    const refresh: { current: (() => unknown) | undefined } = { current: undefined };
    const host: AutovoteHost = {
        runVotingCycle: jest.fn(),
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
        background: {
            start: jest.fn(),
            stop: jest.fn(),
            update: jest.fn(),
            status: jest.fn(),
        },
        formatTime: (ms) => new Date(ms).toLocaleTimeString('en-GB'),
        translate: jest.fn(translate),
        notifier: jest.fn(),
        getOnChallengesRefresh: () => refresh.current,
        ...overrides,
    };
    jest.mocked(host.getSettings).mockResolvedValue(
        invalid({ app: { checkFrequencyMin: 5, checkFrequencyMax: 5 }, hasToken: true }),
    );
    jest.mocked(host.getSetting).mockResolvedValue(null);
    jest.mocked(host.setSetting).mockResolvedValue(invalid(undefined));
    jest.mocked(host.getActiveChallenges).mockResolvedValue({ challenges: far });
    jest.mocked(host.getEffectiveSetting).mockImplementation((key) =>
        Promise.resolve(key === 'lastMinuteCheckFrequency' ? 1 : 10),
    );
    jest.mocked(host.runVotingCycle).mockResolvedValue(invalid({ success: true, challenges: far }));
    jest.mocked(host.background.start).mockResolvedValue(undefined);
    jest.mocked(host.background.stop).mockResolvedValue(undefined);
    jest.mocked(host.background.update).mockResolvedValue(undefined);
    jest.mocked(host.background.status).mockResolvedValue(invalid({ running: false, available: false }));
    // Launched long ago, so the startup hold has passed unless a test sets one.
    jest.mocked(host.getEnvironmentInfo).mockResolvedValue(invalid({ launchedAt: Date.now() - 600_000 }));
    jest.mocked(host.getGlobalDefault).mockResolvedValue(60);
    return { host, refresh };
};

describe('createAutovoteController', () => {
    let host: AutovoteHost;
    let refresh: { current: (() => unknown) | undefined };
    let controller: ReturnType<typeof createAutovoteController> | null;

    // Build a controller over a fresh host; the globals feed the afterEach.
    const setup = (overrides: Partial<AutovoteHost> = {}) => {
        const made = makeHost(overrides);
        host = made.host;
        refresh = made.refresh;
        controller = createAutovoteController(host);
        return controller;
    };

    // The persisted session was running; the hold is `delay` s after a launch `launchedAgo` s ago.
    const interrupted = (launchedAgo: number, delay: unknown = 60) => {
        jest.mocked(host.getSetting).mockResolvedValue(true);
        jest.mocked(host.getGlobalDefault).mockResolvedValue(delay);
        jest.mocked(host.getEnvironmentInfo).mockResolvedValue(invalid({ launchedAt: Date.now() - launchedAgo * SEC }));
    };

    const advance = async (ms: number) => {
        await jest.advanceTimersByTimeAsync(ms);
    };

    beforeEach(() => {
        jest.useFakeTimers();
        captured.chainDeps = null;
        controller = null;
    });

    afterEach(async () => {
        if (controller?.getState().running) {
            await controller.stop();
        }
        controller?.dispose();
        controller = null;
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('exposes the initial state and notifies subscribers on every change until unsubscribed', async () => {
        const made = makeHost();
        const fresh = createAutovoteController(made.host);
        expect(fresh.getState().running).toBe(false);

        const seen: AutovoteState[] = [];
        const unsubscribe = fresh.subscribe(() => seen.push(fresh.getState()));
        await fresh.start();
        fresh.dispose();
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.at(-1)?.running).toBe(true);

        const count = seen.length;
        unsubscribe();
        await fresh.stop();
        expect(seen.length).toBe(count);
        expect(made.host.runVotingCycle).toHaveBeenCalledTimes(1);
    });

    describe('start / stop', () => {
        it('starts: persists the flag, runs the first cycle, refreshes challenges and arms the chain', async () => {
            const onChallengesRefresh = jest.fn();
            setup();
            refresh.current = onChallengesRefresh;

            await controller!.start();

            expect(host.setCancelVoting).toHaveBeenCalledWith(false);
            expect(host.setSetting).toHaveBeenCalledWith('autovoteRunning', true);
            // The Android notification text is translated (not English literals) and the time follows the UI language.
            expect(host.background.start).toHaveBeenCalledWith('Preparing the first cycle');
            expect(host.background.update).toHaveBeenCalledWith(
                'GuruShots Auto Vote',
                expect.stringMatching(/^Last cycle: \d{2}:\d{2}:\d{2}$/),
            );
            expect(onChallengesRefresh).toHaveBeenCalledTimes(1);
            expect(controller!.getState().running).toBe(true);
            expect(controller!.getState().cycles).toBe(1);
            expect(controller!.getState().lastRun).toEqual(expect.any(String));
            expect(controller!.getState().status).toBe('Running');
            // Prefetched list handed to the chain → no extra fetch.
            expect(host.getActiveChallenges).not.toHaveBeenCalled();
            expect(controller!.getState().nextRunAt).toBeGreaterThan(Date.now());

            // Starting twice is a no-op.
            await controller!.start();
            expect(host.runVotingCycle).toHaveBeenCalledTimes(1);
        });

        describe('launch marker', () => {
            const markerWrites = () =>
                jest.mocked(host.setSetting).mock.calls.filter(([key]) => key === 'autovoteStartedLaunch');

            it('persists the launch time it read, just before the running flag', async () => {
                setup();
                jest.mocked(host.getEnvironmentInfo).mockResolvedValue(invalid({ launchedAt: 1_700_000_000_000 }));
                await controller!.start();

                const calls = jest.mocked(host.setSetting).mock.calls;
                const marker = calls.findIndex(([key]) => key === 'autovoteStartedLaunch');
                expect(calls[marker]).toEqual(['autovoteStartedLaunch', 1_700_000_000_000]);
                expect(calls[marker + 1]).toEqual(['autovoteRunning', true]);
            });

            it.each([
                ['unreadable', () => jest.mocked(host.getEnvironmentInfo).mockRejectedValue(new Error('io'))],
                ['missing', () => jest.mocked(host.getEnvironmentInfo).mockResolvedValue(invalid({}))],
            ])('persists 0 (matches no launch) when the launch time is %s', async (_label, breakEnv) => {
                setup();
                breakEnv();
                await controller!.start();
                expect(markerWrites()).toEqual([['autovoteStartedLaunch', 0]]);
                expect(controller!.getState().running).toBe(true);
            });

            it.each([
                [new Error('disk full'), 'Could not record the auto-vote launch marker: disk full'],
                [null, 'Could not record the auto-vote launch marker: null'],
            ])('a failed write (%p) is logged as a warning and the start goes on', async (thrown, logged) => {
                setup();
                jest.mocked(host.setSetting).mockImplementation((key) =>
                    key === 'autovoteStartedLaunch' ? Promise.reject(thrown) : Promise.resolve(invalid(undefined)),
                );
                await controller!.start();
                expect(host.logRendererWarning).toHaveBeenCalledWith(logged);
                expect(host.setSetting).toHaveBeenCalledWith('autovoteRunning', true);
                expect(controller!.getState().running).toBe(true);
            });
        });

        it('stops: clears the timer, persisted flag, background host and refreshes challenges', async () => {
            const onChallengesRefresh = jest.fn();
            setup();
            refresh.current = onChallengesRefresh;
            await controller!.start();
            onChallengesRefresh.mockClear();

            await controller!.stop();

            expect(host.setCancelVoting).toHaveBeenLastCalledWith(true);
            expect(host.setSetting).toHaveBeenLastCalledWith('autovoteRunning', false);
            expect(host.background.stop).toHaveBeenCalledTimes(1);
            expect(onChallengesRefresh).toHaveBeenCalledTimes(1);
            expect(controller!.getState().running).toBe(false);
            expect(controller!.getState().nextRunAt).toBeNull();

            // The cleared timer never fires another cycle.
            await advance(30 * MIN);
            expect(host.runVotingCycle).toHaveBeenCalledTimes(1);

            // Stopping when already stopped is a no-op.
            await controller!.stop();
            expect(host.setCancelVoting).toHaveBeenCalledTimes(2);
        });

        it('stop() calls the latest onChallengesRefresh identity, not the one start saw', async () => {
            const first = jest.fn();
            const latest = jest.fn();
            setup();
            refresh.current = first;
            await controller!.start();
            expect(first).toHaveBeenCalledTimes(1);

            refresh.current = latest;
            await controller!.stop();
            expect(latest).toHaveBeenCalledTimes(1);
            expect(first).toHaveBeenCalledTimes(1);
        });

        it('tolerates a failing flag write and keeps driving the background host', async () => {
            setup();
            jest.mocked(host.setSetting).mockRejectedValue(new Error('disk full'));

            await controller!.start();
            expect(controller!.getState().running).toBe(true);
            expect(host.background.start).toHaveBeenCalledTimes(1);

            await controller!.stop();
            expect(controller!.getState().running).toBe(false);
            expect(host.background.stop).toHaveBeenCalledTimes(1);
        });

        it('a stop during start setup skips the first cycle and leaves nothing armed', async () => {
            setup();
            const gate = deferred();
            jest.mocked(host.setCancelVoting).mockImplementationOnce(() => invalid(gate.promise));

            const startPromise = controller!.start();
            await controller!.stop();
            gate.resolve();
            await startPromise;

            expect(host.runVotingCycle).not.toHaveBeenCalled();
            expect(controller!.getState().running).toBe(false);
            expect(controller!.getState().nextRunAt).toBeNull();
            // The interrupted start never reached its side effects: the flag
            // was never written true and the background host never started
            // (the only autovoteRunning write here is stop()'s own false).
            expect(
                jest
                    .mocked(host.setSetting)
                    .mock.calls.filter(([key, value]) => key === 'autovoteRunning' && value === true),
            ).toEqual([]);
            expect(host.background.start).not.toHaveBeenCalled();
        });

        it.each([
            [
                'the launch-marker read',
                (gate: ReturnType<typeof deferred>) =>
                    jest.mocked(host.getEnvironmentInfo).mockImplementation(() => invalid(gate.promise)),
            ],
            [
                'the running-flag write',
                (gate: ReturnType<typeof deferred>) =>
                    jest
                        .mocked(host.setSetting)
                        .mockImplementationOnce(() => Promise.resolve(invalid(undefined)))
                        .mockImplementationOnce(() => invalid(gate.promise)),
            ],
        ])('a stop during %s in start setup leaves nothing armed', async (_label, gateOn) => {
            setup();
            const gate = deferred();
            gateOn(gate);

            const startPromise = controller!.start();
            await advance(0);
            await controller!.stop();
            gate.resolve();
            await startPromise;

            expect(host.runVotingCycle).not.toHaveBeenCalled();
            expect(host.background.start).not.toHaveBeenCalled();
            // The true-write raced the stop; the last write on the record is
            // stop()'s false, so a remount does not resume.
            const flagWrites = jest.mocked(host.setSetting).mock.calls.filter(([key]) => key === 'autovoteRunning');
            expect(flagWrites.at(-1)).toEqual(['autovoteRunning', false]);
            await advance(30 * MIN);
            expect(host.runVotingCycle).not.toHaveBeenCalled();
        });

        it('a stop during the background handoff in start setup skips the first cycle', async () => {
            setup();
            const gate = deferred();
            jest.mocked(host.background.start).mockImplementation(() => invalid(gate.promise));

            const startPromise = controller!.start();
            await advance(0);
            await controller!.stop();
            gate.resolve();
            await startPromise;

            // The flag write already happened (the stop raced it), but the
            // cycle and the chain did not.
            expect(host.runVotingCycle).not.toHaveBeenCalled();
            await advance(30 * MIN);
            expect(host.runVotingCycle).not.toHaveBeenCalled();
            expect(controller!.getState().running).toBe(false);
        });

        it('a stop while the first cycle is in flight discards its result', async () => {
            setup();
            const gate = deferred();
            jest.mocked(host.runVotingCycle).mockImplementationOnce(() => invalid(gate.promise));
            const onChallengesRefresh = jest.fn();
            refresh.current = onChallengesRefresh;

            const startPromise = controller!.start();
            await advance(0);
            await controller!.stop();
            onChallengesRefresh.mockClear();
            gate.resolve({ success: true });
            await startPromise;

            expect(controller!.getState().cycles).toBe(0);
            expect(onChallengesRefresh).not.toHaveBeenCalled();
        });

        it('start replaces a timer armed by a rearm that raced the first cycle', async () => {
            setup();
            const gate = deferred();
            jest.mocked(host.runVotingCycle).mockImplementationOnce(() => invalid(gate.promise));

            const startPromise = controller!.start();
            await advance(0);
            // Running, no timer yet → rearm arms one.
            await controller!.rearmSchedule();
            gate.resolve({ success: true });
            await startPromise;

            // Exactly one chain survives: one cycle per 5-minute period.
            await advance(5 * MIN + 1_000);
            expect(host.runVotingCycle).toHaveBeenCalledTimes(2);
        });

        it('dispose cancels the armed cycle timer and leaves the persisted flag alone', async () => {
            setup();
            await controller!.start();
            controller!.dispose();
            // dispose must not dispatch STOP nor persist the flag: the session outlives its mount.
            expect(controller!.getState().running).toBe(true);
            expect(jest.mocked(host.setSetting).mock.calls.filter(([key]) => key === 'autovoteRunning')).toEqual([
                ['autovoteRunning', true],
            ]);
            await advance(30 * MIN);
            expect(host.runVotingCycle).toHaveBeenCalledTimes(1);
        });

        it('dispose is a no-op when nothing was ever armed', () => {
            setup();
            expect(() => controller!.dispose()).not.toThrow();
        });

        it('a dispose while the first cycle is in flight leaves no chain and no outcome', async () => {
            setup();
            const gate = deferred();
            jest.mocked(host.runVotingCycle).mockImplementationOnce(() => invalid(gate.promise));

            const startPromise = controller!.start();
            await advance(0);
            controller!.dispose();
            gate.resolve({ success: true });
            await startPromise;

            // The in-flight cycle was the one gated call; the disposed
            // controller discards its result and arms nothing.
            expect(host.runVotingCycle).toHaveBeenCalledTimes(1);
            expect(controller!.getState().cycles).toBe(0);
            await advance(30 * MIN);
            expect(host.runVotingCycle).toHaveBeenCalledTimes(1);
        });

        it('a dispose during start setup still persists the session but arms nothing', async () => {
            setup();
            const gate = deferred();
            jest.mocked(host.background.start).mockImplementation(() => invalid(gate.promise));

            const startPromise = controller!.start();
            await advance(0);
            controller!.dispose();
            gate.resolve();
            await startPromise;

            // Dispose means the mount went away, not that the session stopped:
            // the persists and the background handoff landed so a remount
            // adopts a consistent session, but no cycle ran and nothing armed.
            expect(jest.mocked(host.setSetting).mock.calls.filter(([key]) => key === 'autovoteRunning')).toEqual([
                ['autovoteRunning', true],
            ]);
            expect(host.background.start).toHaveBeenCalledTimes(1);
            expect(host.runVotingCycle).not.toHaveBeenCalled();
            await advance(30 * MIN);
            expect(host.runVotingCycle).not.toHaveBeenCalled();
        });

        it('a dispose while a rearm is in flight arms nothing', async () => {
            setup();
            await controller!.start();
            expect(host.runVotingCycle).toHaveBeenCalledTimes(1);

            const gate = deferred();
            jest.mocked(host.getSettings).mockImplementation(() => invalid(gate.promise));
            const rearmPromise = controller!.rearmSchedule();
            controller!.dispose();
            gate.resolve(invalid({ app: { checkFrequencyMin: 5, checkFrequencyMax: 5 }, hasToken: true }));
            await rearmPromise;

            await advance(30 * MIN);
            expect(host.runVotingCycle).toHaveBeenCalledTimes(1);
        });

        it('a disposed controller notifies no subscriber anymore', async () => {
            setup();
            const gate = deferred();
            jest.mocked(host.runVotingCycle).mockImplementationOnce(() => invalid(gate.promise));
            let notifications = 0;
            controller!.subscribe(() => {
                notifications += 1;
            });

            const startPromise = controller!.start();
            await advance(0); // start is parked at the gated cycle
            expect(notifications).toBe(1); // START, before the dispose
            controller!.dispose();
            gate.resolve({ success: true });
            await startPromise;
            // Whatever still fires on the disposed controller reaches nobody.
            await controller!.start();
            await advance(30 * MIN);

            expect(notifications).toBe(1);
            expect(host.runVotingCycle).toHaveBeenCalledTimes(1);
        });

        it('running flips synchronously in start and stop, before any await resolves', async () => {
            setup();
            const started = controller!.start();
            expect(controller!.getState().running).toBe(true);
            const stopped = controller!.stop();
            expect(controller!.getState().running).toBe(false);

            await started;
            await stopped;
            // The interrupted start never reached its cycle.
            expect(host.runVotingCycle).not.toHaveBeenCalled();
        });

        it.each([
            [new Error('no notification'), 'Background notification update failed: no notification'],
            [null, 'Background notification update failed: null'],
        ])('a rejected notification update (%p) is logged, never unhandled', async (thrown, logged) => {
            setup();
            jest.mocked(host.background.update).mockRejectedValue(thrown);
            await controller!.start();
            expect(host.logRendererWarning).toHaveBeenCalledWith(logged);
        });
    });

    describe('voting cycle outcomes', () => {
        const startAndRead = async () => {
            await controller!.start();
            const state = controller!.getState();
            return { error: state.error, status: state.status, cycles: state.cycles };
        };

        it('reports the not-logged-in code when there is no token', async () => {
            setup();
            jest.mocked(host.getSettings).mockResolvedValue(invalid({ app: {} }));
            expect(await startAndRead()).toEqual({ error: 'not-logged-in', status: 'Error', cycles: 0 });
            expect(host.runVotingCycle).not.toHaveBeenCalled();
        });

        it('surfaces the cycle error message and logs it', async () => {
            setup();
            jest.mocked(host.runVotingCycle).mockResolvedValue({ success: false, error: 'API request failed' });
            expect(await startAndRead()).toMatchObject({ error: 'API request failed', status: 'Error' });
            expect(host.logRendererWarning).toHaveBeenCalledWith('Voting cycle failed: API request failed');
        });

        it('falls back to the voting-failed code for an unsuccessful result without a message', async () => {
            setup();
            jest.mocked(host.runVotingCycle).mockResolvedValue(invalid(undefined));
            expect(await startAndRead()).toMatchObject({ error: 'voting-failed' });
        });

        it('reports a thrown error as a code and logs its message', async () => {
            setup();
            jest.mocked(host.runVotingCycle).mockRejectedValue(new Error('network down'));
            expect(await startAndRead()).toMatchObject({ error: 'voting-error' });
            expect(host.logRendererWarning).toHaveBeenCalledWith('Voting cycle threw: network down');
        });

        it.each([[{}], [null]])('reports a thrown %p without a message as the same code', async (thrown) => {
            setup();
            jest.mocked(host.runVotingCycle).mockRejectedValue(thrown);
            expect(await startAndRead()).toMatchObject({ error: 'voting-error' });
        });

        it('a success without a challenge list makes the chain fetch fresh', async () => {
            setup();
            jest.mocked(host.runVotingCycle).mockResolvedValue(invalid({ success: true }));
            expect(await startAndRead()).toMatchObject({ error: null, cycles: 1 });
            expect(host.getActiveChallenges).toHaveBeenCalledWith();
        });

        it('the next cycle uses a new onChallengesRefresh identity without a re-arm', async () => {
            setup();
            const first = jest.fn();
            refresh.current = first;
            await controller!.start();
            expect(first).toHaveBeenCalledTimes(1);

            const latest = jest.fn();
            refresh.current = latest;
            await advance(5 * MIN + 1_000);
            expect(host.runVotingCycle).toHaveBeenCalledTimes(2);
            expect(latest).toHaveBeenCalledTimes(1);
            expect(first).toHaveBeenCalledTimes(1);
        });
    });

    describe('auto-resume on mount', () => {
        // The persisted session was running; the hold is `delay` s after a launch `launchedAgo` s ago (see `interrupted`).
        const advanceAfter = async (ms: number) => {
            await jest.advanceTimersByTimeAsync(ms);
        };

        it('does nothing when no session was persisted as running', async () => {
            setup(); // the persisted flag reads null
            await controller!.maybeResume();
            expect(controller!.getState().running).toBe(false);
            expect(host.getSettings).not.toHaveBeenCalled();
            expect(host.background.status).not.toHaveBeenCalled();
        });

        it('resumes a persisted running session when logged in', async () => {
            setup();
            jest.mocked(host.getSetting).mockResolvedValue(true);
            await controller!.maybeResume();
            expect(host.getSetting).toHaveBeenCalledWith('autovoteRunning');
            expect(controller!.getState().running).toBe(true);
            expect(host.runVotingCycle).toHaveBeenCalledTimes(1);
        });

        it('does not resume without a token', async () => {
            setup();
            jest.mocked(host.getSetting).mockResolvedValue(true);
            jest.mocked(host.getSettings).mockResolvedValue(invalid(null));
            await controller!.maybeResume();
            expect(controller!.getState().running).toBe(false);
        });

        it('stays stopped when reading the flag fails', async () => {
            setup();
            jest.mocked(host.getSetting).mockRejectedValue(new Error('io'));
            await controller!.maybeResume();
            expect(controller!.getState().running).toBe(false);
            expect(host.getSettings).not.toHaveBeenCalled();
        });

        describe('startup hold', () => {
            it('holds the resume until the delay after launch has passed, then starts', async () => {
                setup();
                interrupted(10);
                const launchedAt = Date.now() - 10 * SEC;
                await controller!.maybeResume();

                expect(host.getGlobalDefault).toHaveBeenCalledWith('autovoteStartupDelay');
                expect(controller!.getState().running).toBe(false);
                expect(controller!.getState().pendingStartAt).toBe(launchedAt + 60 * SEC);
                expect(host.runVotingCycle).not.toHaveBeenCalled();
                expect(host.logRendererDebug).toHaveBeenCalledWith('Auto-resume held for 50s after launch');

                await advanceAfter(49 * SEC);
                expect(controller!.getState().running).toBe(false);
                expect(host.runVotingCycle).not.toHaveBeenCalled();

                await advanceAfter(2 * SEC);
                expect(controller!.getState().running).toBe(true);
                expect(controller!.getState().pendingStartAt).toBeNull();
                expect(host.runVotingCycle).toHaveBeenCalledTimes(1);
                expect(host.logRendererDebug).toHaveBeenCalledWith('Auto-resume hold over — starting');
            });

            it('starts at once with a delay of 0', async () => {
                setup();
                interrupted(0, 0);
                await controller!.maybeResume();
                expect(controller!.getState().running).toBe(true);
                expect(controller!.getState().pendingStartAt).toBeNull();
            });

            it('starts at once when the hold has already passed (a reload after it)', async () => {
                setup();
                interrupted(61);
                await controller!.maybeResume();
                expect(controller!.getState().running).toBe(true);
                expect(controller!.getState().pendingStartAt).toBeNull();
                expect(host.runVotingCycle).toHaveBeenCalledTimes(1);
            });

            it('a reload during the hold continues the same countdown instead of restarting it', async () => {
                setup();
                interrupted(40);
                await controller!.maybeResume();
                expect(controller!.getState().pendingStartAt).toBe(Date.now() + 20 * SEC);
                controller!.dispose();

                await advanceAfter(5 * SEC);
                const second = createAutovoteController(host);
                await second.maybeResume();
                expect(second.getState().pendingStartAt).toBe(Date.now() + 15 * SEC);
            });

            it('adopts a running native service at once, without reading the hold', async () => {
                setup();
                interrupted(5);
                jest.mocked(host.background.status).mockResolvedValue(invalid({ running: true, available: true }));
                await controller!.maybeResume();
                expect(controller!.getState().running).toBe(true);
                expect(controller!.getState().pendingStartAt).toBeNull();
                expect(host.getGlobalDefault).not.toHaveBeenCalledWith('autovoteStartupDelay');
            });

            it('a native service found after the app unmounted is not adopted', async () => {
                setup();
                interrupted(5);
                const gate = deferred();
                jest.mocked(host.background.status).mockImplementation(() => invalid(gate.promise));
                const pending = controller!.maybeResume();
                controller!.dispose();
                gate.resolve({ running: true, available: true });
                await pending;
                expect(host.setCancelVoting).not.toHaveBeenCalled();
            });

            it('a manual start during the hold starts once, and the hold timer does not start again', async () => {
                setup();
                interrupted(10);
                await controller!.maybeResume();
                expect(controller!.getState().pendingStartAt).not.toBeNull();

                await controller!.start();
                expect(controller!.getState().running).toBe(true);
                expect(controller!.getState().pendingStartAt).toBeNull();

                await advanceAfter(60 * SEC);
                expect(host.runVotingCycle).toHaveBeenCalledTimes(1);
            });

            it('a manual start during the mount awaits leaves no pending state and no timer', async () => {
                setup();
                interrupted(10);
                const gate = deferred();
                // start() reads the launch time itself, so the gate sits on the delay read instead.
                jest.mocked(host.getGlobalDefault).mockImplementation(() => invalid(gate.promise));
                const pending = controller!.maybeResume();
                await advanceAfter(0);

                await controller!.start();
                gate.resolve(60);
                await pending;

                expect(controller!.getState().running).toBe(true);
                expect(controller!.getState().pendingStartAt).toBeNull();
                await advanceAfter(2 * 60 * SEC);
                expect(host.runVotingCycle).toHaveBeenCalledTimes(1);
            });

            it('a start then a stop during the mount awaits does not arm the hold afterwards', async () => {
                setup();
                interrupted(10);
                const gate = deferred();
                // start() reads the launch time itself, so the gate sits on the delay read instead.
                jest.mocked(host.getGlobalDefault).mockImplementation(() => invalid(gate.promise));
                const pending = controller!.maybeResume();
                await advanceAfter(0);

                await controller!.start();
                await controller!.stop();
                jest.mocked(host.runVotingCycle).mockClear();
                gate.resolve(60);
                await pending;

                expect(controller!.getState().running).toBe(false);
                expect(controller!.getState().pendingStartAt).toBeNull();
                await advanceAfter(2 * 60 * SEC);
                expect(controller!.getState().running).toBe(false);
                expect(host.runVotingCycle).not.toHaveBeenCalled();
            });

            it('a system sleep does not stretch the hold: the wall clock decides, in chunks of 5 s', async () => {
                setup();
                interrupted(10);
                await controller!.maybeResume();
                expect(controller!.getState().pendingStartAt).not.toBeNull();

                // The machine sleeps for 50 s: monotonic timers fire late, Date.now() jumps
                // past the resume time, and the next 5 s chunk notices.
                jest.setSystemTime(Date.now() + 50 * SEC);
                await advanceAfter(5 * SEC);
                expect(controller!.getState().running).toBe(true);
                expect(controller!.getState().pendingStartAt).toBeNull();
                expect(host.runVotingCycle).toHaveBeenCalledTimes(1);
            });

            it('stop while pending cancels the resume, persists false and stops the background host', async () => {
                setup();
                interrupted(10);
                await controller!.maybeResume();

                await controller!.stop();
                expect(controller!.getState().pendingStartAt).toBeNull();
                expect(controller!.getState().running).toBe(false);
                expect(host.setSetting).toHaveBeenLastCalledWith('autovoteRunning', false);
                expect(host.background.stop).toHaveBeenCalledTimes(1);
                expect(host.logRendererDebug).toHaveBeenCalledWith('Auto-resume cancelled');

                await advanceAfter(2 * 60 * SEC);
                expect(controller!.getState().running).toBe(false);
                expect(host.runVotingCycle).not.toHaveBeenCalled();
            });

            it('a dispose before the awaits resolve never arms the timer', async () => {
                setup();
                interrupted(10);
                const gate = deferred();
                jest.mocked(host.getEnvironmentInfo).mockImplementation(() => invalid(gate.promise));
                const pending = controller!.maybeResume();
                controller!.dispose();
                gate.resolve({ launchedAt: Date.now() });
                await pending;

                await advanceAfter(2 * 60 * SEC);
                expect(host.runVotingCycle).not.toHaveBeenCalled();
                expect(host.logRendererDebug).not.toHaveBeenCalledWith(expect.stringContaining('Auto-resume held'));
            });

            it('a dispose after the timer is armed clears it', async () => {
                setup();
                interrupted(10);
                await controller!.maybeResume();
                controller!.dispose();

                await advanceAfter(2 * 60 * SEC);
                expect(host.runVotingCycle).not.toHaveBeenCalled();
            });

            it.each([
                ['an unreadable delay', () => jest.mocked(host.getGlobalDefault).mockRejectedValue(new Error('io'))],
                ['a null delay', () => jest.mocked(host.getGlobalDefault).mockResolvedValue(null)],
                ['a non-numeric delay', () => jest.mocked(host.getGlobalDefault).mockResolvedValue(invalid('soon'))],
            ])('%s holds for the default 60 s', async (_label, breakDelay) => {
                setup();
                interrupted(10);
                breakDelay();
                await controller!.maybeResume();
                expect(controller!.getState().pendingStartAt).toBe(Date.now() + 50 * SEC);
            });

            it.each([
                [
                    'unreadable launch time',
                    () => jest.mocked(host.getEnvironmentInfo).mockRejectedValue(new Error('io')),
                ],
                ['launch time missing', () => jest.mocked(host.getEnvironmentInfo).mockResolvedValue(invalid({}))],
            ])('an %s counts the mount as the launch, so the full hold applies', async (_label, breakEnv) => {
                setup();
                interrupted(10);
                breakEnv();
                await controller!.maybeResume();
                expect(controller!.getState().pendingStartAt).toBe(Date.now() + 60 * SEC);
            });

            it.each([
                [new Error('offline'), 'Auto-resume failed: offline'],
                [null, 'Auto-resume failed: null'],
            ])('a rejected start from the timer (%p) is logged', async (thrown, logged) => {
                setup();
                interrupted(55);
                jest.mocked(host.setCancelVoting).mockRejectedValueOnce(thrown);
                await controller!.maybeResume();
                await advanceAfter(6 * SEC);
                expect(host.logRendererError).toHaveBeenCalledWith(logged);
            });
        });
    });

    describe('cadence-chain transport', () => {
        it('wires settings, challenge fetch and the last-minute frequency over IPC', async () => {
            setup();
            const deps = captured.chainDeps!;
            await deps.loadSettings();
            expect(host.getSettings).toHaveBeenCalled();
            await deps.fetchChallenges(invalid({}));
            expect(host.getActiveChallenges).toHaveBeenCalledWith();
            await expect(deps.resolveLastMinuteCheckMinutes()).resolves.toBe(1);
            expect(host.getEffectiveSetting).toHaveBeenCalledWith('lastMinuteCheckFrequency', 'global');
        });

        it('logs non-normal cadence lines only', () => {
            setup();
            const { log } = captured.chainDeps!;
            expect(log.cadence('normal', 'quiet')).toBeUndefined();
            log.cadence('last-minute', 'loud');
            expect(host.logRendererDebug).toHaveBeenCalledWith('loud');
            expect(host.logRendererDebug).toHaveBeenCalledTimes(1);
        });

        it('formats decision and cycle errors for either Errors or bare values', () => {
            setup();
            const { log } = captured.chainDeps!;
            log.decisionError(new Error('bad math'));
            expect(host.logRendererWarning).toHaveBeenLastCalledWith(expect.stringMatching(/: bad math$/));
            log.decisionError('plain');
            expect(host.logRendererWarning).toHaveBeenLastCalledWith(expect.stringMatching(/: plain$/));

            log.cycleError(new Error('boom'));
            expect(host.logRendererWarning).toHaveBeenLastCalledWith('Voting cycle failed: boom');
            log.cycleError('str');
            expect(host.logRendererWarning).toHaveBeenLastCalledWith('Voting cycle failed: str');
            log.cycleError(undefined);
            expect(host.logRendererWarning).toHaveBeenLastCalledWith('Voting cycle failed: undefined');

            // The overslept warning stays wired through the shared formatter.
            log.overslept!(120_000, 60_000);
            expect(host.logRendererWarning).toHaveBeenLastCalledWith(formatOversleptMessage(120_000, 60_000));
            expect(host.logRendererWarning).toHaveBeenCalledTimes(6);
        });

        it('publishes the next run as an absolute instant, or clears it', () => {
            setup();
            const { onScheduled } = captured.chainDeps!;
            const before = Date.now();
            onScheduled!(1_000);
            expect(controller!.getState().nextRunAt).toBe(before + 1_000);
            onScheduled!(null);
            expect(controller!.getState().nextRunAt).toBeNull();
        });

        it('hands the host notifier to the chain, and a null notifier leaves the hook unwired', () => {
            setup();
            expect(captured.chainDeps!.onCycleChallenges).toBe(host.notifier);

            setup({ notifier: null });
            expect(captured.chainDeps!.onCycleChallenges).toBeUndefined();
        });
    });

    describe('rearmSchedule after a settings change', () => {
        let activeChallenges: Array<{ id: number; title: string; type: string; close_time: number }>;
        let checkFrequencyMinutes: number;

        const setupRearm = () => {
            setup();
            const now = Math.floor(Date.now() / 1000);
            // Challenge far from closing → normal cadence, no threshold capping.
            activeChallenges = [{ id: 1, title: 'Far Away', type: 'regular', close_time: now + 100_000 }];
            checkFrequencyMinutes = 5;
            jest.mocked(host.getSettings).mockImplementation(async () =>
                invalid({
                    app: { checkFrequencyMin: checkFrequencyMinutes, checkFrequencyMax: checkFrequencyMinutes },
                    hasToken: true,
                }),
            );
            jest.mocked(host.getSetting).mockResolvedValue(null); // no auto-resume on mount
            jest.mocked(host.getActiveChallenges).mockImplementation(async () =>
                invalid({ challenges: activeChallenges }),
            );
            jest.mocked(host.runVotingCycle).mockResolvedValue(
                invalid({ success: true, challenges: activeChallenges }),
            );
            return controller!;
        };

        it('re-arms the timer with the new settings instead of finishing the old wait', async () => {
            const c = setupRearm();

            await c.start();
            const cyclesAfterStart = jest.mocked(host.runVotingCycle).mock.calls.length;
            expect(cyclesAfterStart).toBe(1); // start()'s immediate cycle; timer armed for 5 min

            // User saves settings: check frequency drops to 1 minute.
            checkFrequencyMinutes = 1;
            await c.rearmSchedule();

            // 1 minute later the re-armed timer fires. The stale 5-minute timer
            // would not have — and must not fire on top later.
            await advance(MIN + 1_000);
            expect(jest.mocked(host.runVotingCycle).mock.calls.length).toBe(cyclesAfterStart + 1);

            // Cross the old timer's original deadline: total cycles follow the new
            // 1-minute cadence only; the superseded 5-minute timer stays dead.
            await advance(4 * MIN);
            expect(jest.mocked(host.runVotingCycle).mock.calls.length).toBe(cyclesAfterStart + 5);
        });

        it('is a no-op while autovote is stopped', async () => {
            const c = setupRearm();

            await c.rearmSchedule();

            await advance(10 * MIN);
            expect(host.runVotingCycle).not.toHaveBeenCalled();
        });
    });

    describe('last-minute cadence reverts to normal', () => {
        let activeChallenges: Array<{ id: number; title: string; type: string; close_time: number }>;

        const setupRevert = () => {
            setup();
            const now = Math.floor(Date.now() / 1000);
            // Regular challenge inside its last-minute window at start (closes in
            // 5 min, 10-min threshold) so start() arms the fixed 1-minute interval.
            activeChallenges = [{ id: 1, title: 'Closing Soon', type: 'regular', close_time: now + 300 }];

            jest.mocked(host.getSettings).mockResolvedValue(
                invalid({ app: { checkFrequencyMin: 3, checkFrequencyMax: 3 }, hasToken: true }),
            );
            jest.mocked(host.getSetting).mockResolvedValue(null); // no auto-resume on mount
            jest.mocked(host.getActiveChallenges).mockImplementation(async () =>
                invalid({ challenges: activeChallenges }),
            );
            jest.mocked(host.runVotingCycle).mockResolvedValue(invalid({ success: true }));
            return controller!;
        };

        it('tears down the 1-minute interval and resumes normal cadence once the window empties', async () => {
            const c = setupRevert();

            // Start → initial cycle + fixed 1-minute interval (challenge in window).
            await c.start();

            // The triggering challenge has now closed — nothing left in window.
            activeChallenges = [];

            // First 1-minute tick: runs a cycle, then updateThresholdScheduling
            // detects the empty window and reverts to the normal cadence.
            await advance(MIN);
            const callsAfterRevert = jest.mocked(host.runVotingCycle).mock.calls.length;
            expect(callsAfterRevert).toBeGreaterThanOrEqual(1);

            // Another minute passes: the dead 1-minute interval must NOT fire again.
            await advance(MIN);
            expect(jest.mocked(host.runVotingCycle).mock.calls.length).toBe(callsAfterRevert);

            // The normal 3-minute cadence is live again: it was armed at the revert
            // (t≈+1min) to fire +3min later, so reaching ~+4min fires exactly one
            // more cycle (a lingering 1-min cadence would have fired ~3 by now).
            await advance(2 * MIN + 30_000);
            expect(jest.mocked(host.runVotingCycle).mock.calls.length).toBe(callsAfterRevert + 1);
        });

        it('reuses the cycle challenge list on each tick instead of re-fetching for threshold scheduling', async () => {
            // The voting cycle returns the list it fetched over IPC; the
            // last-minute tick's threshold re-check must reuse it rather than issue
            // its own getActiveChallenges round-trip.
            const c = setupRevert();
            jest.mocked(host.runVotingCycle).mockResolvedValue(
                invalid({ success: true, challenges: activeChallenges }),
            );

            await c.start();

            // Measure only the tick's behavior (start()'s own fetches are irrelevant).
            const fetchesBeforeTick = jest.mocked(host.getActiveChallenges).mock.calls.length;
            const cyclesBeforeTick = jest.mocked(host.runVotingCycle).mock.calls.length;

            await advance(MIN);

            // The 1-minute tick ran a cycle...
            expect(jest.mocked(host.runVotingCycle).mock.calls.length).toBe(cyclesBeforeTick + 1);
            // ...and reused that cycle's list — no new getActiveChallenges fetch.
            expect(jest.mocked(host.getActiveChallenges).mock.calls.length).toBe(fetchesBeforeTick);
        });

        it('falls back to fetching when the cycle surfaces no challenge list (IPC dropped challenges)', async () => {
            // Simulate the backend not returning `challenges` (e.g. an older main
            // process, or a partial refactor): the threshold re-check must fall back
            // to a fresh getActiveChallenges fetch rather than treat it as empty.
            const c = setupRevert();
            jest.mocked(host.runVotingCycle).mockResolvedValue(invalid({ success: true })); // no challenges field

            await c.start();

            const fetchesBeforeTick = jest.mocked(host.getActiveChallenges).mock.calls.length;

            await advance(MIN);

            // The tick could not reuse a list, so it fetched fresh.
            expect(jest.mocked(host.getActiveChallenges).mock.calls.length).toBeGreaterThan(fetchesBeforeTick);
        });

        it('does not re-arm the cadence chain when stop() is called while a cycle is in flight', async () => {
            // Normal cadence (nothing in window) so we control the timing precisely.
            const c = setupRevert();
            activeChallenges = [];

            let releaseCycle!: () => void;
            let cycleCalls = 0;
            jest.mocked(host.runVotingCycle).mockImplementation(() => {
                cycleCalls += 1;
                // The first timer-driven cycle (#2) hangs until we release it, so we
                // can call stop() while it is mid-flight.
                if (cycleCalls === 2) {
                    return new Promise((resolve) => {
                        releaseCycle = () => resolve(invalid({ success: true }));
                    });
                }
                return Promise.resolve(invalid({ success: true }));
            });

            await c.start();
            expect(cycleCalls).toBe(1); // initial cycle; normal 3-min timer armed

            // Fire the timer → cycle #2 starts and blocks awaiting runVotingCycle.
            await advance(3 * MIN);
            expect(cycleCalls).toBe(2);

            // Stop mid-flight, then let the hung cycle resolve. Its finally must see
            // the cleared timer ref and decline to schedule the next cycle.
            await c.stop();
            releaseCycle();
            await Promise.resolve();

            // No ghost chain: advancing well past any cadence fires nothing more.
            await advance(10 * MIN);
            expect(cycleCalls).toBe(2);
        });

        it('stays at the 1-minute cadence while a challenge remains in its window', async () => {
            const c = setupRevert();

            await c.start();

            // Challenge stays open and in-window across the next two ticks.
            const before = jest.mocked(host.runVotingCycle).mock.calls.length;
            await advance(MIN);
            await advance(MIN);
            // Two 1-minute ticks → two cycles (no revert while in-window).
            expect(jest.mocked(host.runVotingCycle).mock.calls.length).toBe(before + 2);
        });
    });
});
