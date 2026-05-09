/**
 * GuruShots Auto Voter - Boost Module
 *
 * This module handles applying boosts to photos in challenges.
 */

const { makePostRequest, createCommonHeaders, FORM_CONTENT_TYPE } = require('./api-client');
const { ENDPOINTS } = require('./constants');
const logger = require('../logger');

/**
 * POST the GuruShots boost-photo endpoint. Concentrates the form-encoded
 * c_id / image_id contract so the two wrappers below cannot drift apart
 * if the upstream API ever changes shape. Note: turbo's endpoint uses
 * `challenge_id` not `c_id` (verified API contract difference), so the
 * helper is local to boost only — not shared with turbo.
 */
const _postBoost = async (challengeId, imageId, token) => {
    const data = `c_id=${challengeId}&image_id=${imageId}`;
    const headers = {
        ...createCommonHeaders(token),
        'content-type': FORM_CONTENT_TYPE,
    };
    return await makePostRequest(ENDPOINTS.boostPhoto, headers, data);
};

/**
 * Find the first non-turboed photo entry. Per-entry boost/turbo are
 * mutually exclusive in the GuruShots API, so a turboed entry can't
 * accept a boost.
 */
const _getFirstNonTurboKey = (entries) => {
    for (let i = 0; i < entries.length; i++) {
        if (!entries[i].turbo) {
            return entries[i].id;
        }
    }
    return null;
};

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
    const { id, member } = challenge;
    const boostImageId = _getFirstNonTurboKey(member.ranking.entries);
    if (!boostImageId) {
        logger.withCategory('voting').error('No non-turboed entries found for boosting', { challengeId: id });
        return null;
    }

    const operationId = `apply-boost-${id}`;
    logger
        .withCategory('boost')
        .startOperation(operationId, `Applying boost to image ${boostImageId} in challenge ${id}`);

    const response = await _postBoost(id, boostImageId, token);
    if (!response) {
        logger.withCategory('boost').endOperation(operationId, null, 'Boost application failed');
        return null;
    }

    logger.withCategory('boost').endOperation(operationId, `Boost applied successfully to image ${boostImageId}`);
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
    const operationId = `apply-boost-entry-${challengeId}-${imageId}`;
    logger
        .withCategory('boost')
        .startOperation(operationId, `Applying boost to specific entry ${imageId} in challenge ${challengeId}`);

    const response = await _postBoost(challengeId, imageId, token);
    if (!response) {
        logger.withCategory('boost').endOperation(operationId, null, 'Boost application to entry failed');
        return null;
    }

    logger.withCategory('boost').endOperation(operationId, `Boost applied successfully to entry ${imageId}`);
    return response;
};

module.exports = {
    applyBoost,
    applyBoostToEntry,
};
