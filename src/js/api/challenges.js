/**
 * GuruShots Auto Voter - Challenges Module
 *
 * This module handles fetching active challenges for the authenticated user.
 */

const { makePostRequest, createCommonHeaders } = require('./api-client');
const { ENDPOINTS } = require('./constants');
const logger = require('../logger');

const fetchActiveChallenges = async (token) => {
    const operationId = 'get-active-challenges';
    logger.withCategory('api').startOperation(operationId, 'Fetching active challenges', 'DEBUG');

    logger.withCategory('api').debug('Requesting active challenges from API', {
        hasToken: !!token,
        tokenPrefix: token ? `${token.substring(0, 10)}...` : 'none',
    });

    const headers = createCommonHeaders(token);
    const response = await makePostRequest(ENDPOINTS.activeChallenges, headers);

    // Handle failed requests gracefully
    if (!response) {
        logger.withCategory('api').endOperation(operationId, null, 'API request failed');
        return { challenges: [] }; // Return empty challenges to avoid crashing
    }

    const challengeCount = response.challenges ? response.challenges.length : 0;

    // Log successful response
    logger.withCategory('api').debug('Active challenges response received', {
        challengeCount,
        hasValidStructure: !!response.challenges,
        responseKeys: Object.keys(response || {}),
    });

    logger.withCategory('api').endOperation(operationId, `retrieved ${challengeCount} challenges`);
    return response;
};

// In-flight request coalescing. A single voting cycle triggers several
// independent consumers that each want the current active-challenge list
// back-to-back — the post-cycle UI refresh and the scheduler's last-minute
// window re-check fire within the same tick. Without coalescing each issues
// its own HTTP request (the burst the user sees in the logs). We share the
// in-flight promise per token and clear it as soon as the request settles, so
// only genuinely *concurrent* calls are merged — a later (sequential) call,
// e.g. the next cycle's pre-vote fetch, still hits the network for fresh data.
// No resolved-result caching, so this never serves stale challenge state.
const inFlightByToken = new Map();

/**
 * Fetches all active challenges for the authenticated user, coalescing
 * concurrent calls for the same token into one request.
 *
 * @param {string} token - Authentication token
 * @returns {Promise<object>} Response containing array of active challenges
 *                   or empty challenges array if request fails
 */
const getActiveChallenges = (token) => {
    const key = token || '';
    const existing = inFlightByToken.get(key);
    if (existing) {
        return existing;
    }

    const request = fetchActiveChallenges(token).finally(() => {
        inFlightByToken.delete(key);
    });
    inFlightByToken.set(key, request);
    return request;
};

module.exports = {
    getActiveChallenges,
};
