/**
 * ChallengesProvider (sorting + 60s auto-refresh gated on autovote) and the
 * ChallengesSection view on top of it. The data hook is mocked so each state
 * (loading / empty / error / list) can be driven directly; ChallengeCard is a
 * stub exposing the callbacks the section hands it.
 */

import { render, screen, fireEvent, act } from './helpers/test-utils';
import { render as bareRender } from '@testing-library/preact';
import { ChallengesProvider, useChallenges } from '@/contexts/ChallengesContext';
import { ChallengesSection } from '@/components/app/ChallengesSection';
import { useActiveChallenges } from '@/api/useActiveChallenges';
import { mockApi } from './helpers/setup';

jest.mock('@/api/useActiveChallenges', () => ({ useActiveChallenges: jest.fn() }));

jest.mock('@/components/app/ChallengeCard', () => ({
    ChallengeCard: ({ challenge, defaultCompact, bankroll, onVoteComplete, onCurrencySpent, onSettingsClick }) => (
        <div
            data-testid="card"
            data-id={challenge.id}
            data-compact={String(defaultCompact)}
            data-bankroll={String(bankroll)}
        >
            {challenge.title}
            <button onClick={onVoteComplete}>vote-{challenge.id}</button>
            <button onClick={onCurrencySpent}>spend-{challenge.id}</button>
            <button onClick={() => onSettingsClick(challenge)}>settings-{challenge.id}</button>
        </div>
    ),
}));

const now = Math.floor(Date.now() / 1000);
const LATE = { id: 2, title: 'Late', close_time: now + 9000, start_time: now - 100 };
const EARLY = { id: 1, title: 'Early', close_time: now + 3000, start_time: now - 100 };

