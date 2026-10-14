/**
 * What Discover lists: the open challenges, plus the upcoming ones (not started yet) that start
 * within the look-ahead window, so photos can be chosen for them early.
 *
 * The upcoming list is fetched whenever Discover loads — whatever the window, because the ids of
 * every upcoming challenge are what keeps their saved chosen photos from being pruned (see
 * settings/openChallenges.ts) — and cached for a minute per account, so a burst of calls costs one
 * request. The cache is keyed by a hash of the token, never the token, and is emptied at logout.
 * Nothing here decides who may join: that stays with the live open lookup in services/joinChallenges.
 */

import { tokenKey } from './accountScope';

import type { Challenge, DiscoverChallenge } from '../types/gurushots';

type ListFetcher = (token: string, filter: 'upcoming') => Promise<Challenge[] | null>;

/** How long an upcoming list is reused. */
const UPCOMING_CACHE_MS = 60_000;

/** Most upcoming rows shown: the soonest ones, so the settings-only re-read of a list stays small. */
const MAX_UPCOMING_ROWS = 100;

type CachedList = { at: number; list: Promise<Challenge[] | null> };

let cache: Map<string, CachedList> = new Map();

/**
 * The account's upcoming list: the cached one while it is under a minute old, else a fresh fetch
 * (a burst of callers shares one request). A failed fetch (null) is not kept, so the next call asks again.
 */
const fetchUpcoming = (
    token: string,
    fetchList: ListFetcher,
    now: () => number = Date.now,
): Promise<Challenge[] | null> => {
    const key = tokenKey(token);
    const hit = cache.get(key);
    if (hit && now() - hit.at < UPCOMING_CACHE_MS) return hit.list;
    const list = fetchList(token, 'upcoming');
    const entry: CachedList = { at: now(), list };
    cache.set(key, entry);
    const forgetFailed = () => {
        if (cache.get(key) === entry) cache.delete(key);
    };
    void list.then((items) => (items === null ? forgetFailed() : undefined), forgetFailed);
    return list;
};

/** Forget every cached upcoming list (an account left, and tests start clean). */
const clearUpcomingCache = (): void => {
    cache = new Map();
};

const idOf = (c: Challenge | null): string | null => (c?.id == null ? null : String(c.id));

/** Ids in numeric order where both are numbers, else as text: a stable tie-break for equal start times. */
const byId = (a: Challenge, b: Challenge): number => String(a.id).localeCompare(String(b.id), 'en', { numeric: true });

/**
 * The Discover list: every open challenge, then the upcoming ones that start within `hours`.
 *
 * An id in both lists is the open copy (it has started). An upcoming item stays only while its
 * `start_time` is a finite number after `nowSec` and at most `hours` hours after it (the far end
 * inclusive); one whose start has passed is dropped — the server lags, it is open now and the next
 * open fetch lists it. Open rows come first, in the order the server gave them; upcoming rows follow,
 * soonest first (equal starts by id), at most MAX_UPCOMING_ROWS of them. 0 hours (off) adds none.
 */
const mergeDiscoverLists = ({
    open,
    upcoming,
    hours,
    nowSec,
}: {
    open: ReadonlyArray<Challenge | null>;
    upcoming: ReadonlyArray<Challenge | null>;
    hours: number;
    nowSec: number;
}): DiscoverChallenge[] => {
    const openIds = new Set(open.flatMap((c) => idOf(c) ?? []));
    const horizon = nowSec + hours * 3600;
    const soon = upcoming
        .filter((c): c is Challenge => {
            const id = idOf(c);
            const start = c?.start_time;
            return id !== null && !openIds.has(id) && typeof start === 'number' && start > nowSec && start <= horizon;
        })
        .sort((a, b) => a.start_time - b.start_time || byId(a, b))
        .slice(0, MAX_UPCOMING_ROWS);
    return [
        // An open row carries no status: the server's own is dropped so it never reads as the marker.
        ...open.flatMap((c): DiscoverChallenge[] => (c === null ? [] : [{ ...c, status: undefined }])),
        ...soon.map((c): DiscoverChallenge => ({ ...c, status: 'upcoming' })),
    ];
};

export { fetchUpcoming, clearUpcomingCache, mergeDiscoverLists, UPCOMING_CACHE_MS, MAX_UPCOMING_ROWS };
export type { ListFetcher };
