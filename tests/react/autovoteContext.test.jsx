/**
 * AutovoteContext — start/stop/toggle lifecycle, the voting-cycle outcome
 * handling, mount-time auto-resume, and the transport glue the provider hands
 * to the shared cadence chain and the deadline notifier.
 *
 * The cadence chain and the notifier factory are wrapped (real implementation
 * underneath) so the injected deps can be exercised directly and asserted on.
 */

import { memo } from 'react';
import { render, act } from '@testing-library/preact';
import { AutovoteProvider, useAutovote } from '@/contexts/AutovoteContext';
import * as foregroundService from '../../src/js/services/ForegroundServiceController';
import * as nativeAutovote from '../../src/js/services/NativeAutovoteBridge';
import { mockApi, mockTranslator } from './helpers/setup';

const captured = { chainDeps: null, notifierDeps: null };

jest.mock('../../src/js/scheduling/cadenceChain', () => {
    const actual = jest.requireActual('../../src/js/scheduling/cadenceChain');
    return {
        ...actual,
        createCadenceChain: (deps) => {
            captured.chainDeps = deps;
            return actual.createCadenceChain(deps);
        },
    };
});

jest.mock('../../src/js/react/notifications/deadlineNotifier', () => {
    const actual = jest.requireActual('../../src/js/react/notifications/deadlineNotifier');
    return {
        ...actual,
        createDeadlineNotifier: (deps) => {
            captured.notifierDeps = deps;
            return actual.createDeadlineNotifier(deps);
        },
    };
});

jest.mock('../../src/js/services/ForegroundServiceController', () => ({
    __esModule: true,
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    update: jest.fn(),
}));

jest.mock('../../src/js/services/NativeAutovoteBridge', () => ({
    __esModule: true,
    start: jest.fn().mockResolvedValue({ available: false }),
    stop: jest.fn().mockResolvedValue({ available: false }),
}));

const MIN = 60_000;

const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
};

