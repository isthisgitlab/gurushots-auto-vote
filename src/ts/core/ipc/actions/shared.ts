import * as logger from '../../logger';
import { findActionableChallenge } from '../../services/findActiveChallenge';
import { invalidArgs } from '../isIdArg';

import type { ApiStrategy } from '../../apiFactory';
import type { ActiveChallengesResponse, Challenge } from '../../types/gurushots';
import type { LibraryUsage } from '../../types/photoPicker';

const sanitizeForLog = logger.sanitizeLogString;

/**
 * Refuse a request whose id arguments failed isIdArg: one warning naming the
 * channel (never the arguments), then the shared invalid-args result. Callers
 * return it before touching auth or the API.
 */
const refuseInvalidArgs = (category: string, channel: string) => {
    logger.withCategory(category).warning(`Refused ${channel}: invalid id argument`, null);
    return invalidArgs;
};

/** Whether a received value names a library usage; a compromised window can send anything. */
const isUsageArg = (value: unknown): value is LibraryUsage => value === 'submit' || value === 'swap';

/** The fixed error code a marked challenge refuses with. */
const DATA_INCOMPLETE_ERROR = 'challenge-data-incomplete';

/**
 * Re-fetch the active list and resolve one challenge the way an action sees
 * it: the challenge itself, or why it cannot be acted on — not listed
 * (`not-found`), or marked by the boundary / dropped by a prune-unsafe read
 * (`data-incomplete`).
 */
const fetchLiveChallenge = async (
    strategy: ApiStrategy,
    token: string,
    challengeId: string | number,
): Promise<{ challenge: Challenge } | { refused: 'not-found' | 'data-incomplete' }> => {
    const challengesResponse: ActiveChallengesResponse | null = await strategy.getActiveChallenges(token);
    return findActionableChallenge(challengesResponse, challengeId);
};

/**
 * The IPC error a refused live lookup answers with: data-incomplete gets the
 * fixed code, a plain miss reads as the challenge being gone.
 */
const liveRefusalError = (refused: 'not-found' | 'data-incomplete') =>
    refused === 'data-incomplete'
        ? ({ success: false as const, error: DATA_INCOMPLETE_ERROR } as const)
        : ({ success: false as const, error: 'Challenge no longer active' } as const);

export { sanitizeForLog, refuseInvalidArgs, isUsageArg, fetchLiveChallenge, liveRefusalError };
