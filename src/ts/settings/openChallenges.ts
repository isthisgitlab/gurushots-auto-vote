/**
 * The ids of the most recent open (joinable) challenge list, kept in memory so
 * cleanupStaleChallengeSetting can tell "not joined yet" from "gone".
 *
 * Process-local on purpose: the join pass and the Discover handler fill it
 * whenever they fetch get_member_challenges, and the cleanup runs in the same
 * main process. Until a list has been fetched it is unknown (null).
 *
 * An empty fetch result never counts as a list: getMemberChallenges returns []
 * for a failed request as well as for a genuinely empty list, and a list wrongly
 * remembered as empty would make cleanup delete every chosen-photos entry.
 */

let openIds: Set<string> | null = null;

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

// Test-only: forget the list between cases.
const __resetOpenChallengeIds = (): void => {
    openIds = null;
};

export { rememberOpenChallengeIds, getOpenChallengeIds, __resetOpenChallengeIds };
