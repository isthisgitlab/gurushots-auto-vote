/**
 * AutovoteContext — the React adapter over the autovote controller: the
 * provider's public API, the deadline-notifier wiring, the context-value
 * memoization, the autovote:running-changed window event, and dispose on
 * unmount. The loop itself (start/stop lifecycle, cycle outcomes, the
 * auto-resume hold, rearm/revert, the chain transport) is covered directly
 * over the controller in tests/autovote/.
 *
 * The deadline-notifier factories and the cadence chain are wrapped (real
 * implementations underneath) so the injected deps can be asserted on. The
 * background host defaults to a mocked no-op host, so a start proves the
 * default host reaches the controller.
 */

import { memo } from 'react';
import { render, act } from '@testing-library/preact';
import { AutovoteProvider, useAutovote } from '@/contexts/AutovoteContext';
import { noopBackgroundHost } from '../../src/ts/react/contexts/noopBackgroundHost';
import { mockApi, mockTranslator, defaultTranslate } from './helpers/setup';
import { resetPlatformKind } from '../helpers/platformKind';
import { markPlatformKind } from '../../src/ts/platform/kind';
import type { ComponentProps } from 'preact';
import type { RenderResult } from '@testing-library/preact';
import type * as cadenceChainModule from '../../src/ts/scheduling/cadenceChain';
import type * as deadlineNotifierModule from '../../src/ts/react/notifications/deadlineNotifier';
import type * as scenarioNotifierModule from '../../src/ts/react/notifications/scenarioNotifier';
import type { Challenge } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

type ChainDeps = Parameters<typeof cadenceChainModule.createCadenceChain>[0];
type NotifierDeps = Parameters<typeof deadlineNotifierModule.createDeadlineNotifier>[0];
type ScenarioNotifierDeps = Parameters<typeof scenarioNotifierModule.createRendererScenarioNotifier>[0];

const captured: {
    chainDeps: ChainDeps | null;
    notifierDeps: NotifierDeps | null;
    scenarioDeps: ScenarioNotifierDeps | null;
} = {
    chainDeps: null,
    notifierDeps: null,
    scenarioDeps: null,
};

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

jest.mock('../../src/ts/react/notifications/scenarioNotifier', () => {
    const actual = jest.requireActual<typeof scenarioNotifierModule>(
        '../../src/ts/react/notifications/scenarioNotifier',
    );
    return {
        ...actual,
        createRendererScenarioNotifier: (deps: ScenarioNotifierDeps) => {
            captured.scenarioDeps = deps;
            return actual.createRendererScenarioNotifier(deps);
        },
    };
});

jest.mock('../../src/ts/react/contexts/noopBackgroundHost', () => ({
    __esModule: true,
    noopBackgroundHost: {
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
        status: jest.fn().mockResolvedValue({ running: false, available: false }),
    },
}));

