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
});
