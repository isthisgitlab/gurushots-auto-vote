/**
 * Unit tests for the React autovote scheduler helpers
 * (src/js/react/contexts/autovoteScheduler.js).
 *
 * NOTE: the previous version of this file re-declared *inline copies* of the
 * scheduler logic and asserted against those copies — so it exercised nothing
 * in the real module and could never catch a regression (it didn't catch the
 * missing revert-to-normal-cadence path that pinned the GUI at a 1-minute
 * cadence). These tests import the actual exports.
 *
 * The helpers read per-challenge thresholds via window.api.getEffectiveSetting;
 * the node test environment has no `window`, so we inject a global stub.
 */

const { computeNextCycleDelayMs } = require('../../src/js/react/contexts/autovoteScheduler');

describe('autovoteScheduler helpers', () => {
    let getEffectiveSetting;

    beforeEach(() => {
        // Default: every challenge has a 5-minute last-minute threshold.
        getEffectiveSetting = jest.fn().mockResolvedValue(5);
        global.window = { ...global.window, api: { getEffectiveSetting } };
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('computeNextCycleDelayMs (WebView resolver)', () => {
        const opts = (extra) => ({
            normalDelayMs: 3 * 60_000,
            lastMinuteCheckMinutes: 1,
            minGapMs: 5_000,
            ...extra,
        });

        it('caps the delay to an upcoming boundary resolved over IPC', async () => {
            const now = Math.floor(Date.now() / 1000);
            getEffectiveSetting.mockResolvedValue(16); // per-challenge threshold via IPC
            // closes in 17 min, threshold 16 → boundary 60s out, under the 3-min delay
            const challenges = [{ id: 126202, title: 'Cats', type: 'regular', close_time: now + 17 * 60 }];
            const result = await computeNextCycleDelayMs(challenges, now, opts());
            expect(result.mode).toBe('approaching');
            expect(result.delayMs).toBe(60_000);
        });

        it('uses the fixed fast cadence when already in-window', async () => {
            const now = Math.floor(Date.now() / 1000);
            getEffectiveSetting.mockResolvedValue(10);
            const challenges = [{ id: 1, title: 'Closing', type: 'regular', close_time: now + 120 }];
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
                        scheduledFillTime: '',
                        scheduledFillBeforeEnd: 3600 - 120,
                    }[key],
                ),
            );
            const challenges = [{ id: 9, title: 'Sched', type: 'regular', close_time: now + 3600 }];
            const result = await computeNextCycleDelayMs(challenges, now, opts({ timezone: 'UTC' }));
            expect(result.mode).toBe('scheduled');
            expect(result.delayMs).toBe(120_000);
            expect(result.nextScheduled).toMatchObject({ challengeId: 9, form: 'before-end' });
        });

        it('omitting timezone keeps the legacy behavior (no scheduled-fill IPC reads)', async () => {
            const now = Math.floor(Date.now() / 1000);
            getEffectiveSetting.mockResolvedValue(5);
            const challenges = [{ id: 9, title: 'Sched', type: 'regular', close_time: now + 3600 }];
            const result = await computeNextCycleDelayMs(challenges, now, opts());
            expect(result.mode).toBe('normal');
            expect(result.nextScheduled).toBeNull();
            // Only the threshold key is resolved — no scheduled-fill keys over IPC.
            const keysRead = getEffectiveSetting.mock.calls.map(([key]) => key);
            expect(keysRead).toEqual(['lastMinuteThreshold']);
        });
    });
});
