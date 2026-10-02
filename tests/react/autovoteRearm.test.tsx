/**
 * rearmSchedule: settings saved while autovote runs must re-arm the cadence
 * timer immediately.
 *
 * The armed timer was computed from the old settings; without a re-arm, a
 * shortened check frequency (or a newly-configured threshold / scheduled-fill
 * window) is slept past until the current — possibly hours-long — wait
 * elapses. The settings modals call rearmSchedule() on save; these tests pin
 * that wiring.
 */

import { render, act } from '@testing-library/preact';
import { AutovoteProvider, useAutovote } from '@/contexts/AutovoteContext';
import { mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';

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

describe('AutovoteContext — rearmSchedule after a settings change', () => {
    let ctx: ReturnType<typeof useAutovote> | null;
    let activeChallenges: Array<{ id: number; title: string; type: string; close_time: number }>;
    let checkFrequencyMinutes: number;

    function Capture() {
        ctx = useAutovote();
        return null;
    }

    const renderProvider = () =>
        render(
            <AutovoteProvider>
                <Capture />
            </AutovoteProvider>,
        );

    beforeEach(() => {
        jest.useFakeTimers();
        window.api = invalid(mockApi);

        const now = Math.floor(Date.now() / 1000);
        // Challenge far from closing → normal cadence, no threshold capping.
        activeChallenges = [{ id: 1, title: 'Far Away', type: 'regular', close_time: now + 100_000 }];
        checkFrequencyMinutes = 5;

        jest.mocked(window.api.getSettings).mockImplementation(async () =>
            invalid({
                hasToken: true,
                checkFrequencyMin: checkFrequencyMinutes,
                checkFrequencyMax: checkFrequencyMinutes,
            }),
        );
        jest.mocked(window.api.getSetting).mockResolvedValue(null); // no auto-resume on mount
        jest.mocked(window.api.getActiveChallenges).mockImplementation(async () =>
            invalid({ challenges: activeChallenges }),
        );
        jest.mocked(window.api.getEffectiveSetting).mockImplementation((key) =>
            Promise.resolve(key === 'lastMinuteCheckFrequency' ? 1 : 10),
        );
        jest.mocked(window.api.runVotingCycle).mockResolvedValue(
            invalid({ success: true, challenges: activeChallenges }),
        );
    });

    afterEach(async () => {
        if (ctx) {
            await act(async () => {
                await ctx!.stop();
            });
        }
        ctx = null;
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('re-arms the timer with the new settings instead of finishing the old wait', async () => {
        renderProvider();

        await act(async () => {
            await ctx!.start();
        });
        const cyclesAfterStart = jest.mocked(window.api.runVotingCycle).mock.calls.length;
        expect(cyclesAfterStart).toBe(1); // start()'s immediate cycle; timer armed for 5 min

        // User saves settings: check frequency drops to 1 minute.
        checkFrequencyMinutes = 1;
        await act(async () => {
            await ctx!.rearmSchedule();
        });

        // 1 minute later the re-armed timer fires. The stale 5-minute timer
        // would not have — and must not fire on top later.
        await act(async () => {
            await jest.advanceTimersByTimeAsync(MIN + 1_000);
        });
        expect(jest.mocked(window.api.runVotingCycle).mock.calls.length).toBe(cyclesAfterStart + 1);

        // Cross the old timer's original deadline: total cycles follow the new
        // 1-minute cadence only; the superseded 5-minute timer stays dead.
        await act(async () => {
            await jest.advanceTimersByTimeAsync(4 * MIN);
        });
        expect(jest.mocked(window.api.runVotingCycle).mock.calls.length).toBe(cyclesAfterStart + 5);
    });

    it('is a no-op while autovote is stopped', async () => {
        renderProvider();

        await act(async () => {
            await ctx!.rearmSchedule();
        });

        await act(async () => {
            await jest.advanceTimersByTimeAsync(10 * MIN);
        });
        expect(window.api.runVotingCycle).not.toHaveBeenCalled();
    });
});
