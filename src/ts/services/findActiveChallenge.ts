/**
 * Shared challenge lookup for the active-challenges list.
 *
 * The GuruShots API is not consistent about the `id` type (number in some
 * payloads, string in others), so the ONLY safe comparison is
 * String-to-String. Every lookup site must go through this helper — a
 * strict `===` against `parseInt(...)` silently misses string ids and
 * accepts garbage suffixes (`parseInt('123abc')` → 123).
 *
 * This shares the lookup predicate only; callers keep their own
 * user-facing error wording ("not found" vs "no longer active" carry
 * different meanings).
 */

import { isMarkedChallenge } from '../challengeMarks';

import type { ActiveChallengesResponse, Challenge } from '../types/gurushots';

/**
 * @param challenges - candidate list (any falsy/non-array input is treated as empty)
 * @param challengeId - id to find
 * @returns the matching challenge, or null
 */
const findActiveChallenge = <T extends { id?: unknown }>(
    challenges: T[] | null | undefined,
    challengeId: string | number,
): T | null => (Array.isArray(challenges) ? challenges : []).find((c) => String(c.id) === String(challengeId)) ?? null;

/**
 * The one lookup an ACTION uses: like findActiveChallenge, but a marked
 * challenge and a read that dropped elements refuse instead of resolving.
 *
 * Order of checks: found and marked → data-incomplete; found and clean → the
 * challenge; not listed on a prune-unsafe read → data-incomplete too (it may
 * be the element that was dropped, which cannot be told from "gone"); not
 * listed on a safe read → not-found.
 *
 * @param response - the whole active-challenges response (null treated as a safe empty read)
 * @param challengeId - id to find
 */
const findActionableChallenge = (
    response: ActiveChallengesResponse | null | undefined,
    challengeId: string | number,
): { challenge: Challenge } | { refused: 'not-found' | 'data-incomplete' } => {
    const challenge = findActiveChallenge(response?.challenges, challengeId);
    if (challenge) return isMarkedChallenge(challenge) ? { refused: 'data-incomplete' } : { challenge };
    return response?.pruneUnsafe === true ? { refused: 'data-incomplete' } : { refused: 'not-found' };
};

export { findActiveChallenge, findActionableChallenge };
