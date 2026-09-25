/**
 * Vote speed from sampled vote counts: sampling, votes per hour, the ratio to
 * the other entries, and the speed-based selector and conditions.
 */

const {
    recordVoteSample,
    votesPerHour,
    speedRatio,
    SAMPLE_SPACING_SEC,
    HISTORY_KEEP_SEC,
    MAX_SAMPLES,
} = require('../../src/js/scenarios/speed');
const { selectEntry } = require('../../src/js/scenarios/selectors');
const { evaluateCondition } = require('../../src/js/scenarios/conditions');

const NOW = 1_800_000_000;
const H = 3600;

describe('recordVoteSample', () => {
    test('samples every readable entry, spaced and trimmed', () => {
        let history = recordVoteSample(
            undefined,
            [{ id: 1, votes: 5 }, { id: 'x', votes: 'n/a' }, { votes: 3 }, null],
            NOW,
        );
        expect(history).toEqual({ 1: [[NOW, 5]] });
        history = recordVoteSample(history, [{ id: 1, votes: 6 }], NOW + SAMPLE_SPACING_SEC - 1);
        expect(history['1']).toHaveLength(1);
        history = recordVoteSample(history, [{ id: 1, votes: 7 }], NOW + SAMPLE_SPACING_SEC);
        expect(history['1']).toEqual([
            [NOW, 5],
            [NOW + SAMPLE_SPACING_SEC, 7],
        ]);
    });

    test('keeps a photo that is swapped out until its samples age out', () => {
        const history = recordVoteSample({ gone: [[NOW - 10, 1]], old: [[NOW - HISTORY_KEEP_SEC - 1, 1]] }, [], NOW);
        expect(history).toEqual({ gone: [[NOW - 10, 1]] });
    });

    test('caps the samples per photo', () => {
        const samples = Array.from({ length: MAX_SAMPLES }, (_, i) => [
            NOW - (MAX_SAMPLES - i) * SAMPLE_SPACING_SEC,
            i,
        ]);
        expect(recordVoteSample({ 1: samples }, [{ id: 1, votes: 999 }], NOW)['1']).toHaveLength(MAX_SAMPLES);
    });
});

describe('votesPerHour / speedRatio', () => {
    const history = {
        fast: [
            [NOW - 3 * H, 0],
            [NOW - H, 20],
        ],
        slow: [[NOW - 2 * H, 10]],
        flat: [[NOW - 2 * H, 4]],
        fresh: [[NOW - 60, 0]],
    };

    test('measures from the newest sample before the window, else the oldest', () => {
        expect(votesPerHour(history, { id: 'fast', votes: 50 }, NOW, H)).toBe(30);
        expect(votesPerHour(history, { id: 'slow', votes: 20 }, NOW, H)).toBe(5);
        expect(votesPerHour(history, { id: 'slow', votes: 20 }, NOW)).toBe(5);
    });

    test('unknown without a vote count, history, or enough span', () => {
        expect(votesPerHour(history, { id: 'fast' }, NOW)).toBeNull();
        expect(votesPerHour(history, { id: 'none', votes: 3 }, NOW)).toBeNull();
        expect(votesPerHour(undefined, { id: 'fast', votes: 3 }, NOW)).toBeNull();
        expect(votesPerHour(history, { id: 'fresh', votes: 3 }, NOW)).toBeNull();
    });

    test('ratio to the median of the other entries', () => {
        const fast = { id: 'fast', votes: 50 };
        const slow = { id: 'slow', votes: 20 };
        const flat = { id: 'flat', votes: 4 };
        expect(speedRatio(history, [fast, slow], fast, NOW, H)).toBe(6);
        expect(speedRatio(history, [fast, slow], fast, NOW)).toBe(6);
        // Median of an even count: (0 + 5) / 2.
        expect(speedRatio(history, [fast, slow, flat], fast, NOW, H)).toBe(12);
        expect(speedRatio(history, [fast, flat], fast, NOW, H)).toBe(Infinity);
        expect(speedRatio(history, [flat, { id: 'flat2', votes: 4 }], flat, NOW, H)).toBeNull();
        expect(speedRatio({ ...history, flat2: [[NOW - H, 4]] }, [flat, { id: 'flat2', votes: 4 }], flat, NOW, H)).toBe(
            0,
        );
        expect(speedRatio(history, [fast], fast, NOW, H)).toBeNull();
        expect(speedRatio(history, [{ id: 'fresh', votes: 1 }, slow], { id: 'fresh', votes: 1 }, NOW, H)).toBeNull();
    });
});

describe('speed selector and conditions', () => {
    const challenge = {
        member: {
            ranking: {
                entries: [
                    { id: 'slow', votes: 20 },
                    { id: 'fast', votes: 50, boosted: true },
                    { id: 'fresh', votes: 3 },
                ],
            },
        },
    };
    const history = {
        fast: [[NOW - 2 * H, 0]],
        slow: [[NOW - 2 * H, 10]],
        fresh: [[NOW - 60, 0]],
    };
    const ctx = { challenge, state: { phaseEnteredAt: NOW, memory: {}, history }, now: NOW, timezone: 'UTC' };

    test('fastest picks the most votes per hour, honouring skipProtected and the window', () => {
        expect(selectEntry({ by: 'fastest' }, challenge, { history, now: NOW }).id).toBe('fast');
        expect(
            selectEntry({ by: 'fastest', skipProtected: true, window: '6h' }, challenge, { history, now: NOW }).id,
        ).toBe('slow');
        expect(selectEntry({ by: 'fastest' }, challenge, { now: NOW })).toBeNull();
    });

    test('votesPerHour and speedRatio conditions, unknown speeds failing closed', () => {
        const entry = (field, op, value, extra = {}) => ({
            type: 'entry',
            select: { by: 'fastest' },
            field,
            op,
            value,
            ...extra,
        });
        expect(evaluateCondition(entry('votesPerHour', '>=', 25), ctx)).toBe(true);
        expect(evaluateCondition(entry('speedRatio', '>=', 2, { window: '2h' }), ctx)).toBe(true);
        expect(
            evaluateCondition(entry('speedRatio', '>=', 2), {
                ...ctx,
                state: { ...ctx.state, history: { fast: history.fast } },
            }),
        ).toBe(false);
        expect(
            evaluateCondition(
                { type: 'entry', select: { by: 'slot', index: 3 }, field: 'votesPerHour', op: '>=', value: 0 },
                ctx,
            ),
        ).toBe(false);
    });
});
