/**
 * The ids of the most recent open (joinable) challenge list, kept in memory so
 * cleanupStaleChallengeSetting can tell "not joined yet" from "gone".
 *
 * Process-local on purpose: the join pass and the Discover handler fill it
 * whenever they fetch get_member_challenges, and the cleanup runs in the same
 * main process. Until a list has been fetched it is unknown (null), which the
 * cleanup treats as "keep".
 */

let openIds: Set<string> | null = null;

/**
 * Replace the remembered open list. Ids are compared as strings, the way
 * perChallenge keys are.
 */
const rememberOpenChallengeIds = (ids: Iterable<string | number>): void => {
    openIds = new Set(Array.from(ids, String));
};

/** The remembered open list, or null when none has been fetched yet. */
const getOpenChallengeIds = (): ReadonlySet<string> | null => openIds;

// Test-only: forget the list between cases.
const __resetOpenChallengeIds = (): void => {
    openIds = null;
};

export { rememberOpenChallengeIds, getOpenChallengeIds, __resetOpenChallengeIds };
