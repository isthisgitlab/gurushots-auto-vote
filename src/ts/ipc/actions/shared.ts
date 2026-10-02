import * as logger from '../../logger';
import { findActiveChallenge } from '../../services/findActiveChallenge';

import type { ApiStrategy } from '../../apiFactory';
import type { ActiveChallengesResponse, Challenge } from '../../types/gurushots';

const sanitizeForLog = logger.sanitizeLogString;

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

export { sanitizeForLog, fetchLiveChallenge };
