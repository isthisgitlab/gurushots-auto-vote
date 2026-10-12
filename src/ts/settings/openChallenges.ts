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

let openIds: Set<string> | null = null;

/**
 * The ids of the upcoming (not started) challenges the latest Discover fetch listed, ALL of them
 * whatever window Discover shows: a chosen list saved for one must outlive the join pass and the
 * cleanup that follows it, and so must a list saved for one the window has since moved past.
 * Unknown (null) until a Discover fetch of the upcoming list has succeeded — after a restart, when
 * the first fetch fails, and when Discover has not run yet — and then cleanup keeps every entry
 * (see isKeptForJoin), the way it does while the open list is unknown. Only the Discover handler
 * writes it, only from a successful fetch; the join pass never touches it.
 */
let upcomingIds: Set<string> | null = null;

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
 * Replace the remembered upcoming list with a successful fetch's ids. Unlike the open list an
 * empty list is a real answer here: the handler calls this only on a fetch that succeeded (a
 * failed one returns null and never reaches it), and "nothing upcoming" is what lets the entries
 * of challenges that have gone be pruned. A failed fetch leaves the previous list in place.
 */
const rememberUpcomingChallengeIds = (ids: Iterable<string | number>): void => {
    upcomingIds = new Set(Array.from(ids, String));
};

/** The remembered upcoming list, or null when no fetch of it has succeeded yet. */
const getUpcomingChallengeIds = (): ReadonlySet<string> | null => upcomingIds;

/** Forget both lists: they belong to the account that just logged out (and tests start clean). */
const forgetOpenChallengeIds = (): void => {
    openIds = null;
    upcomingIds = null;
};

export {
    rememberOpenChallengeIds,
    getOpenChallengeIds,
    rememberUpcomingChallengeIds,
    getUpcomingChallengeIds,
    forgetOpenChallengeIds,
};
