/**
 * What Discover lists: the merge of the open and upcoming lists against an injected clock, and the
 * one-slot cache of the upcoming list.
 */

import { invalid } from '../helpers/invalid';
import type * as discoverModule from '../../src/ts/services/discoverChallenges';
import type { Challenge } from '../../src/ts/types/gurushots';

const { mergeDiscoverLists, fetchUpcoming, clearUpcomingCache, UPCOMING_CACHE_MS, MAX_UPCOMING_ROWS } =
    require('../../src/ts/services/discoverChallenges') as typeof discoverModule;

const NOW = 1_800_000_000;
const HOUR = 3600;
const item = (id: number | string, over: object = {}) => invalid<Challenge>({ id, title: `C${id}`, ...over });
const up = (id: number | string, startsIn: number, over: object = {}) =>
    item(id, { status: 'upcoming', start_time: NOW + startsIn, ...over });
const merge = (open: Array<Challenge | null>, upcoming: Array<Challenge | null>, hours = 24) =>
    mergeDiscoverLists({ open, upcoming, hours, nowSec: NOW }).map((c) => [c.id, c.status]);

describe('mergeDiscoverLists', () => {
    test('open rows first, in the server order and without the server status; then upcoming rows, soonest first', () => {
        expect(merge([item(2, { status: 'started' }), item(1)], [up(4, 3 * HOUR), up(3, HOUR)])).toEqual([
            [2, undefined],
            [1, undefined],
            [3, 'upcoming'],
            [4, 'upcoming'],
        ]);
    });

    test('an id in both lists is the open copy, whatever the ids are typed as', () => {
        const merged = mergeDiscoverLists({
            open: [item(5, { title: 'Open copy' })],
            upcoming: [up('5', HOUR, { title: 'Upcoming copy' }), up(6, HOUR)],
            hours: 24,
            nowSec: NOW,
        });
        expect(merged.map((c) => [c.id, c.title])).toEqual([
            [5, 'Open copy'],
            [6, 'C6'],
        ]);
    });

    test('the window: the far end is inclusive, one second more is out', () => {
        expect(merge([], [up(1, 24 * HOUR), up(2, 24 * HOUR + 1)])).toEqual([[1, 'upcoming']]);
        expect(merge([], [up(1, 5 * HOUR), up(2, 5 * HOUR + 1)], 5)).toEqual([[1, 'upcoming']]);
        expect(merge([], [up(1, 100 * HOUR)], 168)).toEqual([[1, 'upcoming']]);
    });

    test('0 hours (off) adds no upcoming row, and the open list is exactly what it was', () => {
        expect(merge([item(1)], [up(2, 60)], 0)).toEqual([[1, undefined]]);
    });

    test('an item that has already started, or starts right now, is dropped: it is open now', () => {
        expect(merge([], [up(1, -1), up(2, 0), up(3, 1)])).toEqual([[3, 'upcoming']]);
    });

    test('an item with no usable start is dropped', () => {
        const garbage = [
            up(1, Number.NaN),
            up(2, Number.POSITIVE_INFINITY),
            item(3, { status: 'upcoming' }),
            item(4, { status: 'upcoming', start_time: '3600' }),
            item(5, { status: 'upcoming', start_time: null }),
        ];
        expect(merge([], garbage)).toEqual([]);
    });

    test('an item without an id, and a null, are dropped from both lists', () => {
        expect(
            merge(
                [null, item(1), invalid<Challenge>({ title: 'no id' })],
                [null, up(2, HOUR), invalid<Challenge>({ start_time: NOW + 60 })],
            ),
        ).toEqual([
            [1, undefined],
            [undefined, undefined],
            [2, 'upcoming'],
        ]);
    });

    test('equal starts go by id, numbers in numeric order, and the order does not depend on the input order', () => {
        const rows = [up(10, HOUR), up(9, HOUR), up('b', HOUR), up('a', HOUR), up(2, 60)];
        const expected = [2, 9, 10, 'a', 'b'];
        expect(merge([], rows).map(([id]) => id)).toEqual(expected);
        expect(merge([], [...rows].reverse()).map(([id]) => id)).toEqual(expected);
    });

    test('an upcoming row is marked upcoming even when the server did not say so', () => {
        expect(merge([], [item(1, { start_time: NOW + 60 })])).toEqual([[1, 'upcoming']]);
    });

    test(`shows the ${MAX_UPCOMING_ROWS} soonest upcoming rows, however many open ones there are`, () => {
        const many = Array.from({ length: 150 }, (_, i) => up(1000 + i, 60 + i));
        const open = Array.from({ length: 120 }, (_, i) => item(i + 1));
        const merged = mergeDiscoverLists({ open, upcoming: many, hours: 24, nowSec: NOW });
        expect(merged).toHaveLength(120 + MAX_UPCOMING_ROWS);
        expect(merged.at(-1)?.id).toBe(1000 + MAX_UPCOMING_ROWS - 1);
    });

    test('does not change the lists it is given', () => {
        const open = [item(1, { status: 'started' })];
        const upcoming = [up(2, HOUR)];
        mergeDiscoverLists({ open, upcoming, hours: 24, nowSec: NOW });
        expect(open[0].status).toBe('started');
        expect(upcoming[0].status).toBe('upcoming');
    });
});

