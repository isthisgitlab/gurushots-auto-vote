/**
 * Shared last-minute threshold math, extracted from the two schedulers
 * (runScheduler.js for CLI/Android, autovoteScheduler.js for the GUI) which
 * previously each carried their own copy. The only platform difference was
 * how a per-challenge threshold is resolved — sync settings.getEffectiveSetting
 * on Node vs async window.api.getEffectiveSetting in the WebView — so the core
 * takes a `resolveThreshold` function and works with either.
 *
 * These cases mirror the prior per-scheduler tests and run against BOTH a
 * synchronous and an asynchronous resolver to prove the unified core matches
 * each platform's old behavior. This is the regression lock for Workstream D.
 */

const {
    calculateNextThresholdEntry,
    isAnyChallengeInThresholdWindow,
    computeNextCycleDelayMs,
} = require('../../src/js/scheduling/thresholdWindow');

// Two resolver shapes: Node (sync return) and WebView (Promise). Both yield 5.
const resolvers = {
    'sync resolver (Node)': () => 5,
    'async resolver (WebView)': () => Promise.resolve(5),
};

describe.each(Object.entries(resolvers))('thresholdWindow with %s', (_label, resolveThreshold) => {
    describe('calculateNextThresholdEntry', () => {
        it('returns the soonest challenge to cross its last-minute boundary', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [
                { id: 1, title: 'C1', type: 'regular', close_time: now + 3600 },
                { id: 2, title: 'C2', type: 'regular', close_time: now + 1800 }, // soonest entry
                { id: 3, title: 'Flash', type: 'flash', close_time: now + 1200 },
            ];

            const result = await calculateNextThresholdEntry(challenges, now, resolveThreshold);

            expect(result).not.toBeNull();
            expect(result.challengeId).toBe(2);
            expect(result.entryTime).toBe(now + 1800 - 300);
            expect(result.lastMinuteThreshold).toBe(5);
        });

        it('skips flash challenges', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [{ id: 1, title: 'Flash', type: 'flash', close_time: now + 1800 }];
            expect(await calculateNextThresholdEntry(challenges, now, resolveThreshold)).toBeNull();
        });

        it('skips already-closed challenges', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [{ id: 1, title: 'Ended', type: 'regular', close_time: now - 3600 }];
            expect(await calculateNextThresholdEntry(challenges, now, resolveThreshold)).toBeNull();
        });

        it('returns null when the only challenge is already inside its window', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [{ id: 1, title: 'Closing', type: 'regular', close_time: now + 120 }];
            expect(await calculateNextThresholdEntry(challenges, now, resolveThreshold)).toBeNull();
        });

        it('passes the challenge id as a string to the resolver', async () => {
            const now = Math.floor(Date.now() / 1000);
            const spy = jest.fn(() => 5);
            await calculateNextThresholdEntry(
                [{ id: 7, title: 'X', type: 'regular', close_time: now + 1800 }],
                now,
                spy,
            );
            expect(spy).toHaveBeenCalledWith('7');
        });
    });

    describe('isAnyChallengeInThresholdWindow', () => {
        it('is true when a non-flash challenge is within threshold*60 of close', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [{ id: 1, title: 'Closing', type: 'regular', close_time: now + 120 }];
            expect(await isAnyChallengeInThresholdWindow(challenges, now, resolveThreshold)).toBe(true);
        });

        it('is true at the inclusive boundary (close_time - now === threshold*60)', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [{ id: 1, title: 'Boundary', type: 'regular', close_time: now + 300 }];
            expect(await isAnyChallengeInThresholdWindow(challenges, now, resolveThreshold)).toBe(true);
        });

        it('is false when every challenge is further out than its window', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [
                { id: 1, title: 'Far', type: 'regular', close_time: now + 3600 },
                { id: 2, title: 'Also far', type: 'regular', close_time: now + 1800 },
            ];
            expect(await isAnyChallengeInThresholdWindow(challenges, now, resolveThreshold)).toBe(false);
        });

        it('ignores flash and already-closed challenges', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [
                { id: 1, title: 'Flash closing', type: 'flash', close_time: now + 60 },
                { id: 2, title: 'Closed', type: 'regular', close_time: now - 10 },
            ];
            expect(await isAnyChallengeInThresholdWindow(challenges, now, resolveThreshold)).toBe(false);
        });

        it('is false for an empty challenge list', async () => {
            const now = Math.floor(Date.now() / 1000);
            expect(await isAnyChallengeInThresholdWindow([], now, resolveThreshold)).toBe(false);
        });
    });

    describe('computeNextCycleDelayMs', () => {
        const NORMAL = 3 * 60_000; // 3 min rolled random delay
        const FAST = 1; // lastMinuteCheckMinutes
        const MIN_GAP = 5_000;
        const opts = (extra) => ({
            resolveThreshold,
            normalDelayMs: NORMAL,
            lastMinuteCheckMinutes: FAST,
            minGapMs: MIN_GAP,
            ...extra,
        });

        it('uses the fixed fast cadence when a challenge is already in-window', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [{ id: 1, title: 'Closing', type: 'regular', close_time: now + 120 }];
            const result = await computeNextCycleDelayMs(challenges, now, opts());
            expect(result.mode).toBe('last-minute');
            expect(result.delayMs).toBe(FAST * 60_000);
        });

        it('caps the delay to the soonest upcoming boundary when it is sooner than the random delay', async () => {
            // Regression lock for the reported bug: challenge closes in 17 min,
            // per-challenge threshold 16 min → boundary is 60s away. With a 3-min
            // random delay we must cap to ~60s, not overshoot to 3 min.
            const now = Math.floor(Date.now() / 1000);
            const closeIn17m = now + 17 * 60;
            const sixteenMin = () => 16;
            const challenges = [{ id: 126202, title: 'Cats', type: 'regular', close_time: closeIn17m }];
            const result = await computeNextCycleDelayMs(challenges, now, opts({ resolveThreshold: sixteenMin }));
            expect(result.mode).toBe('approaching');
            expect(result.delayMs).toBe(60_000); // (17 - 16) min to the boundary
            expect(result.nextEntry.challengeId).toBe(126202);
        });

        it('keeps the normal random delay when the boundary is further than one delay out', async () => {
            const now = Math.floor(Date.now() / 1000);
            // close in 1h, threshold 5 → boundary 55 min out, well beyond the 3-min delay
            const challenges = [{ id: 1, title: 'Far', type: 'regular', close_time: now + 3600 }];
            const result = await computeNextCycleDelayMs(challenges, now, opts());
            expect(result.mode).toBe('normal');
            expect(result.delayMs).toBe(NORMAL);
        });

        it('returns the normal delay when there are no eligible challenges', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [{ id: 1, title: 'Flash', type: 'flash', close_time: now + 120 }];
            const result = await computeNextCycleDelayMs(challenges, now, opts());
            expect(result.mode).toBe('normal');
            expect(result.delayMs).toBe(NORMAL);
            expect(result.nextEntry).toBeNull();
        });

        it('floors the approaching delay at minGapMs when the boundary is essentially here', async () => {
            const now = Math.floor(Date.now() / 1000);
            // close in 5 min + 1s, threshold 5 → boundary 1s away, below the 5s floor
            const challenges = [{ id: 1, title: 'Imminent', type: 'regular', close_time: now + 301 }];
            const result = await computeNextCycleDelayMs(challenges, now, opts());
            expect(result.mode).toBe('approaching');
            expect(result.delayMs).toBe(MIN_GAP);
        });

        it('treats the exact boundary (close_time - now === threshold*60) as in-window, not approaching', async () => {
            const now = Math.floor(Date.now() / 1000);
            // resolver returns 5 (min) → 300s window; close in exactly 300s sits
            // on the inclusive boundary, so it is in-window (last-minute), and
            // calculateNextThresholdEntry would (correctly) report no future entry.
            const challenges = [{ id: 1, title: 'Boundary', type: 'regular', close_time: now + 300 }];
            const result = await computeNextCycleDelayMs(challenges, now, opts());
            expect(result.mode).toBe('last-minute');
            expect(result.delayMs).toBe(FAST * 60_000);
        });

        it('prefers last-minute when one challenge is in-window even if another is only approaching', async () => {
            const now = Math.floor(Date.now() / 1000);
            // Both have a 5-min (300s) window. #1 is approaching (entry 60s out),
            // #2 is already in-window. The in-window challenge must win.
            const challenges = [
                { id: 1, title: 'Approaching', type: 'regular', close_time: now + 360 },
                { id: 2, title: 'In window', type: 'regular', close_time: now + 120 },
            ];
            const result = await computeNextCycleDelayMs(challenges, now, opts());
            expect(result.mode).toBe('last-minute');
            expect(result.delayMs).toBe(FAST * 60_000);
        });

        it('floors the fast cadence at minGapMs', async () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [{ id: 1, title: 'Closing', type: 'regular', close_time: now + 60 }];
            // lastMinuteCheckMinutes so small its ms value is under the floor
            const result = await computeNextCycleDelayMs(challenges, now, opts({ lastMinuteCheckMinutes: 0.001 }));
            expect(result.mode).toBe('last-minute');
            expect(result.delayMs).toBe(MIN_GAP);
        });
    });
});
