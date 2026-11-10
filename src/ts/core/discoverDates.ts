import { endTimeOf } from './format/endTime';

export const DISCOVER_SORTS = ['default', 'start', 'end', 'boostDeadline'] as const;
export type DiscoverSort = (typeof DISCOVER_SORTS)[number];

export type DiscoverDateRow = {
    id: string | number;
    status?: 'upcoming';
    start_time?: unknown;
    close_time?: unknown;
    type?: string;
    max_photo_submits?: number;
    join_coins?: number;
    member?: { submit_state?: string };
};

const DAY_SEC = 24 * 60 * 60;

export type DiscoverJoinDeadline = {
    time: number;
    kind: 'freeEntry' | 'boost';
};

/** The applicable free-entry or Boost join cutoff for one Discover row. */
export const discoverJoinDeadline = (row: DiscoverDateRow): DiscoverJoinDeadline | null => {
    const startTime = endTimeOf(row.start_time);
    const closeTime = endTimeOf(row.close_time);
    if (startTime === null || closeTime === null || closeTime <= startTime) return null;
    if (row.type === 'flash') return null;
    if (row.max_photo_submits === 1) {
        if (row.join_coins !== 0 || row.member?.submit_state === 'join_unlock') return null;
        return { time: startTime + (closeTime - startTime) / 2, kind: 'freeEntry' };
    }
    return { time: startTime + Math.min((closeTime - startTime) / 4, DAY_SEC), kind: 'boost' };
};

const sortTime = (row: DiscoverDateRow, sort: Exclude<DiscoverSort, 'default'>): number | null =>
    sort === 'start'
        ? endTimeOf(row.start_time)
        : sort === 'end'
          ? endTimeOf(row.close_time)
          : (discoverJoinDeadline(row)?.time ?? null);

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
