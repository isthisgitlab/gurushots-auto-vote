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
import * as foregroundService from '../../src/ts/services/ForegroundServiceController';
import * as nativeAutovote from '../../src/ts/services/NativeAutovoteBridge';
import { mockApi, mockTranslator } from './helpers/setup';
import type { ComponentProps } from 'preact';
import type { RenderResult } from '@testing-library/preact';
import type * as cadenceChainModule from '../../src/ts/scheduling/cadenceChain';
import type * as deadlineNotifierModule from '../../src/ts/react/notifications/deadlineNotifier';
import type { RendererGlobals } from '../../src/ts/types/capacitor';
import type { Challenge } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

type ChainDeps = Parameters<typeof cadenceChainModule.createCadenceChain>[0];
type NotifierDeps = Parameters<typeof deadlineNotifierModule.createDeadlineNotifier>[0];

const captured: { chainDeps: ChainDeps | null; notifierDeps: NotifierDeps | null } = {
    chainDeps: null,
    notifierDeps: null,
};
const g = globalThis as RendererGlobals;

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

jest.mock('../../src/ts/react/notifications/deadlineNotifier', () => {
    const actual = jest.requireActual<typeof deadlineNotifierModule>(
        '../../src/ts/react/notifications/deadlineNotifier',
    );
    return {
        ...actual,
        createDeadlineNotifier: (deps: NotifierDeps) => {
            captured.notifierDeps = deps;
            return actual.createDeadlineNotifier(deps);
        },
    };
});

jest.mock('../../src/ts/services/ForegroundServiceController', () => ({
    __esModule: true,
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    update: jest.fn(),
}));

jest.mock('../../src/ts/services/NativeAutovoteBridge', () => ({
    __esModule: true,
    start: jest.fn().mockResolvedValue({ available: false }),
    stop: jest.fn().mockResolvedValue({ available: false }),
}));

const MIN = 60_000;

const deferred = () => {
    let resolve!: (value?: unknown) => void;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
};

