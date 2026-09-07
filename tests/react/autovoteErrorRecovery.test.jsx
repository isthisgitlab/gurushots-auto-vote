/**
 * Error recovery: once a cycle fails the status badge goes to 'Error', but the
 * cadence chain keeps looping. A subsequent successful cycle MUST clear the
 * error and restore the 'Running' badge — otherwise a single transient failure
 * (network blip, one 'Voting failed' cycle) pins the UI to 'Error' forever and
 * the only escape is a manual Stop → Start. This is the regression net for
 * that recovery (CLEAR_ERROR dispatched on the success path of runVotingCycle).
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

describe('AutovoteContext — recovery after a failed cycle', () => {
    let ctx;
    let activeChallenges;

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

        window.api.getSettings.mockImplementation(async () => ({
            token: 'tok',
            checkFrequencyMin: 5,
            checkFrequencyMax: 5,
        }));
        window.api.getSetting.mockResolvedValue(null); // no auto-resume on mount
        window.api.getActiveChallenges.mockImplementation(async () => ({ challenges: activeChallenges }));
        window.api.getEffectiveSetting.mockImplementation((key) =>
            Promise.resolve(key === 'lastMinuteCheckFrequency' ? 1 : 10),
        );
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

    it('clears the Error badge when a later cycle succeeds', async () => {
        // First cycle fails, second succeeds.
        window.api.runVotingCycle
            .mockResolvedValueOnce({ success: false, error: 'Voting failed' })
            .mockResolvedValue({ success: true, challenges: activeChallenges });

        renderProvider();

        // start() runs the immediate (failing) cycle.
        await act(async () => {
            await ctx.start();
        });
        expect(ctx.status).toBe('Error');
        expect(ctx.statusClass).toBe('badge-error');
        expect(ctx.error).toBe('Voting failed');
        // The loop must still be armed — an error does not stop autovote.
        expect(ctx.running).toBe(true);

        // 5 minutes later the re-armed timer fires the next (succeeding) cycle.
        await act(async () => {
            await jest.advanceTimersByTimeAsync(5 * MIN + 1_000);
        });

        expect(window.api.runVotingCycle.mock.calls.length).toBe(2);
        expect(ctx.status).toBe('Running');
        expect(ctx.statusClass).toBe('badge-success');
        expect(ctx.error).toBeNull();
        expect(ctx.cycles).toBe(1); // only the successful cycle increments
    });
});