describe('AutovoteContext', () => {
    let ctx;
    let view;

    function Capture() {
        ctx = useAutovote();
        return null;
    }

    const renderProvider = (props = {}) => {
        view = render(
            <AutovoteProvider {...props}>
                <Capture />
            </AutovoteProvider>,
        );
        return view;
    };

    const flush = () =>
        act(async () => {
            await jest.advanceTimersByTimeAsync(0);
        });

    beforeEach(() => {
        jest.useFakeTimers();
        window.api = mockApi;
        captured.chainDeps = null;
        captured.notifierDeps = null;
        delete globalThis.Capacitor;

        const now = Math.floor(Date.now() / 1000);
        const far = [{ id: 1, title: 'Far', type: 'regular', close_time: now + 100_000 }];
        window.api.getSettings.mockResolvedValue({ token: 'tok', checkFrequencyMin: 5, checkFrequencyMax: 5 });
        window.api.getSetting.mockResolvedValue(null);
        window.api.setSetting.mockResolvedValue(undefined);
        window.api.getActiveChallenges.mockResolvedValue({ challenges: far });
        window.api.getEffectiveSetting.mockImplementation((key) =>
            Promise.resolve(key === 'lastMinuteCheckFrequency' ? 1 : 10),
        );
        window.api.runVotingCycle.mockResolvedValue({ success: true, challenges: far });
        nativeAutovote.start.mockResolvedValue({ available: false });
        nativeAutovote.stop.mockResolvedValue({ available: false });
    });

    afterEach(async () => {
        if (ctx?.running) {
            await act(async () => {
                await ctx.stop();
            });
        }
        view?.unmount();
        view = null;
        ctx = null;
        delete globalThis.Capacitor;
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('useAutovote throws outside an AutovoteProvider', () => {
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => render(<Capture />)).toThrow('useAutovote must be used within an AutovoteProvider');
        spy.mockRestore();
    });

    describe('start / stop', () => {
        it('starts: persists the flag, runs the first cycle, refreshes challenges and arms the chain', async () => {
            const onChallengesRefresh = jest.fn();
            renderProvider({ onChallengesRefresh });

            await act(async () => {
                await ctx.start();
            });

            expect(window.api.setCancelVoting).toHaveBeenCalledWith(false);
            expect(window.api.setSetting).toHaveBeenCalledWith('autovoteRunning', true);
            expect(foregroundService.start).toHaveBeenCalledWith({
                body: 'Auto-vote running — preparing first cycle',
            });
            expect(foregroundService.update).toHaveBeenCalledWith({
                body: expect.stringMatching(/^Last cycle: /),
            });
            expect(onChallengesRefresh).toHaveBeenCalledTimes(1);
            expect(ctx.running).toBe(true);
            expect(ctx.cycles).toBe(1);
            expect(ctx.lastRun).toEqual(expect.any(String));
            expect(ctx.status).toBe('Running');
            // Prefetched list handed to the chain → no extra fetch.
            expect(window.api.getActiveChallenges).not.toHaveBeenCalled();
            expect(ctx.nextRunAt).toBeGreaterThan(Date.now());

            // Starting twice is a no-op.
            await act(async () => {
                await ctx.start();
            });
            expect(window.api.runVotingCycle).toHaveBeenCalledTimes(1);
        });

        it('stops: clears the timer, persisted flag, native loop and refreshes challenges', async () => {
            const onChallengesRefresh = jest.fn();
            renderProvider({ onChallengesRefresh });
            await act(async () => {
                await ctx.start();
            });
            onChallengesRefresh.mockClear();

            await act(async () => {
                await ctx.stop();
            });

            expect(window.api.setCancelVoting).toHaveBeenLastCalledWith(true);
            expect(window.api.setSetting).toHaveBeenLastCalledWith('autovoteRunning', false);
            expect(foregroundService.stop).toHaveBeenCalledTimes(1);
            expect(onChallengesRefresh).toHaveBeenCalledTimes(1);
            expect(ctx.running).toBe(false);
            expect(ctx.nextRunAt).toBeNull();

            // The cleared timer never fires another cycle.
            await act(async () => {
                await jest.advanceTimersByTimeAsync(30 * MIN);
            });
            expect(window.api.runVotingCycle).toHaveBeenCalledTimes(1);

            // Stopping when already stopped is a no-op.
            await act(async () => {
                await ctx.stop();
            });
            expect(window.api.setCancelVoting).toHaveBeenCalledTimes(2);
        });

        it('hands off to the native plugin when available and tolerates a failing flag write', async () => {
            nativeAutovote.start.mockResolvedValue({ available: true });
            nativeAutovote.stop.mockResolvedValue({ available: true });
            window.api.setSetting.mockRejectedValue(new Error('disk full'));
            renderProvider();

            await act(async () => {
                await ctx.start();
            });
            expect(ctx.running).toBe(true);
            expect(foregroundService.start).not.toHaveBeenCalled();

            await act(async () => {
                await ctx.stop();
            });
            expect(ctx.running).toBe(false);
            expect(foregroundService.stop).not.toHaveBeenCalled();
        });

        it('toggle flips between start and stop', async () => {
            renderProvider();
            await act(async () => {
                await ctx.toggle();
            });
            expect(ctx.running).toBe(true);
            await act(async () => {
                await ctx.toggle();
            });
            expect(ctx.running).toBe(false);
        });

        it('a stop during start setup skips the first cycle and leaves nothing armed', async () => {
            const gate = deferred();
            window.api.setCancelVoting.mockImplementationOnce(() => gate.promise);
            renderProvider();

            let startPromise;
            act(() => {
                startPromise = ctx.start();
            });
            await act(async () => {
                await ctx.stop();
            });
            await act(async () => {
                gate.resolve();
                await startPromise;
            });

            expect(window.api.runVotingCycle).not.toHaveBeenCalled();
            expect(ctx.running).toBe(false);
            expect(ctx.nextRunAt).toBeNull();
        });

        it('a stop while the first cycle is in flight discards its result', async () => {
            const gate = deferred();
            window.api.runVotingCycle.mockImplementationOnce(() => gate.promise);
            const onChallengesRefresh = jest.fn();
            renderProvider({ onChallengesRefresh });

            let startPromise;
            await act(async () => {
                startPromise = ctx.start();
                await jest.advanceTimersByTimeAsync(0);
            });
            await act(async () => {
                await ctx.stop();
            });
            onChallengesRefresh.mockClear();
            await act(async () => {
                gate.resolve({ success: true });
                await startPromise;
            });

            expect(ctx.cycles).toBe(0);
            expect(onChallengesRefresh).not.toHaveBeenCalled();
        });

        it('start replaces a timer armed by a rearm that raced the first cycle', async () => {
            const gate = deferred();
            window.api.runVotingCycle.mockImplementationOnce(() => gate.promise);
            renderProvider();

            let startPromise;
            await act(async () => {
                startPromise = ctx.start();
                await jest.advanceTimersByTimeAsync(0);
            });
            // Running, no timer yet → rearm arms one.
            await act(async () => {
                await ctx.rearmSchedule();
            });
            await act(async () => {
                gate.resolve({ success: true });
                await startPromise;
            });

            // Exactly one chain survives: one cycle per 5-minute period.
            await act(async () => {
                await jest.advanceTimersByTimeAsync(5 * MIN + 1_000);
            });
            expect(window.api.runVotingCycle).toHaveBeenCalledTimes(2);
        });

        it('clears the armed timer on unmount', async () => {
            renderProvider();
            await act(async () => {
                await ctx.start();
            });
            view.unmount();
            view = null;
            ctx = null;
            await act(async () => {
                await jest.advanceTimersByTimeAsync(30 * MIN);
            });
            expect(window.api.runVotingCycle).toHaveBeenCalledTimes(1);
        });

        it('unmounts cleanly when nothing was ever armed', () => {
            renderProvider();
            expect(() => view.unmount()).not.toThrow();
            view = null;
        });
    });

    describe('voting cycle outcomes', () => {
        const startAndRead = async () => {
            await act(async () => {
                await ctx.start();
            });
            return { error: ctx.error, status: ctx.status, cycles: ctx.cycles };
        };

        it('reports "Not logged in" when there is no token', async () => {
            window.api.getSettings.mockResolvedValue({});
            renderProvider();
            expect(await startAndRead()).toEqual({ error: 'Not logged in', status: 'Error', cycles: 0 });
            expect(window.api.runVotingCycle).not.toHaveBeenCalled();
        });

        it('surfaces the cycle error message', async () => {
            window.api.runVotingCycle.mockResolvedValue({ success: false, error: 'API request failed' });
            renderProvider();
            expect(await startAndRead()).toMatchObject({ error: 'API request failed', status: 'Error' });
        });

        it('falls back to "Voting failed" for an unsuccessful result without a message', async () => {
            window.api.runVotingCycle.mockResolvedValue(undefined);
            renderProvider();
            expect(await startAndRead()).toMatchObject({ error: 'Voting failed' });
        });

        it('reports a thrown error message', async () => {
            window.api.runVotingCycle.mockRejectedValue(new Error('network down'));
            renderProvider();
            expect(await startAndRead()).toMatchObject({ error: 'network down' });
        });

        it('falls back to "Voting error" for a thrown value without a message', async () => {
            window.api.runVotingCycle.mockRejectedValue({});
            renderProvider();
            expect(await startAndRead()).toMatchObject({ error: 'Voting error' });
        });

        it('a success without a challenge list makes the chain fetch fresh', async () => {
            window.api.runVotingCycle.mockResolvedValue({ success: true });
            renderProvider();
            expect(await startAndRead()).toMatchObject({ error: null, cycles: 1 });
            expect(window.api.getActiveChallenges).toHaveBeenCalledWith('tok');
        });
    });

    describe('auto-resume on mount', () => {
        it('resumes a persisted running session when logged in', async () => {
            window.api.getSetting.mockResolvedValue(true);
            renderProvider();
            await flush();
            expect(window.api.getSetting).toHaveBeenCalledWith('autovoteRunning');
            expect(ctx.running).toBe(true);
            expect(window.api.runVotingCycle).toHaveBeenCalledTimes(1);
        });

        it('does not resume without a token', async () => {
            window.api.getSetting.mockResolvedValue(true);
            window.api.getSettings.mockResolvedValue(null);
            renderProvider();
            await flush();
            expect(ctx.running).toBe(false);
        });

        it('stays stopped when reading the flag fails', async () => {
            window.api.getSetting.mockRejectedValue(new Error('io'));
            renderProvider();
            await flush();
            expect(ctx.running).toBe(false);
            expect(window.api.getSettings).not.toHaveBeenCalled();
        });
    });

    describe('cadence-chain transport', () => {
        it('wires settings, challenge fetch and the last-minute frequency over IPC', async () => {
            renderProvider();
            const deps = captured.chainDeps;
            await deps.loadSettings();
            expect(window.api.getSettings).toHaveBeenCalled();
            await deps.fetchChallenges({ token: 'abc' });
            expect(window.api.getActiveChallenges).toHaveBeenCalledWith('abc');
            await expect(deps.resolveLastMinuteCheckMinutes()).resolves.toBe(1);
            expect(window.api.getEffectiveSetting).toHaveBeenCalledWith('lastMinuteCheckFrequency', 'global');
        });

        it('logs non-normal cadence lines only, best-effort', () => {
            renderProvider();
            const { log } = captured.chainDeps;
            expect(log.cadence('normal', 'quiet')).toBeUndefined();
            log.cadence('last-minute', 'loud');
            expect(window.api.logDebug).toHaveBeenCalledWith('loud');
            expect(window.api.logDebug).toHaveBeenCalledTimes(1);

            const saved = window.api.logDebug;
            delete window.api.logDebug;
            try {
                expect(() => log.cadence('scheduled', 'no sink')).not.toThrow();
            } finally {
                window.api.logDebug = saved;
            }
        });

        it('formats decision and cycle errors for either Errors or bare values', () => {
            renderProvider();
            const { log } = captured.chainDeps;
            log.decisionError(new Error('bad math'));
            expect(window.api.logWarning).toHaveBeenLastCalledWith(expect.stringMatching(/: bad math$/));
            log.decisionError('plain');
            expect(window.api.logWarning).toHaveBeenLastCalledWith(expect.stringMatching(/: plain$/));

            log.cycleError(new Error('boom'));
            expect(window.api.logWarning).toHaveBeenLastCalledWith('Voting cycle failed: boom');
            log.cycleError('str');
            expect(window.api.logWarning).toHaveBeenLastCalledWith('Voting cycle failed: str');
            log.cycleError(undefined);
            expect(window.api.logWarning).toHaveBeenLastCalledWith('Voting cycle failed: undefined');

            log.overslept(120_000, 60_000);
            expect(window.api.logWarning).toHaveBeenCalledTimes(6);

            const saved = window.api.logWarning;
            delete window.api.logWarning;
            try {
                expect(() => log.cycleError(new Error('x'))).not.toThrow();
                expect(() => log.overslept(1, 1)).not.toThrow();
            } finally {
                window.api.logWarning = saved;
            }
        });

        it('publishes the next run as an absolute instant, or clears it', async () => {
            renderProvider();
            const { onScheduled } = captured.chainDeps;
            const before = Date.now();
            act(() => onScheduled(1_000));
            expect(ctx.nextRunAt).toBe(before + 1_000);
            act(() => onScheduled(null));
            expect(ctx.nextRunAt).toBeNull();
        });
    });

    describe('deadline notifier wiring', () => {
        it('is wired on Electron with IPC-backed deps', async () => {
            renderProvider();
            expect(captured.chainDeps.onCycleChallenges).toEqual(expect.any(Function));
            const deps = captured.notifierDeps;

            await deps.getSettings();
            expect(window.api.getSettings).toHaveBeenCalled();
            await deps.getDeadlineActions({ id: 7 });
            expect(window.api.getDeadlineActions).toHaveBeenCalledWith({ id: 7 });
            deps.log('note');
            expect(window.api.logDebug).toHaveBeenCalledWith('note');

            mockTranslator.t.mockImplementation((k) => `T:${k}`);
            expect(deps.translate('a.b')).toBe('T:a.b');
            expect(mockTranslator.t).toHaveBeenCalledWith('a.b');
            mockTranslator.t.mockImplementation((k) => k);

            const savedLog = window.api.logDebug;
            try {
                delete window.api.logDebug;
                expect(() => deps.log('silent')).not.toThrow();
            } finally {
                window.api.logDebug = savedLog;
            }
        });

        it('is not wired on native Android (the foreground service owns notifications)', () => {
            globalThis.Capacitor = { isNativePlatform: () => true };
            renderProvider();
            expect(captured.notifierDeps).toBeNull();
            expect(captured.chainDeps.onCycleChallenges).toBeUndefined();
        });

        it('treats a Capacitor global without isNativePlatform as non-native', () => {
            globalThis.Capacitor = {};
            renderProvider();
            expect(captured.chainDeps.onCycleChallenges).toEqual(expect.any(Function));
        });
    });

    describe('context value memoization', () => {
        let renders;
        const Consumer = memo(function Consumer() {
            renders++;
            ctx = useAutovote();
            return null;
        });
        const Host = ({ onChallengesRefresh }) => (
            <AutovoteProvider onChallengesRefresh={onChallengesRefresh}>
                <Consumer />
            </AutovoteProvider>
        );

        beforeEach(() => {
            renders = 0;
        });

        it('keeps the value (and so its consumers) stable across an unrelated provider re-render', async () => {
            const refresh = jest.fn();
            const { rerender } = render(<Host onChallengesRefresh={refresh} />);
            await flush();
            const first = ctx;
            const rendersBefore = renders;

            rerender(<Host onChallengesRefresh={refresh} />);
            await flush();

            expect(renders).toBe(rendersBefore);
            expect(ctx).toBe(first);
        });

        it('publishes a new value when the state changes', async () => {
            render(<Host onChallengesRefresh={jest.fn()} />);
            await flush();
            const first = ctx;
            const rendersBefore = renders;

            await act(async () => {
                await ctx.start();
            });

            expect(renders).toBeGreaterThan(rendersBefore);
            expect(ctx).not.toBe(first);
            expect(ctx.running).toBe(true);
        });

        it('publishes new controls when onChallengesRefresh changes', async () => {
            const { rerender } = render(<Host onChallengesRefresh={jest.fn()} />);
            await flush();
            const first = ctx;

            rerender(<Host onChallengesRefresh={jest.fn()} />);
            await flush();

            expect(ctx).not.toBe(first);
            expect(ctx.stop).not.toBe(first.stop);
            expect(ctx.running).toBe(first.running);
        });
    });
});
