/**
 * Unit tests for the React autovote scheduler helpers
 * (src/ts/react/contexts/autovoteScheduler.ts).
 *
 * These tests import the actual exports rather than re-declaring the logic,
 * so they exercise the real module (including the revert-to-normal-cadence
 * path that keeps the GUI off a permanent 1-minute cadence).
 *
 * The helpers read per-challenge thresholds via window.api.getEffectiveSetting;
 * the node test environment has no `window`, so we inject a global stub.
 */

import type * as autovoteSchedulerModule from '../../src/ts/react/contexts/autovoteScheduler';
import type { WindowApi } from '../../src/ts/types/ipc';
import type { Challenge } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

const { computeNextCycleDelayMs } =
    require('../../src/ts/react/contexts/autovoteScheduler') as typeof autovoteSchedulerModule;

describe('autovoteScheduler helpers', () => {
    let getEffectiveSetting: jest.MockedFunction<WindowApi['getEffectiveSetting']>;

    beforeEach(() => {
        // Default: every challenge has a 5-minute last-minute threshold.
        getEffectiveSetting = jest.fn().mockResolvedValue(5);
        global.window = invalid({ ...global.window, api: { getEffectiveSetting } });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('computeNextCycleDelayMs (WebView resolver)', () => {
        const opts = (extra?: { lastMinuteCheckMinutes?: number; timezone?: string }) => ({
            normalDelayMs: 3 * 60_000,
            lastMinuteCheckMinutes: 1,
            minGapMs: 5_000,
            ...extra,
        });

        it('caps the delay to an upcoming boundary resolved over IPC', async () => {
            const now = Math.floor(Date.now() / 1000);
            getEffectiveSetting.mockResolvedValue(16); // per-challenge threshold via IPC
            // closes in 17 min, threshold 16 → boundary 60s out, under the 3-min delay
            const challenges = invalid<Challenge[]>([
                { id: 126202, title: 'Cats', type: 'regular', close_time: now + 17 * 60 },
            ]);
            const result = await computeNextCycleDelayMs(challenges, now, opts());
            expect(result.mode).toBe('approaching');
            expect(result.delayMs).toBe(60_000);
        });

        it('uses the fixed fast cadence when already in-window', async () => {
            const now = Math.floor(Date.now() / 1000);
            getEffectiveSetting.mockResolvedValue(10);
            const challenges = invalid<Challenge[]>([
                { id: 1, title: 'Closing', type: 'regular', close_time: now + 120 },
            ]);
            const result = await computeNextCycleDelayMs(challenges, now, opts({ lastMinuteCheckMinutes: 2 }));
            expect(result.mode).toBe('last-minute');
            expect(result.delayMs).toBe(2 * 60_000);
        });

        it('caps the delay to a scheduled-fill window start resolved over IPC when timezone is passed', async () => {
            const now = Math.floor(Date.now() / 1000);
            // Per-key async resolution: threshold far away, scheduled-fill
            // before-end window opening 120s out.
            getEffectiveSetting.mockImplementation((key) =>
                Promise.resolve(
                    {
                        lastMinuteThreshold: 5,
                        useScheduledFill: true,
                        scheduledFillTime: [],
                        scheduledFillBeforeEnd: [3600 - 120],
                    }[key],
                ),
            );
            const challenges = invalid<Challenge[]>([
                { id: 9, title: 'Sched', type: 'regular', close_time: now + 3600 },
            ]);
            const result = await computeNextCycleDelayMs(challenges, now, opts({ timezone: 'UTC' }));
            expect(result.mode).toBe('scheduled');
            expect(result.delayMs).toBe(120_000);
            expect(result.nextScheduled).toMatchObject({ challengeId: 9, form: 'before-end' });
        });

        it('omitting timezone makes no scheduled-fill IPC reads', async () => {
            const now = Math.floor(Date.now() / 1000);
            getEffectiveSetting.mockResolvedValue(5);
            const challenges = invalid<Challenge[]>([
                { id: 9, title: 'Sched', type: 'regular', close_time: now + 3600 },
            ]);
            const result = await computeNextCycleDelayMs(challenges, now, opts());
            expect(result.mode).toBe('normal');
            expect(result.nextScheduled).toBeNull();
            // No scheduled-fill keys are resolved without a timezone (that cap stays
            // gated). The threshold key is always resolved; the pre-final-window top-up
            // cap is always active (as on Node) and resolves its own keys regardless.
            const keysRead = getEffectiveSetting.mock.calls.map(([key]) => key);
            expect(keysRead).toContain('lastMinuteThreshold');
            expect(keysRead).not.toContain('useScheduledFill');
            expect(keysRead).not.toContain('scheduledFillTime');
            expect(keysRead).not.toContain('scheduledFillBeforeEnd');
        });
    });
});
