import { useEffect, useRef, useState } from 'react';
import { useTick } from './useTick';
import { useLatestRef } from './useLatestRef';

import type { OpenChallenge } from '../../types/gurushots';

/** How long a challenge whose start has passed waits for the open list to show it. */
const STARTING_GRACE_SEC = 600;
/** How often the list is re-read meanwhile. */
const STARTING_RECHECK_MS = 60_000;
/** How often "Starts in …" text is refreshed (minute granularity, so no faster). */
const CLOCK_TICK_MS = 30_000;
// The longest a timer may wait (setTimeout overflows past this and fires at once).
const MAX_TIMER_MS = 2 ** 31 - 1;

const isUpcoming = (c: OpenChallenge): boolean => c.status === 'upcoming';
const startOf = (c: OpenChallenge): number => Number(c.start_time);

/**
 * The rows Discover shows, and when the list is read again.
 *
 * The open list can lag the moment a challenge starts: the upcoming list drops it and the open one
 * has not picked it up yet, so it would vanish from the list — with its chosen photos — for a while.
 * A row that was upcoming and whose start has passed therefore stays, as "starting now", for up to
 * STARTING_GRACE_SEC after the start or until the open list shows it, and the list is re-read every
 * STARTING_RECHECK_MS meanwhile. The list is also re-read when the soonest upcoming start arrives.
 * A failed read (`failed`) changes nothing: the rows that were shown are the ones to keep.
 *
 * @returns the rows (open ones, those starting now, the upcoming ones) and the current time in seconds
 */
export function useDiscoverRows(
    items: OpenChallenge[],
    failed: boolean,
    refetch: () => Promise<void>,
): { rows: OpenChallenge[]; nowSec: number } {
    const [kept, setKept] = useState<OpenChallenge[]>([]);
    const shown = useRef<OpenChallenge[]>([]);
    const keptRef = useLatestRef(kept);
    const refetchRef = useLatestRef(refetch);
    const nowSec = Math.floor(Date.now() / 1000);
    const lingering = kept.filter((c) => nowSec < startOf(c) + STARTING_GRACE_SEC);
    const waiting = lingering.length > 0;
    // The tick only re-renders (the text is minute-grained); the time itself is read fresh.
    useTick(CLOCK_TICK_MS, items.some(isUpcoming) || waiting);

    // Each read: carry over the upcoming rows that have started and are not open yet. A failed read
    // lists nothing, so it confirms nothing: the rows of the last good read stay as they were.
    useEffect(() => {
        const now = Math.floor(Date.now() / 1000);
        const present = new Set(failed ? [] : items.map((c) => String(c.id)));
        const candidates = [...shown.current.filter(isUpcoming), ...keptRef.current];
        const carried = new Map(
            candidates
                .filter((c) => !present.has(String(c.id)) && startOf(c) <= now && now < startOf(c) + STARTING_GRACE_SEC)
                .map((c) => [String(c.id), c] as const),
        );
        if (!failed) shown.current = items;
        setKept([...carried.values()]);
    }, [items, failed, keptRef]);

    // The soonest upcoming start: read the list again then. Keyed on the list, not on the clock, so a
    // tick that lands just after the start cannot cancel the read.
    useEffect(() => {
        const now = Date.now();
        const soonest = Math.min(
            ...items
                .filter(isUpcoming)
                .map((c) => startOf(c) * 1000)
                .filter((start) => start > now),
        );
        if (!Number.isFinite(soonest)) return undefined;
        const id = setTimeout(() => void refetchRef.current(), Math.min(soonest - now + 1000, MAX_TIMER_MS));
        return () => clearTimeout(id);
    }, [items, refetchRef]);

    // While a started challenge is missing from the open list, keep asking.
    useEffect(() => {
        if (!waiting) return undefined;
        const id = setInterval(() => void refetchRef.current(), STARTING_RECHECK_MS);
        return () => clearInterval(id);
    }, [waiting, refetchRef]);

    const upcoming = items.filter(isUpcoming);
    return { rows: [...items.filter((c) => !isUpcoming(c)), ...lingering, ...upcoming], nowSec };
}
