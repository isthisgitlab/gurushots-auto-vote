/**
 * GuruShots Auto Voter - Challenges Module
 *
 * This module handles fetching active challenges for the authenticated user.
 */

const { makePostRequest, createCommonHeaders } = require('./api-client');
const { ENDPOINTS } = require('./constants');
const logger = require('../logger');

/**
 * Fetches all active challenges for the authenticated user — one request per
 * call. Title pinning and in-flight coalescing live in the caller
 * (strategies/real/activeChallenges.js).
 *
 * @param {string} token - Authentication token
 * @returns {Promise<object>} Response containing array of active challenges, or
 *   `{ challenges: [], fetchFailed: true }` if the request fails
 */
const fetchActiveChallenges = async (token) => {
    const operationId = 'get-active-challenges';
    logger.withCategory('api').startOperation(operationId, 'Fetching active challenges', 'DEBUG');

    // Log only presence, never any slice of the token itself — a `tokenPrefix`
    // field does not match the logger's SENSITIVE_KEY_RE redaction allowlist, so
    // the first bytes of the real bearer token would land in api-*.log in
    // cleartext (log files get pasted into bug reports). `hasToken` is enough.
    logger.withCategory('api').debug('Requesting active challenges from API', {
        hasToken: !!token,
    });

    const headers = createCommonHeaders(token);
    const response = await makePostRequest(ENDPOINTS.activeChallenges, headers);

    // Handle failed requests gracefully. The empty list keeps every existing consumer
    // working, but it is flagged so callers can tell "the fetch failed" apart from "you
    // genuinely have no active challenges" — makePostRequest resolves null once retries are
    // exhausted (e.g. GuruShots returning 5xx), and without this marker a dead API produced
    // a pass that reported success with "No active challenges found" and re-armed as if
    // everything were healthy.
    if (!response) {
        logger.withCategory('api').endOperation(operationId, null, 'API request failed');
        return { challenges: [], fetchFailed: true };
    }

    const challengeCount = response.challenges ? response.challenges.length : 0;

    // Log successful response
    logger.withCategory('api').debug('Active challenges response received', {
        challengeCount,
        hasValidStructure: !!response.challenges,
        responseKeys: Object.keys(response),
    });

    logger.withCategory('api').endOperation(operationId, `retrieved ${challengeCount} challenges`);
    return response;
};

module.exports = {
    fetchActiveChallenges,
};
