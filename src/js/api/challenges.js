/**
 * GuruShots Auto Voter - Challenges Module
 *
 * This module handles fetching active challenges for the authenticated user.
 */

const { makePostRequest, createCommonHeaders } = require('./api-client');
const { ENDPOINTS } = require('./constants');
const logger = require('../logger');
const { pinChallengeTitles } = require('../services/challengeTitlePin');

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

    // Pin first-seen titles AFTER the failed-request guard above — a network
    // blip must never reach the pin/prune logic (it would wipe pins). The
    // server mutates `title` while an event (turbo) is active; pinning keeps
    // display and title-rule matching stable (see services/challengeTitlePin).
    if (Array.isArray(response.challenges)) {
        pinChallengeTitles(response.challenges);
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

// In-flight request coalescing. Independent consumers can want the current
// active-challenge list at the same instant — e.g. a UI challenges refresh
// racing an in-progress voting cycle. We share the in-flight promise per token
// and clear it as soon as the request settles, so only genuinely *concurrent*
// calls are merged; a later (sequential) call still hits the network for fresh
// data. No resolved-result caching, so this never serves stale challenge state.
//
// Note: the scheduler's post-cycle threshold re-check used to fire a second,
// sequential fetch here every cycle (the back-to-back duplicate seen in the
// logs). That step now reuses the list the voting cycle already fetched (see
// runScheduler.js / AutovoteContext.jsx / headless/index.js), so coalescing is
// no longer what dedupes it — the redundant call is gone at the source.
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
