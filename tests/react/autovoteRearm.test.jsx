/**
 * rearmSchedule: settings saved while autovote runs must re-arm the cadence
 * timer immediately.
 *
 * The armed timer was computed from the old settings; without a re-arm, a
 * shortened check frequency (or a newly-configured threshold / scheduled-fill
 * window) is slept past until the current — possibly hours-long — wait
 * elapses. The settings modals call rearmSchedule() on save; this is the
 * regression net for that wiring (the pre-React app exposed the same re-arm
 * as window.handleThresholdSettingsChange, which the React port dropped).
 */

import { render, act } from '@testing-library/preact';
import { AutovoteProvider, useAutovote } from '@/contexts/AutovoteContext';
import { mockApi } from './helpers/setup';

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

describe('AutovoteContext — rearmSchedule after a settings change', () => {
    let ctx;
    let activeChallenges;
    let checkFrequencyMinutes;

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
        window.api = mockApi;

        const now = Math.floor(Date.now() / 1000);
        // Challenge far from closing → normal cadence, no threshold capping.
        activeChallenges = [{ id: 1, title: 'Far Away', type: 'regular', close_time: now + 100_000 }];
        checkFrequencyMinutes = 5;

        window.api.getSettings.mockImplementation(async () => ({
            token: 'tok',
            checkFrequencyMin: checkFrequencyMinutes,
            checkFrequencyMax: checkFrequencyMinutes,
        }));
        window.api.getSetting.mockResolvedValue(null); // no auto-resume on mount
        window.api.getActiveChallenges.mockImplementation(async () => ({ challenges: activeChallenges }));
        window.api.getEffectiveSetting.mockImplementation((key) =>
            Promise.resolve(key === 'lastMinuteCheckFrequency' ? 1 : 10),
        );
        window.api.runVotingCycle.mockResolvedValue({ success: true, challenges: activeChallenges });
    });

    afterEach(async () => {
        if (ctx) {
            await act(async () => {
                await ctx.stop();
            });
        }
        ctx = null;
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('re-arms the timer with the new settings instead of finishing the old wait', async () => {
        renderProvider();

        await act(async () => {
            await ctx.start();
        });
        const cyclesAfterStart = window.api.runVotingCycle.mock.calls.length;
        expect(cyclesAfterStart).toBe(1); // start()'s immediate cycle; timer armed for 5 min

        // User saves settings: check frequency drops to 1 minute.
        checkFrequencyMinutes = 1;
        await act(async () => {
            await ctx.rearmSchedule();
        });

        // 1 minute later the re-armed timer fires. The stale 5-minute timer
        // would not have — and must not fire on top later.
        await act(async () => {
            await jest.advanceTimersByTimeAsync(MIN + 1_000);
        });
        expect(window.api.runVotingCycle.mock.calls.length).toBe(cyclesAfterStart + 1);

        // Cross the old timer's original deadline: total cycles follow the new
        // 1-minute cadence only; the superseded 5-minute timer stays dead.
        await act(async () => {
            await jest.advanceTimersByTimeAsync(4 * MIN);
        });
        expect(window.api.runVotingCycle.mock.calls.length).toBe(cyclesAfterStart + 5);
    });

    it('is a no-op while autovote is stopped', async () => {
        renderProvider();

        await act(async () => {
            await ctx.rearmSchedule();
        });

        await act(async () => {
            await jest.advanceTimersByTimeAsync(10 * MIN);
        });
        expect(window.api.runVotingCycle).not.toHaveBeenCalled();
    });
});
