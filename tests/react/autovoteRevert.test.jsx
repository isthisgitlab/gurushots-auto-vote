/**
 * Regression test for the GUI (React) scheduler revert.
 *
 * Once the fixed last-minute setInterval is active and no challenge remains
 * within its last-minute window, the scheduler must tear down the 1-minute
 * cadence and resume the normal randomized checkFrequency cadence.
 *
 * This is the GUI-side counterpart of the runScheduler.js revert (commit
 * 963eb1e), which never reached AutovoteContext — leaving the GUI pinned at a
 * 1-minute cadence forever after a challenge's window passed.
 */

import { render, act } from '@testing-library/preact';
import { AutovoteProvider, useAutovote } from '@/contexts/AutovoteContext';
import { mockApi } from '../../src/js/react/test/setup';

jest.mock('../../src/js/services/ForegroundServiceController', () => ({
    __esModule: true,
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    update: jest.fn(),
}));

jest.mock('../../src/js/services/NativeAutovoteBridge', () => ({
    __esModule: true,
    // No native plugin in the test → the JS-side scheduler owns the cadence.
    start: jest.fn().mockResolvedValue({ available: false }),
    stop: jest.fn().mockResolvedValue({ available: false }),
}));

const MIN = 60_000;

describe('AutovoteContext — last-minute cadence reverts to normal', () => {
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
        // jsdom-env globals occasionally lose window.api between test files; pin it.
        window.api = mockApi;

        const now = Math.floor(Date.now() / 1000);
        // Regular challenge inside its last-minute window at start (closes in
        // 5 min, 10-min threshold) so start() arms the fixed 1-minute interval.
        activeChallenges = [{ id: 1, title: 'Closing Soon', type: 'regular', close_time: now + 300 }];

        window.api.getSettings.mockResolvedValue({ token: 'tok', checkFrequencyMin: 3, checkFrequencyMax: 3 });
        window.api.getSetting.mockResolvedValue(null); // no auto-resume on mount
        window.api.getActiveChallenges.mockImplementation(async () => ({ challenges: activeChallenges }));
        window.api.getEffectiveSetting.mockImplementation((key) =>
            Promise.resolve(key === 'lastMinuteCheckFrequency' ? 1 : 10),
        );
        window.api.runVotingCycle.mockResolvedValue({ success: true });
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

    it('tears down the 1-minute interval and resumes normal cadence once the window empties', async () => {
        renderProvider();

        // Start → initial cycle + fixed 1-minute interval (challenge in window).
        await act(async () => {
            await ctx.start();
        });

        // The triggering challenge has now closed — nothing left in window.
        activeChallenges = [];

        // First 1-minute tick: runs a cycle, then updateThresholdScheduling
        // detects the empty window and reverts to the normal cadence.
        await act(async () => {
            await jest.advanceTimersByTimeAsync(MIN);
        });
        const callsAfterRevert = window.api.runVotingCycle.mock.calls.length;
        expect(callsAfterRevert).toBeGreaterThanOrEqual(1);

        // Another minute passes: the dead 1-minute interval must NOT fire again.
        await act(async () => {
            await jest.advanceTimersByTimeAsync(MIN);
        });
        expect(window.api.runVotingCycle.mock.calls.length).toBe(callsAfterRevert);

        // The normal 3-minute cadence is live again: it was armed at the revert
        // (t≈+1min) to fire +3min later, so reaching ~+4min fires exactly one
        // more cycle (the dead 1-min cron would have fired ~3 by now).
        await act(async () => {
            await jest.advanceTimersByTimeAsync(2 * MIN + 30_000);
        });
        expect(window.api.runVotingCycle.mock.calls.length).toBe(callsAfterRevert + 1);
    });

    it('stays at the 1-minute cadence while a challenge remains in its window', async () => {
        renderProvider();

        await act(async () => {
            await ctx.start();
        });

        // Challenge stays open and in-window across the next two ticks.
        const before = window.api.runVotingCycle.mock.calls.length;
        await act(async () => {
            await jest.advanceTimersByTimeAsync(MIN);
        });
        await act(async () => {
            await jest.advanceTimersByTimeAsync(MIN);
        });
        // Two 1-minute ticks → two cycles (no revert while in-window).
        expect(window.api.runVotingCycle.mock.calls.length).toBe(before + 2);
    });
});
