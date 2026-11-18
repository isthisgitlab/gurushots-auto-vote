/**
 * Unit tests for the pure end-alignment remap helpers. Shared by the voting
 * core (autoFill/schedule.ts) and the React renderer (the per-challenge settings hint), so
 * everything here must hold without any settings/logger plumbing.
 */

import type * as scheduleRemapModule from '../../src/ts/core/services/scheduleRemap';

const { getScheduleShift, remapScheduleRows, shiftForSpan, shiftRowCounts } =
    require('../../src/ts/core/services/scheduleRemap') as typeof scheduleRemapModule;

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

    test('a missing max shifts every row away, so the schedule goes inert', () => {
        expect(getScheduleShift(DEFAULT_SCHEDULE, undefined)).toBe(4);
        expect(remapScheduleRows(DEFAULT_SCHEDULE, undefined)).toEqual([]);
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
});

describe('shiftForSpan — the shift for a span the caller already measured', () => {
    test('is the part of the span the photo limit cannot hold, never negative', () => {
        expect(shiftForSpan(4, 2)).toBe(2);
        expect(shiftForSpan(4, 3)).toBe(1);
        expect(shiftForSpan(4, 4)).toBe(0);
        expect(shiftForSpan(3, 6)).toBe(0);
    });

    test('a missing limit counts as 0, so the whole span shifts away', () => {
        expect(shiftForSpan(4, undefined)).toBe(4);
    });
});

describe('shiftRowCounts — rows of any shape move toward the end', () => {
    const rows = [
        { count: 2, state: 'known', at: 10 },
        { count: 3, state: 'absent', reason: 'not-present' },
        { count: 4, state: 'unknown', reason: 'why' },
    ];

    test('a shift of 0 keeps every row as it is, in a new array', () => {
        const kept = shiftRowCounts(rows, 0);
        expect(kept).toEqual(rows);
        expect(kept).not.toBe(rows);
    });

    test('keeps every other field of a shifted row and drops the rows that fall below count 2', () => {
        expect(shiftRowCounts(rows, 1)).toEqual([
            { count: 2, state: 'absent', reason: 'not-present' },
            { count: 3, state: 'unknown', reason: 'why' },
        ]);
        expect(shiftRowCounts(rows, 2)).toEqual([{ count: 2, state: 'unknown', reason: 'why' }]);
    });

    test('a shift that is not a number leaves nothing', () => {
        expect(shiftRowCounts(rows, NaN)).toEqual([]);
    });
});
