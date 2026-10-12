/**
 * The ids of the most recent open (joinable) challenge list, kept in memory so
 * cleanupStaleChallengeSetting can tell "not joined yet" from "gone".
 *
 * Process-local on purpose: the join pass and the Discover handler fill it
 * whenever they fetch get_member_challenges, and the cleanup runs in the same
 * main process. Until a list has been fetched it is unknown (null).
 *
 * An empty open list never counts as a list: one wrongly remembered as empty would make cleanup
 * delete every chosen-photos entry, so the previous list (or none) stays and entries are kept.
 */

import { UPCOMING_GRACE_SEC } from './limits';
import { getActiveChallengeIds } from './challengeFacts';

let openIds: Set<string> | null = null;

/**
 * The upcoming (not started) challenges the latest Discover fetch listed — ALL of them whatever
 * window Discover shows — as id -> start_time (Unix seconds), and when that fetch ran. A chosen
 * list saved for one must outlive the join pass and the cleanup that follows it, and so must a
 * list saved for one the window has since moved past.
 *
 * An id the feed drops is carried over (see rememberUpcomingChallenges) until it shows in the open
 * or active list, or UPCOMING_GRACE_SEC after its start: the upcoming feed drops a challenge the
 * moment it starts, while the open feed may not list it yet.
 *
 * Unknown (null) until a Discover fetch of the upcoming list has succeeded — after a restart, when
 * the first fetch fails, and when Discover has not run yet — and again once the fetch is older than
 * UPCOMING_STALE_MS: this process cannot tell what another one (the CLI) has chosen photos for since.
 * Cleanup keeps every entry while it is unknown (see isKeptForJoin), the way it does for the open
 * list. Only the Discover handler writes it, only from a successful fetch; the join pass never does.
 */
let upcoming: { at: number; starts: Map<string, number> } | null = null;

/** A set older than this is treated as unknown: other processes may have saved lists since. */
const UPCOMING_STALE_MS = 5 * 60 * 1000;

/**
 * Replace the remembered open list. Ids are compared as strings, the way
 * perChallenge keys are. An empty list is treated as unknown: the previous list
 * (or none) stays.
 */
const rememberOpenChallengeIds = (ids: Iterable<string | number>): void => {
    const next = new Set(Array.from(ids, String));
    if (next.size > 0) openIds = next;
};

/** The remembered open list, or null when none has been fetched yet. */
const getOpenChallengeIds = (): ReadonlySet<string> | null => openIds;

/**
 * Replace the remembered upcoming list with a successful fetch's items. Unlike the open list an
 * empty list is a real answer here: the handler calls this only on a fetch that succeeded (a
 * failed one returns null and never reaches it), and "nothing upcoming" is what lets the entries
 * of challenges that have gone be pruned. A failed fetch leaves the previous list in place.
 *
 * Every id the previous list knew that the fetch no longer has is carried over with its start
 * time, until it is in the open or active list, or UPCOMING_GRACE_SEC has passed since its start.
 *
 * @param items - the fetch's challenges (an item without an id is ignored)
 * @param nowMs - the clock, injectable for tests
 */
const rememberUpcomingChallenges = (
    items: ReadonlyArray<{ id?: string | number | null; start_time?: unknown } | null>,
    nowMs: number = Date.now(),
): void => {
    const nowSec = nowMs / 1000;
    const starts = new Map<string, number>();
    for (const item of items) {
        if (item?.id == null) continue;
        const start = Number(item.start_time);
        starts.set(String(item.id), Number.isFinite(start) ? start : nowSec);
    }
    const active = getActiveChallengeIds();
    for (const [id, start] of upcoming?.starts ?? []) {
        if (starts.has(id) || openIds?.has(id) || active?.has(id)) continue;
        if (nowSec < start + UPCOMING_GRACE_SEC) starts.set(id, start);
    }
    upcoming = { at: nowMs, starts };
};

/** The remembered upcoming ids, or null when no fetch has succeeded yet or the last one is stale. */
const getUpcomingChallengeIds = (nowMs: number = Date.now()): ReadonlySet<string> | null =>
    upcoming === null || nowMs - upcoming.at > UPCOMING_STALE_MS ? null : new Set(upcoming.starts.keys());

/** Forget both lists: they belong to the account that just logged out (and tests start clean). */
const forgetOpenChallengeIds = (): void => {
    openIds = null;
    upcoming = null;
};

export {
    rememberOpenChallengeIds,
    getOpenChallengeIds,
    rememberUpcomingChallenges,
    getUpcomingChallengeIds,
    forgetOpenChallengeIds,
    UPCOMING_STALE_MS,
};
