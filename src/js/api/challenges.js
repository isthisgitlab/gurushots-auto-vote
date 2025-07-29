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
    logger.debug('📋 === Getting Active Challenges ===', {
        token: token ? `${token.substring(0, 10)}...` : 'none',
    });

    const headers = createCommonHeaders(token);
    const response = await makePostRequest('https://api.gurushots.com/rest_mobile/get_my_active_challenges', headers);

    logger.debug('📋 === Challenges Response ===', response);

    // Handle failed requests gracefully
    if (!response) {
        logger.error('❌ Failed to fetch active challenges.');
        return {challenges: []}; // Return empty challenges to avoid crashing
    }

    // Log the structure of the response
    logger.debug('📋 === Response Structure ===', {
        responseType: typeof response,
        responseKeys: Object.keys(response || {}),
        challengesCount: response.challenges ? response.challenges.length : 'No challenges array',
    });

    return response;
};

module.exports = {
    getActiveChallenges,
}; 