describe('AutovoteContext', () => {
    let ctx: ReturnType<typeof useAutovote>;
    let view: RenderResult | null;

    function Capture() {
        ctx = useAutovote();
        return null;
    }

    const renderProvider = (props: Omit<ComponentProps<typeof AutovoteProvider>, 'children'> = {}) => {
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
        window.api = invalid(mockApi);
        captured.chainDeps = null;
        captured.notifierDeps = null;
        delete g.Capacitor;

        const now = Math.floor(Date.now() / 1000);
        const far = invalid<Challenge[]>([{ id: 1, title: 'Far', type: 'regular', close_time: now + 100_000 }]);
        jest.mocked(window.api.getSettings).mockResolvedValue(
            invalid({ hasToken: true, checkFrequencyMin: 5, checkFrequencyMax: 5 }),
        );
        jest.mocked(window.api.getSetting).mockResolvedValue(null);
        jest.mocked(window.api.setSetting).mockResolvedValue(invalid(undefined));
        jest.mocked(window.api.getActiveChallenges).mockResolvedValue({ challenges: far });
        jest.mocked(window.api.getEffectiveSetting).mockImplementation((key) =>
            Promise.resolve(key === 'lastMinuteCheckFrequency' ? 1 : 10),
        );
        jest.mocked(window.api.runVotingCycle).mockResolvedValue(invalid({ success: true, challenges: far }));
        jest.mocked(nativeAutovote.start).mockResolvedValue(invalid({ available: false }));
        jest.mocked(nativeAutovote.stop).mockResolvedValue(invalid({ available: false }));
    });

    afterEach(async () => {
        if (ctx?.running) {
            await act(async () => {
                await ctx.stop();
            });
        }
        view?.unmount();
        view = null;
        ctx = invalid(null);
        delete g.Capacitor;
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
            jest.mocked(nativeAutovote.start).mockResolvedValue(invalid({ available: true }));
            jest.mocked(nativeAutovote.stop).mockResolvedValue(invalid({ available: true }));
            jest.mocked(window.api.setSetting).mockRejectedValue(new Error('disk full'));
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
            jest.mocked(window.api.setCancelVoting).mockImplementationOnce(() => invalid(gate.promise));
            renderProvider();

            let startPromise: Promise<void> | undefined;
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
            jest.mocked(window.api.runVotingCycle).mockImplementationOnce(() => invalid(gate.promise));
            const onChallengesRefresh = jest.fn();
            renderProvider({ onChallengesRefresh });

            let startPromise: Promise<void> | undefined;
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
            jest.mocked(window.api.runVotingCycle).mockImplementationOnce(() => invalid(gate.promise));
            renderProvider();

            let startPromise: Promise<void> | undefined;
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
            view!.unmount();
            view = null;
            ctx = invalid(null);
            await act(async () => {
                await jest.advanceTimersByTimeAsync(30 * MIN);
            });
            expect(window.api.runVotingCycle).toHaveBeenCalledTimes(1);
        });

        it('unmounts cleanly when nothing was ever armed', () => {
            renderProvider();
            expect(() => view!.unmount()).not.toThrow();
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
            jest.mocked(window.api.getSettings).mockResolvedValue(invalid({}));
            renderProvider();
            expect(await startAndRead()).toEqual({ error: 'Not logged in', status: 'Error', cycles: 0 });
            expect(window.api.runVotingCycle).not.toHaveBeenCalled();
        });

        it('surfaces the cycle error message', async () => {
            jest.mocked(window.api.runVotingCycle).mockResolvedValue({ success: false, error: 'API request failed' });
            renderProvider();
            expect(await startAndRead()).toMatchObject({ error: 'API request failed', status: 'Error' });
        });

        it('falls back to "Voting failed" for an unsuccessful result without a message', async () => {
            jest.mocked(window.api.runVotingCycle).mockResolvedValue(invalid(undefined));
            renderProvider();
            expect(await startAndRead()).toMatchObject({ error: 'Voting failed' });
        });

        it('reports a thrown error message', async () => {
            jest.mocked(window.api.runVotingCycle).mockRejectedValue(new Error('network down'));
            renderProvider();
            expect(await startAndRead()).toMatchObject({ error: 'network down' });
        });

        it.each([[{}], [null]])('falls back to "Voting error" for a thrown %p without a message', async (thrown) => {
            jest.mocked(window.api.runVotingCycle).mockRejectedValue(thrown);
            renderProvider();
            expect(await startAndRead()).toMatchObject({ error: 'Voting error' });
        });

        it('a success without a challenge list makes the chain fetch fresh', async () => {
            jest.mocked(window.api.runVotingCycle).mockResolvedValue(invalid({ success: true }));
            renderProvider();
            expect(await startAndRead()).toMatchObject({ error: null, cycles: 1 });
            expect(window.api.getActiveChallenges).toHaveBeenCalledWith();
        });
    });

    describe('auto-resume on mount', () => {
        it('resumes a persisted running session when logged in', async () => {
            jest.mocked(window.api.getSetting).mockResolvedValue(true);
            renderProvider();
            await flush();
            expect(window.api.getSetting).toHaveBeenCalledWith('autovoteRunning');
            expect(ctx.running).toBe(true);
            expect(window.api.runVotingCycle).toHaveBeenCalledTimes(1);
        });

        it('does not resume without a token', async () => {
            jest.mocked(window.api.getSetting).mockResolvedValue(true);
            jest.mocked(window.api.getSettings).mockResolvedValue(invalid(null));
            renderProvider();
            await flush();
            expect(ctx.running).toBe(false);
        });

        it('stays stopped when reading the flag fails', async () => {
            jest.mocked(window.api.getSetting).mockRejectedValue(new Error('io'));
            renderProvider();
            await flush();
            expect(ctx.running).toBe(false);
            expect(window.api.getSettings).not.toHaveBeenCalled();
        });
    });

    describe('cadence-chain transport', () => {
        it('wires settings, challenge fetch and the last-minute frequency over IPC', async () => {
            renderProvider();
            const deps = captured.chainDeps!;
            await deps.loadSettings();
            expect(window.api.getSettings).toHaveBeenCalled();
            await deps.fetchChallenges(invalid({}));
            expect(window.api.getActiveChallenges).toHaveBeenCalledWith();
            await expect(deps.resolveLastMinuteCheckMinutes()).resolves.toBe(1);
            expect(window.api.getEffectiveSetting).toHaveBeenCalledWith('lastMinuteCheckFrequency', 'global');
        });

        it('logs non-normal cadence lines only, best-effort', () => {
            renderProvider();
            const { log } = captured.chainDeps!;
            expect(log.cadence('normal', 'quiet')).toBeUndefined();
            log.cadence('last-minute', 'loud');
            expect(window.api.logDebug).toHaveBeenCalledWith('loud');
            expect(window.api.logDebug).toHaveBeenCalledTimes(1);

            const saved = window.api.logDebug;
            delete invalid<{ logDebug?: unknown }>(window.api).logDebug;
            try {
                expect(() => log.cadence('scheduled', 'no sink')).not.toThrow();
            } finally {
                window.api.logDebug = saved;
            }
        });

        it('formats decision and cycle errors for either Errors or bare values', () => {
            renderProvider();
            const { log } = captured.chainDeps!;
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

            log.overslept!(120_000, 60_000);
            expect(window.api.logWarning).toHaveBeenCalledTimes(6);

            const saved = window.api.logWarning;
            delete invalid<{ logWarning?: unknown }>(window.api).logWarning;
            try {
                expect(() => log.cycleError(new Error('x'))).not.toThrow();
                expect(() => log.overslept!(1, 1)).not.toThrow();
            } finally {
                window.api.logWarning = saved;
            }
        });

        it('publishes the next run as an absolute instant, or clears it', async () => {
            renderProvider();
            const { onScheduled } = captured.chainDeps!;
            const before = Date.now();
            act(() => onScheduled!(1_000));
            expect(ctx.nextRunAt).toBe(before + 1_000);
            act(() => onScheduled!(null));
            expect(ctx.nextRunAt).toBeNull();
        });
    });

    describe('deadline notifier wiring', () => {
        it('is wired on Electron with IPC-backed deps', async () => {
            renderProvider();
            expect(captured.chainDeps!.onCycleChallenges).toEqual(expect.any(Function));
            const deps = captured.notifierDeps!;

            await deps.getSetting('notifyOnBoost');
            expect(window.api.getGlobalDefault).toHaveBeenCalledWith('notifyOnBoost');
            await deps.getDeadlineActions(invalid({ id: 7 }));
            expect(window.api.getDeadlineActions).toHaveBeenCalledWith({ id: 7 });
            deps.log!('note');
            expect(window.api.logDebug).toHaveBeenCalledWith('note');

            mockTranslator.t.mockImplementation((k) => `T:${k}`);
            expect(deps.translate('a.b')).toBe('T:a.b');
            expect(mockTranslator.t).toHaveBeenCalledWith('a.b');
            mockTranslator.t.mockImplementation((k) => k);

            const savedLog = window.api.logDebug;
            try {
                delete invalid<{ logDebug?: unknown }>(window.api).logDebug;
                expect(() => deps.log!('silent')).not.toThrow();
            } finally {
                window.api.logDebug = savedLog;
            }
        });

        it('is not wired on native Android (the foreground service owns notifications)', () => {
            g.Capacitor = { isNativePlatform: () => true };
            renderProvider();
            expect(captured.notifierDeps).toBeNull();
            expect(captured.chainDeps!.onCycleChallenges).toBeUndefined();
        });

        it('treats a Capacitor global without isNativePlatform as non-native', () => {
            g.Capacitor = {};
            renderProvider();
            expect(captured.chainDeps!.onCycleChallenges).toEqual(expect.any(Function));
        });
    });

    describe('context value memoization', () => {
        let renders: number;
        const Consumer = memo(function Consumer() {
            renders++;
            ctx = useAutovote();
            return null;
        });
        const Host = ({ onChallengesRefresh }: { onChallengesRefresh: () => void }) => (
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
