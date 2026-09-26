/**
 * The held-boost wake-up cap: a boost the voting pass held for a fresh photo
 * marks its release instant on the challenge (`boostHoldUntil`), and the
 * scheduler must not sleep past it — not even on the last-minute cadence.
 * Covers soonestBoostHoldEnd directly and its wiring into
 * computeNextCycleDelayMs (mode 'boost-hold').
 */

const { soonestBoostHoldEnd, computeNextCycleDelayMs } = require('../../src/js/scheduling/thresholdWindow');

const NOW = 1_000_000;

const makeChallenge = (overrides = {}) => ({
    id: 7,
    title: 'Held',
    type: 'default',
    start_time: NOW - 3600,
    close_time: NOW + 3600,
    ...overrides,
});

describe('soonestBoostHoldEnd', () => {
    test('finds the soonest upcoming release across open challenges', () => {
        const result = soonestBoostHoldEnd(
            [
                makeChallenge({ id: 1, boostHoldUntil: NOW + 200 }),
                makeChallenge({ id: 2, title: '', boostHoldUntil: NOW + 90 }),
                makeChallenge({ id: 3 }),
            ],
            NOW,
        );
        expect(result).toEqual({ challengeId: 2, challengeTitle: 'challenge 2', startTime: NOW + 90 });
    });

    test('ignores passed holds, closed challenges and a non-list', () => {
        expect(
            soonestBoostHoldEnd(
                [
                    makeChallenge({ boostHoldUntil: NOW - 1 }),
                    makeChallenge({ close_time: NOW, boostHoldUntil: NOW + 60 }),
                ],
                NOW,
            ),
        ).toBeNull();
        expect(soonestBoostHoldEnd(null, NOW)).toBeNull();
    });
});

describe('computeNextCycleDelayMs with a held boost', () => {
    const base = {
        resolveThreshold: () => 5,
        normalDelayMs: 30 * 60_000,
        lastMinuteCheckMinutes: 1,
        minGapMs: 5_000,
    };

    test('caps the normal delay to the release', async () => {
        const result = await computeNextCycleDelayMs([makeChallenge({ boostHoldUntil: NOW + 150 })], NOW, base);
        expect(result.mode).toBe('boost-hold');
        expect(result.delayMs).toBe(150_000);
        expect(result.nextBoostHold).toMatchObject({ challengeId: 7, startTime: NOW + 150 });
    });

    test('caps the last-minute cadence too when the release comes first', async () => {
        const closing = makeChallenge({ close_time: NOW + 120, boostHoldUntil: NOW + 30 });
        const result = await computeNextCycleDelayMs([closing], NOW, base);
        expect(result.mode).toBe('boost-hold');
        expect(result.delayMs).toBe(30_000);
    });

    test('a release after the next last-minute tick leaves that cadence alone', async () => {
        const closing = makeChallenge({ close_time: NOW + 280, boostHoldUntil: NOW + 90 });
        const result = await computeNextCycleDelayMs([closing], NOW, base);
        expect(result.mode).toBe('last-minute');
        expect(result.delayMs).toBe(60_000);
        expect(result.nextBoostHold).toMatchObject({ startTime: NOW + 90 });
    });

    test('no hold → no cap and none reported', async () => {
        const result = await computeNextCycleDelayMs([makeChallenge()], NOW, base);
        expect(result.mode).toBe('normal');
        expect(result.nextBoostHold).toBeNull();
    });
});
