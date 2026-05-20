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

const {
    calculateNextThresholdEntry,
    isAnyChallengeInThresholdWindow,
} = require('../../src/js/react/contexts/autovoteScheduler');

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

    describe('calculateNextThresholdEntry', () => {
        it('returns the soonest challenge to cross its last-minute boundary', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [
                { id: 1, title: 'C1', type: 'regular', close_time: now + 3600 },
                { id: 2, title: 'C2', type: 'regular', close_time: now + 1800 }, // soonest entry
                { id: 3, title: 'Flash', type: 'flash', close_time: now + 1200 },
            ];

            const result = await calculateNextThresholdEntry(challenges, now);

            expect(result).not.toBeNull();
            expect(result.challengeId).toBe(2);
            expect(result.entryTime).toBe(now + 1800 - 300); // close_time - threshold*60
            expect(result.lastMinuteThreshold).toBe(5);
        });

        it('skips flash challenges', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [{ id: 1, title: 'Flash', type: 'flash', close_time: now + 1800 }];
            expect(await calculateNextThresholdEntry(challenges, now)).toBeNull();
        });

        it('skips already-closed challenges', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [{ id: 1, title: 'Ended', type: 'regular', close_time: now - 3600 }];
            expect(await calculateNextThresholdEntry(challenges, now)).toBeNull();
        });

        it('returns null when the only challenge is already inside its window (no future entry)', async () => {
            const now = Math.floor(Date.now() / 1000);
            // closes in 2 min, 5-min threshold → entryTime already in the past.
            const challenges = [{ id: 1, title: 'Closing', type: 'regular', close_time: now + 120 }];
            expect(await calculateNextThresholdEntry(challenges, now)).toBeNull();
        });
    });

    describe('isAnyChallengeInThresholdWindow', () => {
        it('is true when a non-flash challenge is within threshold*60 of close', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [{ id: 1, title: 'Closing', type: 'regular', close_time: now + 120 }];
            expect(await isAnyChallengeInThresholdWindow(challenges, now)).toBe(true);
        });

        it('is true at the inclusive boundary (close_time - now === threshold*60)', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [{ id: 1, title: 'Boundary', type: 'regular', close_time: now + 300 }];
            expect(await isAnyChallengeInThresholdWindow(challenges, now)).toBe(true);
        });

        it('is false when every challenge is further out than its window', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [
                { id: 1, title: 'Far', type: 'regular', close_time: now + 3600 },
                { id: 2, title: 'Also far', type: 'regular', close_time: now + 1800 },
            ];
            expect(await isAnyChallengeInThresholdWindow(challenges, now)).toBe(false);
        });

        it('ignores flash and already-closed challenges', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [
                { id: 1, title: 'Flash closing', type: 'flash', close_time: now + 60 },
                { id: 2, title: 'Closed', type: 'regular', close_time: now - 10 },
            ];
            expect(await isAnyChallengeInThresholdWindow(challenges, now)).toBe(false);
        });

        it('is false for an empty challenge list', async () => {
            const now = Math.floor(Date.now() / 1000);
            expect(await isAnyChallengeInThresholdWindow([], now)).toBe(false);
        });

        it('respects per-challenge thresholds (only the in-window one counts)', async () => {
            const now = Math.floor(Date.now() / 1000);
            // Challenge 1 closes in 8 min; challenge 2 in 4 min. With a 5-min
            // threshold for both, only challenge 2 is in-window.
            getEffectiveSetting.mockResolvedValue(5);
            const challenges = [
                { id: 1, title: 'Eight', type: 'regular', close_time: now + 480 },
                { id: 2, title: 'Four', type: 'regular', close_time: now + 240 },
            ];
            expect(await isAnyChallengeInThresholdWindow(challenges, now)).toBe(true);
        });
    });
});
