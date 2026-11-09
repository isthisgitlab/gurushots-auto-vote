import { freeBoostJoinDeadline, orderDiscoverRows } from '../../src/ts/core/discoverDates';
import type { DiscoverDateRow } from '../../src/ts/core/discoverDates';

const DAY_SEC = 24 * 60 * 60;

describe('freeBoostJoinDeadline', () => {
    test.each([
        ['shorter than four days', 2 * DAY_SEC, DAY_SEC / 2],
        ['exactly four days', 4 * DAY_SEC, DAY_SEC],
        ['longer than four days', 5 * DAY_SEC, DAY_SEC],
    ])('uses the eligibility window for a duration %s', (_name, duration, offset) => {
        expect(freeBoostJoinDeadline(1_000, 1_000 + duration)).toBe(1_000 + offset);
    });

    test.each([
        [undefined, 2_000],
        [1_000, undefined],
        ['soon', 2_000],
        [1_000, 'soon'],
        [2_000, 1_000],
        [1_000, 1_000],
    ])('rejects unreadable or non-positive durations', (start, close) => {
        expect(freeBoostJoinDeadline(start, close)).toBeNull();
    });
});

const row = (id: string, values: Omit<DiscoverDateRow, 'id'> = {}): DiscoverDateRow => ({ id, ...values });

describe('orderDiscoverRows', () => {
    const nowSec = 100;
    const rows = [
        row('open-late', { start_time: 40, close_time: 500 }),
        row('open-tie-b', { start_time: 20, close_time: 200 }),
        row('open-tie-a', { start_time: 20, close_time: 200 }),
        row('open-unknown'),
        row('starting-now-late', { status: 'upcoming', start_time: 90, close_time: 900 }),
        row('starting-now-early', { status: 'upcoming', start_time: 80, close_time: 300 }),
        row('future-late', { status: 'upcoming', start_time: 300, close_time: 800 }),
        row('future-early', { status: 'upcoming', start_time: 200, close_time: 400 }),
    ];

    test('preserves the input order and does not change it in default mode', () => {
        const original = [...rows];
        expect(orderDiscoverRows(rows, 'default', nowSec).map(({ id }) => id)).toEqual(original.map(({ id }) => id));
        expect(rows).toEqual(original);
    });

    test('sorts dates only within open, starting-now, and future groups', () => {
        const original = [...rows];
        expect(orderDiscoverRows(rows, 'start', nowSec).map(({ id }) => id)).toEqual([
            'open-tie-a',
            'open-tie-b',
            'open-late',
            'open-unknown',
            'starting-now-early',
            'starting-now-late',
            'future-early',
            'future-late',
        ]);
        expect(rows).toEqual(original);
    });

    test.each(['end', 'boostDeadline'] as const)('puts unreadable dates last for %s ordering', (sort) => {
        const ordered = orderDiscoverRows(
            [row('known', { start_time: 10, close_time: 110 }), row('unknown', { start_time: 10 })],
            sort,
            nowSec,
        );
        expect(ordered.map(({ id }) => id)).toEqual(['known', 'unknown']);
    });

    test('moves an unreadable date after a readable one when it begins on the left', () => {
        const ordered = orderDiscoverRows(
            [
                row('first', { start_time: 10, close_time: 110 }),
                row('unknown', { start_time: 10 }),
                row('second', { start_time: 10, close_time: 110 }),
            ],
            'end',
            nowSec,
        );
        expect(ordered.map(({ id }) => id)).toEqual(['first', 'second', 'unknown']);
    });

    test('uses ids to order equal dates in both source directions', () => {
        const a = row('a', { start_time: 10, close_time: 110 });
        const b = row('b', { start_time: 10, close_time: 110 });
        expect(orderDiscoverRows([a, b], 'end', nowSec)).toEqual([a, b]);
        expect(orderDiscoverRows([b, a], 'end', nowSec)).toEqual([a, b]);
    });

    test('uses ids when both dates are unreadable', () => {
        const a = row('a');
        const b = row('b');
        expect(orderDiscoverRows([b, a], 'end', nowSec)).toEqual([a, b]);
    });

    test('keeps an upcoming row with no start time in the future group', () => {
        const ordered = orderDiscoverRows(
            [
                row('open', { start_time: 10, close_time: 110 }),
                row('unknown-upcoming', { status: 'upcoming' }),
                row('future', { status: 'upcoming', start_time: 200, close_time: 300 }),
            ],
            'start',
            nowSec,
        );
        expect(ordered.map(({ id }) => id)).toEqual(['open', 'future', 'unknown-upcoming']);
    });

    test('preserves original order when dates and ids are identical', () => {
        const first = row('same', { start_time: 10, close_time: 110 });
        const second = row('same', { start_time: 10, close_time: 110 });
        expect(orderDiscoverRows([first, second], 'end', nowSec)).toEqual([first, second]);
    });

    test.each(['end', 'boostDeadline'] as const)(
        'keeps starting-now rows before future rows for %s ordering',
        (sort) => {
            const ordered = orderDiscoverRows(
                [
                    row('open', { start_time: 20, close_time: 300 }),
                    row('starting-now', { status: 'upcoming', start_time: 90, close_time: 1_000 }),
                    row('future', { status: 'upcoming', start_time: 200, close_time: 210 }),
                ],
                sort,
                nowSec,
            );
            expect(ordered.map(({ id }) => id)).toEqual(['open', 'starting-now', 'future']);
        },
    );
});
