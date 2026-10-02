import * as logger from '../../logger';
import { findActiveChallenge } from '../../services/findActiveChallenge';
import { invalidArgs } from '../isIdArg';

import type { ApiStrategy } from '../../apiFactory';
import type { ActiveChallengesResponse, Challenge } from '../../types/gurushots';

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

/**
 * Re-fetch the active list and resolve one challenge from it (null when it is gone).
 */
const fetchLiveChallenge = async (
    strategy: ApiStrategy,
    token: string,
    challengeId: string | number,
): Promise<Challenge | null> => {
    const challengesResponse: ActiveChallengesResponse | null = await strategy.getActiveChallenges(token);
    return findActiveChallenge(challengesResponse?.challenges, challengeId);
};

export { sanitizeForLog, refuseInvalidArgs, fetchLiveChallenge };