describe('ChallengesProvider + ChallengesSection', () => {
    let hookState;
    let refetch;
    let settingsListener;

    const setHook = (patch) => {
        hookState = { ...hookState, ...patch };
    };

    const renderSection = (props = {}, providerProps = {}) =>
        render(
            <ChallengesProvider autovoteRunning={false} {...providerProps}>
                <ChallengesSection isLoggedIn timezone="UTC" onChallengeSettingsClick={jest.fn()} {...props} />
            </ChallengesProvider>,
        );

    const settle = () =>
        act(async () => {
            for (let i = 0; i < 10; i++) await Promise.resolve();
        });

    beforeEach(() => {
        window.api = mockApi;
        refetch = jest.fn();
        hookState = { data: [LATE, EARLY], loading: false, error: null, refetch };
        useActiveChallenges.mockImplementation(() => hookState);
        mockApi.getGlobalDefault.mockResolvedValue(false);
        mockApi.setGlobalDefault.mockResolvedValue(undefined);
        mockApi.voteAllChallengesManual.mockResolvedValue({ success: true });
        mockApi.runVotingCycle.mockResolvedValue({ success: true });
        settingsListener = null;
        mockApi.onSettingsChanged.mockImplementation((cb) => {
            settingsListener = cb;
            return jest.fn();
        });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('ChallengesProvider', () => {
        let ctx;
        function Capture() {
            ctx = useChallenges();
            return null;
        }

        it('useChallenges throws outside the provider', () => {
            const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
            expect(() => bareRender(<Capture />)).toThrow('useChallenges must be used within a ChallengesProvider');
            spy.mockRestore();
        });

        it('sorts challenges by close time and forwards the running flag to the hook', () => {
            bareRender(
                <ChallengesProvider autovoteRunning>
                    <Capture />
                </ChallengesProvider>,
            );
            expect(useActiveChallenges).toHaveBeenCalledWith(true);
            expect(ctx.challenges.map((c) => c.id)).toEqual([1, 2]);
            expect(ctx.refetch).toBe(refetch);
        });

        it.each([[null], [[]]])('exposes an empty list for %p data', (data) => {
            setHook({ data });
            bareRender(
                <ChallengesProvider>
                    <Capture />
                </ChallengesProvider>,
            );
            expect(ctx.challenges).toEqual([]);
        });

        it('auto-refreshes every 60s while stopped, pauses while running, clears on unmount', () => {
            jest.useFakeTimers();
            const view = bareRender(
                <ChallengesProvider autovoteRunning={false}>
                    <Capture />
                </ChallengesProvider>,
            );
            act(() => jest.advanceTimersByTime(60_000));
            expect(refetch).toHaveBeenCalledWith(true);
            expect(refetch).toHaveBeenCalledTimes(1);

            view.rerender(
                <ChallengesProvider autovoteRunning>
                    <Capture />
                </ChallengesProvider>,
            );
            act(() => jest.advanceTimersByTime(180_000));
            expect(refetch).toHaveBeenCalledTimes(1);

            view.rerender(
                <ChallengesProvider autovoteRunning={false}>
                    <Capture />
                </ChallengesProvider>,
            );
            act(() => jest.advanceTimersByTime(60_000));
            expect(refetch).toHaveBeenCalledTimes(2);

            view.unmount();
            act(() => jest.advanceTimersByTime(120_000));
            expect(refetch).toHaveBeenCalledTimes(2);
        });

        it('mounting already running never arms the interval', () => {
            jest.useFakeTimers();
            const view = bareRender(
                <ChallengesProvider autovoteRunning>
                    <Capture />
                </ChallengesProvider>,
            );
            act(() => jest.advanceTimersByTime(120_000));
            expect(refetch).not.toHaveBeenCalled();
            view.unmount();
        });
    });

    describe('ChallengesSection', () => {
        it('shows a spinner while the first load is pending', () => {
            setHook({ data: [], loading: true });
            renderSection();
            expect(screen.getByLabelText('Loading')).toBeTruthy();
            expect(screen.queryByText('app.noActiveChallenges')).toBeNull();
        });

        it('shows the empty state for a logged-in user', () => {
            setHook({ data: [] });
            renderSection();
            expect(screen.getByText('app.noActiveChallenges')).toBeTruthy();
            expect(screen.queryByRole('alert')).toBeNull();
        });

        it('asks a logged-out user to log in, without a retry button on error', () => {
            setHook({ data: [], error: new Error('x') });
            renderSection({ isLoggedIn: false });
            expect(screen.getByText('app.pleaseLogin')).toBeTruthy();
            expect(screen.getByText('errors.fetchFailed')).toBeTruthy();
            expect(screen.queryByText('common.refresh')).toBeNull();
        });

        it('offers a retry after a failed fetch with no data', () => {
            setHook({ data: [], error: new Error('x') });
            renderSection();
            fireEvent.click(screen.getByText('common.refresh'));
            expect(refetch).toHaveBeenCalledWith();
        });

        it('renders sorted cards with the action bar, error banner and default bankroll', async () => {
            setHook({ error: new Error('stale') });
            renderSection();
            await settle();
            const cards = screen.getAllByTestId('card');
            expect(cards.map((c) => c.dataset.id)).toEqual(['1', '2']);
            expect(cards[0].dataset.bankroll).toBe('null');
            expect(cards[0].dataset.compact).toBe('false');
            expect(screen.getByText('errors.fetchFailed')).toBeTruthy();
            expect(screen.getByText('app.voteAll')).toBeTruthy();
            expect(screen.getByText('app.run')).toBeTruthy();
            expect(mockApi.getGlobalDefault).toHaveBeenCalledWith('compactCards');
        });

        it('hides the manual action buttons while autovote runs', () => {
            renderSection({ autovoteRunning: true });
            expect(screen.queryByText('app.voteAll')).toBeNull();
            expect(screen.queryByText('app.refresh')).toBeNull();
            expect(screen.getByText('app.compact')).toBeTruthy();
        });

        it('Refresh refetches with cleanup', () => {
            renderSection();
            fireEvent.click(screen.getByText('app.refresh'));
            expect(refetch).toHaveBeenCalledWith();
        });

        it('disables Refresh during a background load', () => {
            setHook({ loading: true });
            renderSection();
            expect(screen.getByText('app.refresh').closest('button').disabled).toBe(true);
        });

        it('Vote All and Run call IPC and refetch without cleanup on success', async () => {
            renderSection();
            await act(async () => {
                fireEvent.click(screen.getByText('app.voteAll'));
            });
            await settle();
            expect(mockApi.voteAllChallengesManual).toHaveBeenCalled();
            expect(refetch).toHaveBeenLastCalledWith(true);

            refetch.mockClear();
            await act(async () => {
                fireEvent.click(screen.getByText('app.run'));
            });
            await settle();
            expect(mockApi.runVotingCycle).toHaveBeenCalled();
            expect(refetch).toHaveBeenCalledWith(true);
        });

        it('card callbacks refetch, refresh the bankroll and open settings', () => {
            const onBankrollChanged = jest.fn();
            const onChallengeSettingsClick = jest.fn();
            renderSection({ onBankrollChanged, onChallengeSettingsClick, bankroll: { coins: 5 } });

            expect(screen.getAllByTestId('card')[0].dataset.bankroll).toBe('[object Object]');
            fireEvent.click(screen.getByText('vote-1'));
            expect(refetch).toHaveBeenLastCalledWith(true);
            fireEvent.click(screen.getByText('spend-1'));
            expect(refetch).toHaveBeenCalledTimes(2);
            expect(onBankrollChanged).toHaveBeenCalledTimes(1);
            fireEvent.click(screen.getByText('settings-2'));
            expect(onChallengeSettingsClick).toHaveBeenCalledWith(LATE);
        });

        it('a currency spend without a bankroll listener still refetches', () => {
            renderSection();
            fireEvent.click(screen.getByText('spend-1'));
            expect(refetch).toHaveBeenCalledWith(true);
        });

        it('toggles the global compact default and re-keys the cards', async () => {
            renderSection();
            await settle();
            await act(async () => {
                fireEvent.click(screen.getByText('app.compact'));
            });
            expect(mockApi.setGlobalDefault).toHaveBeenCalledWith('compactCards', true);
            expect(screen.getByText('app.details')).toBeTruthy();
            expect(screen.getAllByTestId('card')[0].dataset.compact).toBe('true');

            await act(async () => {
                fireEvent.click(screen.getByText('app.details'));
            });
            expect(mockApi.setGlobalDefault).toHaveBeenLastCalledWith('compactCards', false);
            expect(screen.getByText('app.compact')).toBeTruthy();
        });

        it('leaves the toggle unchanged when persisting the default fails', async () => {
            mockApi.setGlobalDefault.mockRejectedValue(new Error('io'));
            renderSection();
            await settle();
            await act(async () => {
                fireEvent.click(screen.getByText('app.compact'));
            });
            expect(screen.getByText('app.compact')).toBeTruthy();
        });

        it('starts compact when the stored default is on, and resyncs on settings-changed', async () => {
            mockApi.getGlobalDefault.mockResolvedValue(true);
            renderSection();
            await settle();
            expect(screen.getByText('app.details')).toBeTruthy();

            mockApi.getGlobalDefault.mockResolvedValue(false);
            await act(async () => {
                settingsListener();
            });
            await settle();
            expect(screen.getByText('app.compact')).toBeTruthy();
            expect(mockApi.getGlobalDefault).toHaveBeenCalledTimes(2);
        });

        it('falls back to detailed cards when reading the default fails', async () => {
            mockApi.getGlobalDefault.mockRejectedValue(new Error('io'));
            renderSection();
            await settle();
            expect(screen.getByText('app.compact')).toBeTruthy();
        });

        it('unsubscribes from settings-changed on unmount', () => {
            const view = renderSection();
            const off = mockApi.onSettingsChanged.mock.results[0].value;
            view.unmount();
            expect(off).toHaveBeenCalledTimes(1);
        });

        it('works on a host without settings-change events', () => {
            const saved = mockApi.onSettingsChanged;
            delete mockApi.onSettingsChanged;
            try {
                const view = renderSection();
                expect(screen.getAllByTestId('card')).toHaveLength(2);
                expect(() => view.unmount()).not.toThrow();
            } finally {
                mockApi.onSettingsChanged = saved;
            }
        });
    });
});