const MIN = 60_000;

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

    // The mockApi wiring a start needs, beyond the setup file's defaults.
    const makeStartable = () => {
        const now = Math.floor(Date.now() / 1000);
        const far = invalid<Challenge[]>([{ id: 1, title: 'Far', type: 'regular', close_time: now + 100_000 }]);
        jest.mocked(window.api.getSettings).mockResolvedValue(
            invalid({ app: { checkFrequencyMin: 5, checkFrequencyMax: 5 }, hasToken: true }),
        );
        jest.mocked(window.api.getSetting).mockResolvedValue(null);
        jest.mocked(window.api.setSetting).mockResolvedValue(invalid(undefined));
        jest.mocked(window.api.getActiveChallenges).mockResolvedValue({ challenges: far });
        jest.mocked(window.api.getEffectiveSetting).mockImplementation((key) =>
            Promise.resolve(key === 'lastMinuteCheckFrequency' ? 1 : 10),
        );
        jest.mocked(window.api.runVotingCycle).mockResolvedValue(invalid({ success: true, challenges: far }));
        jest.mocked(window.api.getEnvironmentInfo).mockResolvedValue(invalid({ launchedAt: Date.now() - 600_000 }));
        jest.mocked(window.api.getGlobalDefault).mockResolvedValue(60);
    };

    beforeEach(() => {
        jest.useFakeTimers();
        window.api = invalid(mockApi);
        captured.chainDeps = null;
        captured.notifierDeps = null;
        captured.scenarioDeps = null;
        resetPlatformKind();
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
        resetPlatformKind();
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('useAutovote throws outside an AutovoteProvider', () => {
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => render(<Capture />)).toThrow('useAutovote must be used within an AutovoteProvider');
        spy.mockRestore();
    });

    it('the default background host is the no-op host, and a start reaches it', async () => {
        makeStartable();
        renderProvider();
        await act(async () => {
            await ctx.start();
        });
        expect(jest.mocked(noopBackgroundHost.start)).toHaveBeenCalledWith('app.autovoteNotificationPreparing');
        expect(ctx.running).toBe(true);
    });

    it('toggle flips between start and stop', async () => {
        makeStartable();
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

    describe('dispose on unmount', () => {
        it('a started provider unmounted runs no further cycle', async () => {
            makeStartable();
            const mounted = renderProvider();
            await act(async () => {
                await ctx.start();
            });
            expect(window.api.runVotingCycle).toHaveBeenCalledTimes(1);
            mounted.unmount();
            view = null;
            ctx = invalid(null);
            await act(async () => {
                await jest.advanceTimersByTimeAsync(30 * MIN);
            });
            expect(window.api.runVotingCycle).toHaveBeenCalledTimes(1);
        });

        it('a held resume arms through the host timers and never fires after the unmount', async () => {
            makeStartable();
            jest.mocked(window.api.getSetting).mockResolvedValue(true);
            jest.mocked(window.api.getGlobalDefault).mockResolvedValue(60);
            jest.mocked(window.api.getEnvironmentInfo).mockResolvedValue(invalid({ launchedAt: Date.now() - 10_000 }));
            const mounted = renderProvider();
            await flush();
            expect(ctx.pendingStartAt).toBe(Date.now() + 50_000);
            expect(ctx.running).toBe(false);
            mounted.unmount();
            view = null;
            ctx = invalid(null);
            await act(async () => {
                await jest.advanceTimersByTimeAsync(60_000);
            });
            expect(window.api.runVotingCycle).not.toHaveBeenCalled();
        });

        it('unmounts cleanly when nothing was ever armed', () => {
            renderProvider();
            expect(() => view!.unmount()).not.toThrow();
            view = null;
        });

        it('a remount runs exactly one chain, and the fresh mount counts from zero', async () => {
            makeStartable();
            const first = renderProvider();
            await act(async () => {
                await ctx.start();
            });
            expect(ctx.cycles).toBe(1);
            first.unmount();

            // The fresh mount builds a fresh controller: its state is its own,
            // not inherited from the unmounted provider.
            renderProvider();
            expect(ctx.cycles).toBe(0);
            await act(async () => {
                await ctx.start();
            });
            expect(ctx.cycles).toBe(1);

            // Exactly one chain is alive across the remount: one cycle per
            // cadence period — a leaked first chain would fire it twice.
            await act(async () => {
                await jest.advanceTimersByTimeAsync(5 * MIN + 1_000);
            });
            expect(window.api.runVotingCycle).toHaveBeenCalledTimes(3);
            expect(ctx.cycles).toBe(2);
        });
    });

    describe('autovote:running-changed', () => {
        it('carries the initial false on mount, true on start and false on stop', async () => {
            makeStartable();
            const events: unknown[] = [];
            const handler = (e: Event) => events.push((e as CustomEvent<unknown>).detail);
            window.addEventListener('autovote:running-changed', handler);
            try {
                const mounted = renderProvider();
                await flush();
                expect(events).toEqual([false]);

                await act(async () => {
                    await ctx.start();
                });
                expect(events.at(-1)).toBe(true);

                await act(async () => {
                    await ctx.stop();
                });
                expect(events.at(-1)).toBe(false);
                mounted.unmount();
                view = null;
                ctx = invalid(null);
            } finally {
                window.removeEventListener('autovote:running-changed', handler);
            }
        });
    });

    describe('deadline notifier wiring', () => {
        it('is wired on Electron with IPC-backed deps', async () => {
            makeStartable();
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
            mockTranslator.t.mockImplementation(defaultTranslate);
            expect(deps.translate('app.timeLeft', { time: '5m' })).toBe('5m left');
            expect(deps.translate('app.timeLeft')).toBe('{time} left');
            expect(mockTranslator.t).toHaveBeenCalledWith('app.timeLeft', { time: '5m' });
            // The same shared translate reaches the scenario notifier.
            expect(captured.scenarioDeps!.translate('app.timeLeft', { time: '5m' })).toBe('5m left');
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
            markPlatformKind('capacitor');
            renderProvider();
            expect(captured.notifierDeps).toBeNull();
            expect(captured.chainDeps!.onCycleChallenges).toBeUndefined();
        });

        it('the chain log stays best-effort when the bridge has no log sink', () => {
            makeStartable();
            renderProvider();
            const { log } = captured.chainDeps!;
            const saved = window.api.logDebug;
            delete invalid<{ logDebug?: unknown }>(window.api).logDebug;
            try {
                expect(() => log.cadence('scheduled', 'no sink')).not.toThrow();
                expect(() => log.cycleError(new Error('x'))).not.toThrow();
                expect(() => log.overslept!(1, 1)).not.toThrow();
            } finally {
                window.api.logDebug = saved;
            }
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
            makeStartable();
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

        it('keeps the controls stable when only onChallengesRefresh changes', async () => {
            const { rerender } = render(<Host onChallengesRefresh={jest.fn()} />);
            await flush();
            const first = ctx;

            rerender(<Host onChallengesRefresh={jest.fn()} />);
            await flush();

            // The controller reads the latest refresh identity at call time
            // (through the host), so neither the value nor the controls churn.
            expect(ctx).toBe(first);
            expect(ctx.stop).toBe(first.stop);
            expect(ctx.running).toBe(first.running);
        });
    });
});
