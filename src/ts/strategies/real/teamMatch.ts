/**
 * Real-strategy team-match cache. The active-challenge list is read by many
 * callers (some of them spend-critical) and each team request can retry for
 * minutes, so the team read never sits on a list read's path: `latestTeamMatch`
 * answers from a one-slot cache synchronously and refreshes it in the
 * background at most once per REFRESH_MS, whatever the caller count and
 * whatever the outcome.
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
 * The cached team match for this token, synchronously; starts a background
 * refresh (not awaited) when the cache is older than REFRESH_MS or empty and
 * none is in flight. A different token drops the slot at once; an empty token
 * (signed out) drops it and sends no request.
 *
 * @returns the challenge the member's team match runs on, or undefined when
 *   there is none (or nothing is known yet)
 */
const latestTeamMatch = (token: string): TeamMatchResult | undefined => {
    latestToken = token;
    if (slot?.token !== token) slot = null;
    if (!token) return undefined;
    if (!inFlightByToken.has(token) && (!slot || Date.now() - slot.fetchedAt > REFRESH_MS)) {
        startRefresh(token);
    }
    return slot && slot.result !== 'none' ? slot.result : undefined;
};

export { latestTeamMatch };
