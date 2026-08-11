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

        describe('scheduled-fill cap', () => {
            // The scheduled-fill resolver mirrors the threshold resolver's dual
            // shape: sync on Node, Promise on the WebView. Reuse the outer
            // describe.each's shape by wrapping the config the same way.
            const wrap = (config) => (resolveThreshold() instanceof Promise ? Promise.resolve(config) : config);
            const off = { enabled: false, timesOfDay: [], beforeEndSecs: [] };

            it('omitting the new opts leaves results identical (backward compat)', async () => {
                const now = Math.floor(Date.now() / 1000);
                const challenges = [{ id: 1, title: 'Far', type: 'regular', close_time: now + 3600 }];
                const result = await computeNextCycleDelayMs(challenges, now, opts());
                expect(result.mode).toBe('normal');
                expect(result.delayMs).toBe(NORMAL);
                expect(result.nextScheduled).toBeNull();
            });

            it('caps the delay to an upcoming before-end window start', async () => {
                const now = Math.floor(Date.now() / 1000);
                // Close in 1h, before-end 58 min → start 120s away, sooner than
                // the 3-min random delay and the 55-min threshold boundary.
                const challenges = [{ id: 9, title: 'Sched', type: 'regular', close_time: now + 3600 }];
                const result = await computeNextCycleDelayMs(challenges, now, {
                    ...opts(),
                    resolveScheduledFill: () => wrap({ enabled: true, timesOfDay: [], beforeEndSecs: [3480] }),
                    timezone: 'UTC',
                });
                expect(result.mode).toBe('scheduled');
                expect(result.delayMs).toBe(120_000);
                expect(result.nextScheduled).toMatchObject({ challengeId: 9, form: 'before-end' });
            });

            it('caps the delay to an upcoming time-of-day start', async () => {
                // Fixed epoch: 12:00 UTC → a 12:01 daily time starts 60s out.
                const now = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
                const challenges = [{ id: 9, title: 'Sched', type: 'regular', close_time: now + 3600 }];
                const result = await computeNextCycleDelayMs(challenges, now, {
                    ...opts(),
                    resolveScheduledFill: () => wrap({ enabled: true, timesOfDay: ['12:01'], beforeEndSecs: [] }),
                    timezone: 'UTC',
                });
                expect(result.mode).toBe('scheduled');
                expect(result.delayMs).toBe(60_000);
                expect(result.nextScheduled).toMatchObject({ challengeId: 9, form: 'time-of-day' });
            });

            it('does not cap when the scheduled start is beyond the normal delay', async () => {
                const now = Math.floor(Date.now() / 1000);
                // Close in 2h, before-end 30 min → start 90 min out, beyond the 3-min delay.
                const challenges = [{ id: 9, title: 'Sched', type: 'regular', close_time: now + 7200 }];
                const result = await computeNextCycleDelayMs(challenges, now, {
                    ...opts(),
                    resolveScheduledFill: () => wrap({ enabled: true, timesOfDay: [], beforeEndSecs: [1800] }),
                    timezone: 'UTC',
                });
                expect(result.mode).toBe('normal');
                expect(result.delayMs).toBe(NORMAL);
            });

            it('the sooner of a threshold boundary and a scheduled start wins', async () => {
                const now = Math.floor(Date.now() / 1000);
                // Threshold boundary: close in 17 min, threshold 16 → 60s away.
                // Scheduled start: before-end 15 min → 120s away. Boundary wins.
                const challenges = [{ id: 5, title: 'Both', type: 'regular', close_time: now + 17 * 60 }];
                const boundaryWins = await computeNextCycleDelayMs(challenges, now, {
                    ...opts({ resolveThreshold: () => 16 }),
                    resolveScheduledFill: () => wrap({ enabled: true, timesOfDay: [], beforeEndSecs: [15 * 60] }),
                    timezone: 'UTC',
                });
                expect(boundaryWins.mode).toBe('approaching');
                expect(boundaryWins.delayMs).toBe(60_000);

                // Flip it: scheduled start 30s away beats the 60s boundary.
                const scheduledWins = await computeNextCycleDelayMs(challenges, now, {
                    ...opts({ resolveThreshold: () => 16 }),
                    resolveScheduledFill: () => wrap({ enabled: true, timesOfDay: [], beforeEndSecs: [17 * 60 - 30] }),
                    timezone: 'UTC',
                });
                expect(scheduledWins.mode).toBe('scheduled');
                expect(scheduledWins.delayMs).toBe(30_000);
            });

            it('ignores a time-of-day occurrence that lands after close_time', async () => {
                // 12:00 UTC, challenge closes in 30 min — a 13:00 daily time can
                // never fire for it, so the cadence stays normal.
                const now = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
                const challenges = [{ id: 9, title: 'Sched', type: 'regular', close_time: now + 1800 }];
                const result = await computeNextCycleDelayMs(challenges, now, {
                    ...opts({ resolveThreshold: () => 5 }),
                    resolveScheduledFill: () => wrap({ enabled: true, timesOfDay: ['13:00'], beforeEndSecs: [] }),
                    timezone: 'UTC',
                });
                expect(result.mode).toBe('normal');
                expect(result.nextScheduled).toBeNull();
            });

            it('a window narrower than the normal cadence still gets a cycle exactly at its start', async () => {
                const now = Math.floor(Date.now() / 1000);
                // 5-minute window starting 100s out — narrower than the 3-min
                // cadence; the cap must land a cycle at the start regardless.
                const challenges = [{ id: 9, title: 'Sched', type: 'regular', close_time: now + 3600 }];
                const result = await computeNextCycleDelayMs(challenges, now, {
                    ...opts(),
                    resolveScheduledFill: () => wrap({ enabled: true, timesOfDay: [], beforeEndSecs: [3500] }),
                    timezone: 'UTC',
                });
                expect(result.mode).toBe('scheduled');
                expect(result.delayMs).toBe(100_000);
            });

            it('a challenge with both forms contributes the earlier start', async () => {
                const now = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
                // time-of-day 12:05 → 300s out; before-end → 120s out. Min wins.
                const challenges = [{ id: 9, title: 'Both forms', type: 'regular', close_time: now + 3600 }];
                const result = await computeNextCycleDelayMs(challenges, now, {
                    ...opts(),
                    resolveScheduledFill: () => wrap({ enabled: true, timesOfDay: ['12:05'], beforeEndSecs: [3480] }),
                    timezone: 'UTC',
                });
                expect(result.mode).toBe('scheduled');
                expect(result.delayMs).toBe(120_000);
                expect(result.nextScheduled.form).toBe('before-end');
            });

            it('multiple time entries: the soonest upcoming occurrence wins, not list order', async () => {
                // 20:00 UTC with times ['09:00', '21:30'] → the cap targets
                // today 21:30 (90 min out), not tomorrow 09:00. normalDelayMs
                // is raised so the cap is what binds.
                const now = Math.floor(Date.UTC(2026, 0, 15, 20, 0, 0) / 1000);
                const challenges = [{ id: 9, title: 'Multi', type: 'regular', close_time: now + 48 * 3600 }];
                const result = await computeNextCycleDelayMs(challenges, now, {
                    ...opts({ normalDelayMs: 4 * 3600_000 }),
                    resolveScheduledFill: () =>
                        wrap({ enabled: true, timesOfDay: ['09:00', '21:30'], beforeEndSecs: [] }),
                    timezone: 'UTC',
                });
                expect(result.mode).toBe('scheduled');
                expect(result.delayMs).toBe(90 * 60_000);
                expect(result.nextScheduled.form).toBe('time-of-day');
            });

            it('multiple before-end entries: the earliest upcoming window start wins (issue case: 4h and 10h)', async () => {
                // Close in 11h with offsets [4h, 10h] → the 10h window opens
                // in 1h; that start binds, not the 4h one (7h out).
                const now = Math.floor(Date.now() / 1000);
                const challenges = [{ id: 9, title: 'Twice', type: 'regular', close_time: now + 11 * 3600 }];
                const result = await computeNextCycleDelayMs(challenges, now, {
                    ...opts({ normalDelayMs: 4 * 3600_000 }),
                    resolveScheduledFill: () =>
                        wrap({ enabled: true, timesOfDay: [], beforeEndSecs: [4 * 3600, 10 * 3600] }),
                    timezone: 'UTC',
                });
                expect(result.mode).toBe('scheduled');
                expect(result.delayMs).toBe(3600_000);
                expect(result.nextScheduled.form).toBe('before-end');
            });

            it('a corrupt entry inside a list is ignored while siblings still cap', async () => {
                const now = Math.floor(Date.now() / 1000);
                const challenges = [{ id: 9, title: 'Mixed', type: 'regular', close_time: now + 3600 }];
                const result = await computeNextCycleDelayMs(challenges, now, {
                    ...opts(),
                    resolveScheduledFill: () =>
                        wrap({ enabled: true, timesOfDay: ['25:99'], beforeEndSecs: [-5, 3600 - 120] }),
                    timezone: 'UTC',
                });
                expect(result.mode).toBe('scheduled');
                expect(result.delayMs).toBe(120_000);
            });

            it('floors the scheduled cap at minGapMs', async () => {
                const now = Math.floor(Date.now() / 1000);
                // Start 1s away — below the 5s floor.
                const challenges = [{ id: 9, title: 'Imminent', type: 'regular', close_time: now + 3600 }];
                const result = await computeNextCycleDelayMs(challenges, now, {
                    ...opts(),
                    resolveScheduledFill: () => wrap({ enabled: true, timesOfDay: [], beforeEndSecs: [3599] }),
                    timezone: 'UTC',
                });
                expect(result.mode).toBe('scheduled');
                expect(result.delayMs).toBe(MIN_GAP);
            });

            it('disabled or corrupt configs are skipped without throwing', async () => {
                const now = Math.floor(Date.now() / 1000);
                const challenges = [
                    { id: 1, title: 'Off', type: 'regular', close_time: now + 3600 },
                    { id: 2, title: 'Throws', type: 'regular', close_time: now + 3600 },
                ];
                const result = await computeNextCycleDelayMs(challenges, now, {
                    ...opts(),
                    resolveScheduledFill: (id) => {
                        if (id === '2') throw new Error('corrupt');
                        return wrap(off);
                    },
                    timezone: 'UTC',
                });
                expect(result.mode).toBe('normal');
                expect(result.nextScheduled).toBeNull();
            });
        });
    });
});
