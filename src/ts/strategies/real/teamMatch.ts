/**
 * Real-strategy team-match cache. The active-challenge list is read by many
 * callers (some of them spend-critical) and each team request can retry for
 * minutes, so the team read stays off a list read's path: `refreshTeamMatch`
 * refreshes a one-slot cache in the background at most once per REFRESH_MS,
 * whatever the caller count and whatever the outcome. `settledTeamMatch` reads
 * the cache; the one list read that started a refresh waits a bounded time for
 * it, so the list shows that refresh and not the last one.
 */

import { fetchActiveTeamMatch } from '../../api/teams';

import type { TeamMatchRead } from '../../api/teams';
import type { TeamMatch } from '../../types/gurushots';

const REFRESH_MS = 60_000;
// Consecutive failed refreshes after which the kept result stops posing as current.
const MAX_FAILURES = 3;

interface TeamMatchResult {
    challengeId: string;
    teamMatch: TeamMatch;
}

interface Slot {
    token: string;
    // 'none' is a cached answer (no team, or no match), not an absent slot.
    result: TeamMatchResult | 'none';
    fetchedAt: number;
    failures: number;
}

// Only the current token's slot is kept, so a signed-out token is not.
let slot: Slot | null = null;
let latestToken = '';
// Per token, like activeChallenges' inFlightByToken: a refresh still running for an old token
// neither blocks nor clears the new token's.
const inFlightByToken: Map<string, Promise<void>> = new Map();

const settle = (token: string, read: TeamMatchRead): void => {
    // A refresh for a token that is no longer the latest is discarded.
    if (token !== latestToken) return;
    const previous = slot?.token === token ? slot : null;
    const fetchedAt = Date.now();
    if (read.kind === 'failed') {
        // Keep the last result through a transient error, until it has failed too often to be trusted.
        const failures = (previous?.failures ?? 0) + 1;
        const kept = previous?.result ?? 'none';
        slot = { token, result: failures >= MAX_FAILURES ? 'none' : kept, fetchedAt, failures };
        return;
    }
    const result = read.kind === 'match' ? { challengeId: read.challengeId, teamMatch: read.teamMatch } : 'none';
    slot = { token, result, fetchedAt, failures: 0 };
};

const cachedResult = (token: string): TeamMatchResult | undefined =>
    slot?.token === token && slot.result !== 'none' ? slot.result : undefined;

const startRefresh = (token: string): void => {
    // fetchActiveTeamMatch never rejects; the catch keeps this promise total all the same.
    // A settle deletes only its own token's key (at most one refresh per token is ever in flight).
    const refresh = fetchActiveTeamMatch(token)
        .catch((): TeamMatchRead => ({ kind: 'failed' }))
        .then((read) => settle(token, read))
        .finally(() => inFlightByToken.delete(token));
    inFlightByToken.set(token, refresh);
};

/**
 * Starts a background refresh (not awaited) when this token's cache is older
 * than REFRESH_MS or empty and none is in flight. A different token drops the
 * slot at once; an empty token (signed out) drops it and sends no request.
 *
 * @returns true only when this call started a refresh
 */
const refreshTeamMatch = (token: string): boolean => {
    latestToken = token;
    if (slot?.token !== token) slot = null;
    if (!token) return false;
    if (inFlightByToken.has(token) || (slot && Date.now() - slot.fetchedAt <= REFRESH_MS)) return false;
    startRefresh(token);
    return true;
};

/**
 * The cached team match for this token. With `maxWaitMs` above 0 it first waits
 * for this token's in-flight refresh, for that long at most (then the previous
 * slot is returned, and the late refresh still lands in the slot for the next
 * call). Never rejects and never starts a refresh itself.
 *
 * @returns the challenge the member's team match runs on, or undefined when
 *   there is none (or nothing is known yet)
 */
const settledTeamMatch = async (token: string, maxWaitMs: number): Promise<TeamMatchResult | undefined> => {
    if (!token) return undefined;
    const refresh = inFlightByToken.get(token);
    if (refresh && maxWaitMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cap = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, maxWaitMs);
        });
        await Promise.race([refresh, cap]);
        clearTimeout(timer);
    }
    return cachedResult(token);
};

export { refreshTeamMatch, settledTeamMatch };
