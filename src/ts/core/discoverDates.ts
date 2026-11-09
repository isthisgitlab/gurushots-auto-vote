import { endTimeOf } from './format/endTime';

export const DISCOVER_SORTS = ['default', 'start', 'end', 'boostDeadline'] as const;
export type DiscoverSort = (typeof DISCOVER_SORTS)[number];

export type DiscoverDateRow = {
    id: string | number;
    status?: 'upcoming';
    start_time?: unknown;
    close_time?: unknown;
};

const DAY_SEC = 24 * 60 * 60;

/** The last moment a challenge can be joined and still qualify for a free Boost. */
export const freeBoostJoinDeadline = (start: unknown, close: unknown): number | null => {
    const startTime = endTimeOf(start);
    const closeTime = endTimeOf(close);
    if (startTime === null || closeTime === null || closeTime <= startTime) return null;
    return startTime + Math.min((closeTime - startTime) / 4, DAY_SEC);
};

const sortTime = (row: DiscoverDateRow, sort: Exclude<DiscoverSort, 'default'>): number | null =>
    sort === 'start'
        ? endTimeOf(row.start_time)
        : sort === 'end'
          ? endTimeOf(row.close_time)
          : freeBoostJoinDeadline(row.start_time, row.close_time);

const groupOf = (row: DiscoverDateRow, nowSec: number): number => {
    if (row.status !== 'upcoming') return 0;
    const startTime = endTimeOf(row.start_time);
    return startTime !== null && startTime <= nowSec ? 1 : 2;
};

/**
 * Sort Discover rows without changing the server order in the default view. Date orders keep open,
 * starting-now, and future rows together, then put unreadable dates last within each group.
 */
export const orderDiscoverRows = <T extends DiscoverDateRow>(
    rows: readonly T[],
    sort: DiscoverSort,
    nowSec: number,
): T[] => {
    if (sort === 'default') return [...rows];
    return rows
        .map((row, index) => ({ row, index }))
        .toSorted((left, right) => {
            const group = groupOf(left.row, nowSec) - groupOf(right.row, nowSec);
            if (group !== 0) return group;
            const leftTime = sortTime(left.row, sort);
            const rightTime = sortTime(right.row, sort);
            if (leftTime === null || rightTime === null) {
                if (leftTime !== rightTime) return Number(leftTime === null) - Number(rightTime === null);
            } else if (leftTime !== rightTime) {
                return leftTime - rightTime;
            }
            const leftId = String(left.row.id);
            const rightId = String(right.row.id);
            if (leftId !== rightId) return leftId < rightId ? -1 : 1;
            return left.index - right.index;
        })
        .map(({ row }) => row);
};