describe('fetchUpcoming', () => {
    let clock = 0;
    const now = () => clock;
    const list = [item(1)];

    beforeEach(() => {
        clock = 1_000_000;
        clearUpcomingCache();
    });

    test('a burst of calls costs one request, and the answer is shared', async () => {
        const fetchList = jest.fn(async () => list);
        const answers = await Promise.all([
            fetchUpcoming('tok', fetchList, now),
            fetchUpcoming('tok', fetchList, now),
            fetchUpcoming('tok', fetchList, now),
        ]);
        expect(fetchList).toHaveBeenCalledTimes(1);
        expect(fetchList).toHaveBeenCalledWith('tok', 'upcoming');
        expect(answers).toEqual([list, list, list]);
    });

    test('the cached list is reused for under a minute, then asked for again', async () => {
        const fetchList = jest.fn(async () => list);
        await fetchUpcoming('tok', fetchList, now);
        clock += UPCOMING_CACHE_MS - 1;
        await fetchUpcoming('tok', fetchList, now);
        expect(fetchList).toHaveBeenCalledTimes(1);
        clock += 1;
        await fetchUpcoming('tok', fetchList, now);
        expect(fetchList).toHaveBeenCalledTimes(2);
    });

    test('clearing forgets the cached one', async () => {
        const fetchList = jest.fn(async (_token: string, _filter: 'upcoming') => list);
        await fetchUpcoming('tok-a', fetchList, now);
        await fetchUpcoming('tok-a', fetchList, now);
        expect(fetchList).toHaveBeenCalledTimes(1);
        clearUpcomingCache();
        await fetchUpcoming('tok-a', fetchList, now);
        expect(fetchList).toHaveBeenCalledTimes(2);
    });

    test('a failed fetch (null) is not kept: the next call asks again', async () => {
        const fetchList = jest
            .fn<Promise<Challenge[] | null>, []>()
            .mockResolvedValueOnce(null)
            .mockResolvedValue(list);
        expect(await fetchUpcoming('tok', fetchList, now)).toBeNull();
        expect(await fetchUpcoming('tok', fetchList, now)).toBe(list);
        expect(fetchList).toHaveBeenCalledTimes(2);
        // ...and the good answer is kept.
        await fetchUpcoming('tok', fetchList, now);
        expect(fetchList).toHaveBeenCalledTimes(2);
    });

    test('a fetch that throws is not kept either, and still reaches the caller', async () => {
        const fetchList = jest
            .fn<Promise<Challenge[] | null>, []>()
            .mockRejectedValueOnce(new Error('503'))
            .mockResolvedValue(list);
        await expect(fetchUpcoming('tok', fetchList, now)).rejects.toThrow('503');
        expect(await fetchUpcoming('tok', fetchList, now)).toBe(list);
    });

    test('a failure never evicts a newer entry', async () => {
        let release: (value: Challenge[] | null) => void = () => undefined;
        const slow = jest.fn(() => new Promise<Challenge[] | null>((resolve) => (release = resolve)));
        const first = fetchUpcoming('tok', slow, now);
        // A minute on, a second fetch replaces the entry while the first is still out.
        clock += UPCOMING_CACHE_MS;
        const fresh = jest.fn(async () => list);
        await fetchUpcoming('tok', fresh, now);
        release(null);
        await first;
        await fetchUpcoming('tok', fresh, now);
        expect(fresh).toHaveBeenCalledTimes(1);
    });

    test('defaults to the wall clock', async () => {
        const fetchList = jest.fn(async () => list);
        await fetchUpcoming('tok', fetchList);
        await fetchUpcoming('tok', fetchList);
        expect(fetchList).toHaveBeenCalledTimes(1);
    });

    test('a fetch that an account switch superseded never deletes a newer entry', async () => {
        // The old fetch fails after the account switch cleared the cache and a new fetch stored its
        // entry: the failure-cleanup matches the entry it belongs to, not the slot.
        const first = jest.fn<Promise<Challenge[] | null>, []>().mockRejectedValue(new Error('down'));
        await expect(fetchUpcoming('tok-a', first, now)).rejects.toThrow('down');
        clearUpcomingCache();
        const second = jest.fn(async () => list);
        await fetchUpcoming('tok-b', second, now);
        await fetchUpcoming('tok-b', second, now);
        expect(second).toHaveBeenCalledTimes(1);
    });
});
