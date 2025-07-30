/**
 * GuruShots Auto Voter - Boost Module
 *
 * This module handles applying boosts to photos in challenges.
 */

const {makePostRequest, createCommonHeaders, FORM_CONTENT_TYPE} = require('./api-client');
const logger = require('../logger');

/**
 * Applies a boost to a photo in a challenge
 *
 * Boosts increase the visibility of your photo in a challenge.
 * This function finds the first non-turboed photo entry and applies a boost to it.
 *
 * @param {object} challenge - Challenge object containing id and member data
 * @param {string} token - Authentication token
 * @returns {object|null} - API response or null if boost failed
 */
const applyBoost = async (challenge, token) => {
    const {id, member} = challenge;

    /**
     * Helper function to find the first non-turboed photo entry
     *
     * @param {Array} entries - Array of photo entries in the challenge
     * @returns {string|null} - ID of the first non-turboed entry or null if none found
     */
    const getFirstNonTurboKey = (entries) => {
        for (let i = 0; i < entries.length; i++) {
            if (!entries[i].turbo) {
                return entries[i].id;
            }
        }
        return null;
    };

    // Find a photo to boost
    const boostImageId = getFirstNonTurboKey(member.ranking.entries);
    if (!boostImageId) {
        logger.error('No non-turboed entries found for boosting', {challengeId: id});
        return null;
    }

    // Prepare request data
    const data = `c_id=${id}&image_id=${boostImageId}`;
    const headers = {
        ...createCommonHeaders(token),
        'content-type': FORM_CONTENT_TYPE,
    };

    // Send boost request to API
    const operationId = `apply-boost-${id}`;
    logger.startOperation(operationId, `Applying boost to image ${boostImageId} in challenge ${id}`);
    
    const response = await makePostRequest('https://api.gurushots.com/rest_mobile/boost_photo', headers, data);
    if (!response) {
        logger.endOperation(operationId, null, 'Boost application failed');
        return;
    }

    logger.endOperation(operationId, `Boost applied successfully to image ${boostImageId}`);
    return response;
};

/**
 * Applies a boost to a specific photo entry in a challenge
 *
 * @param {number} challengeId - Challenge ID
 * @param {string} imageId - Image ID to boost
 * @param {string} token - Authentication token
 * @returns {object|null} - API response or null if boost failed
 */
const applyBoostToEntry = async (challengeId, imageId, token) => {
    // Prepare request data
    const data = `c_id=${challengeId}&image_id=${imageId}`;
    const headers = {
        ...createCommonHeaders(token),
        'content-type': FORM_CONTENT_TYPE,
    };

    // Send boost request to API
    const operationId = `apply-boost-entry-${challengeId}-${imageId}`;
    logger.startOperation(operationId, `Applying boost to specific entry ${imageId} in challenge ${challengeId}`);
    
    const response = await makePostRequest('https://api.gurushots.com/rest_mobile/boost_photo', headers, data);
    if (!response) {
        logger.endOperation(operationId, null, 'Boost application to entry failed');
        return null;
    }

    logger.endOperation(operationId, `Boost applied successfully to entry ${imageId}`);
    return response;
};

module.exports = {
    applyBoost,
    applyBoostToEntry,
}; 