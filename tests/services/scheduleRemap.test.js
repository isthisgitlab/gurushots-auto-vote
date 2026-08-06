/**
 * Unit tests for the pure end-alignment remap helpers. Shared by the voting
 * core (autoFill.js) and the React renderer (ChallengeSettingsModal hint), so
 * everything here must hold without any settings/logger plumbing.
 */

const { getScheduleShift, remapScheduleRows } = require('../../src/js/services/scheduleRemap');

const DEFAULT_SCHEDULE = [
    { count: 2, seconds: 1800 },
    { count: 3, seconds: 1200 },
    { count: 4, seconds: 600 },
];

describe('getScheduleShift — how far the schedule end-aligns', () => {
    test('compresses when the challenge allows fewer images than the span', () => {
        expect(getScheduleShift(DEFAULT_SCHEDULE, 2)).toBe(2);
        expect(getScheduleShift(DEFAULT_SCHEDULE, 3)).toBe(1);
    });

    test('never stretches: challenge at or above the span → 0', () => {
        expect(getScheduleShift(DEFAULT_SCHEDULE, 4)).toBe(0);
        expect(getScheduleShift(DEFAULT_SCHEDULE, 6)).toBe(0);
    });

    test('off rows (seconds: 0) do not extend the active span', () => {
        const withOffTail = [
            { count: 2, seconds: 1800 },
            { count: 3, seconds: 1200 },
            { count: 4, seconds: 0 },
        ];
        expect(getScheduleShift(withOffTail, 2)).toBe(1);
        expect(getScheduleShift([{ count: 2, seconds: 1800 }], 2)).toBe(0);
    });

    test('out-of-band counts cannot inflate the shift', () => {
        const poisoned = [{ count: 999999, seconds: 1800 }, ...DEFAULT_SCHEDULE];
        expect(getScheduleShift(poisoned, 2)).toBe(2);
    });

    test('garbage input → 0, never throws', () => {
        expect(getScheduleShift(null, 2)).toBe(0);
        expect(getScheduleShift(undefined, 2)).toBe(0);
        expect(getScheduleShift('garbage', 2)).toBe(0);
        expect(getScheduleShift([null, 42, { count: 1.5, seconds: 100 }], 2)).toBe(0);
        // Non-finite max coerces to 0 → every row shifts below count 2 and the
        // schedule goes inert — same fail-closed outcome as the old clamp.
        expect(getScheduleShift(DEFAULT_SCHEDULE, NaN)).toBe(4);
        expect(remapScheduleRows(DEFAULT_SCHEDULE, NaN)).toEqual([]);
    });
});

describe('remapScheduleRows — the schedule as it applies to one challenge', () => {
    test('2-image challenge: only the Image-4 row survives, mapped to count 2', () => {
        expect(remapScheduleRows(DEFAULT_SCHEDULE, 2)).toEqual([{ count: 2, seconds: 600 }]);
    });

    test('3-image challenge: rows 3/4 map to counts 2/3', () => {
        expect(remapScheduleRows(DEFAULT_SCHEDULE, 3)).toEqual([
            { count: 2, seconds: 1200 },
            { count: 3, seconds: 600 },
        ]);
    });

    test('no shift: rows pass through unchanged', () => {
        expect(remapScheduleRows(DEFAULT_SCHEDULE, 4)).toEqual(DEFAULT_SCHEDULE);
        expect(remapScheduleRows(DEFAULT_SCHEDULE, 6)).toEqual(DEFAULT_SCHEDULE);
    });

    test('sparse schedule shifts positionally (gap rows fall off the front)', () => {
        const sparse = [
            { count: 2, seconds: 1800 },
            { count: 4, seconds: 600 },
        ];
        expect(remapScheduleRows(sparse, 3)).toEqual([{ count: 3, seconds: 600 }]);
    });

    test('off rows shift positionally but stay in the output', () => {
        const withOffMiddle = [
            { count: 2, seconds: 1800 },
            { count: 3, seconds: 0 },
            { count: 4, seconds: 600 },
        ];
        expect(remapScheduleRows(withOffMiddle, 3)).toEqual([
            { count: 2, seconds: 0 },
            { count: 3, seconds: 600 },
        ]);
    });

    test('out-of-band counts are dropped even at shift 0', () => {
        const poisoned = [{ count: 999999, seconds: 1800 }, ...DEFAULT_SCHEDULE];
        expect(remapScheduleRows(poisoned, 4)).toEqual(DEFAULT_SCHEDULE);
        expect(remapScheduleRows(poisoned, 2)).toEqual([{ count: 2, seconds: 600 }]);
    });

    test('garbage input → empty array, never throws', () => {
        expect(remapScheduleRows(null, 2)).toEqual([]);
        expect(remapScheduleRows(undefined, 2)).toEqual([]);
        expect(remapScheduleRows('garbage', 2)).toEqual([]);
        expect(remapScheduleRows([null, 42, { count: '2', seconds: 600 }], 2)).toEqual([]);
    });
});
