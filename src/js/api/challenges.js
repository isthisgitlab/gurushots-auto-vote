/**
 * GuruShots Auto Voter - Challenges Module
 *
 * This module handles fetching active challenges for the authenticated user.
 */

const {makePostRequest, createCommonHeaders} = require('./api-client');
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
    logger.startOperation(operationId, 'Fetching active challenges');
    
    logger.debug('Requesting active challenges from API', {
        hasToken: !!token,
        tokenPrefix: token ? `${token.substring(0, 10)}...` : 'none',
    });

    const headers = createCommonHeaders(token);
    const response = await makePostRequest('https://api.gurushots.com/rest_mobile/get_my_active_challenges', headers);

    // Handle failed requests gracefully
    if (!response) {
        logger.endOperation(operationId, null, 'API request failed');
        return {challenges: []}; // Return empty challenges to avoid crashing
    }

    const challengeCount = response.challenges ? response.challenges.length : 0;
    
    // Log successful response
    logger.debug('Active challenges response received', {
        challengeCount,
        hasValidStructure: !!response.challenges,
        responseKeys: Object.keys(response || {}),
    });

    logger.endOperation(operationId, `Retrieved ${challengeCount} active challenges`);
    return response;
};

module.exports = {
    getActiveChallenges,
}; 