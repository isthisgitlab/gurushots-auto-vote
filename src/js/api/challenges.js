/**
 * GuruShots Auto Voter - Challenges Module
 *
 * This module handles fetching active challenges for the authenticated user.
 */

const { makePostRequest, createCommonHeaders } = require('./api-client');
const { ENDPOINTS } = require('./constants');
const logger = require('../logger');

/**
 * Fetches all active challenges for the authenticated user
 *
 * @param {string} token - Authentication token
 * @returns {object} Response containing array of active challenges
 *                   or empty challenges array if request fails
 */
const getActiveChallenges = async (token) => {
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

module.exports = {
    getActiveChallenges,
};
