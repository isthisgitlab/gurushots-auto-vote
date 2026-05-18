/**
 * GuruShots Auto Voter - Boost Module
 *
 * This module handles applying boosts to photos in challenges.
 */

const { makePostRequest, createCommonHeaders, FORM_CONTENT_TYPE } = require('./api-client');
const { ENDPOINTS } = require('./constants');
const logger = require('../logger');
const settings = require('../settings');
const { pickEntryAvoidingConflict } = require('../services/VotingLogic');

/**
 * POST the GuruShots boost-photo endpoint. Concentrates the form-encoded
 * c_id / image_id contract so the two wrappers below cannot drift apart
 * if the upstream API ever changes shape. Note: turbo's endpoint uses
 * `challenge_id` not `c_id` (verified API contract difference), so the
 * helper is local to boost only — not shared with turbo.
 *
 * Uses URLSearchParams for RFC-compliant application/x-www-form-urlencoded
 * encoding (space → `+`, reserved chars percent-encoded). Callers must pass
 * already-normalized string values; non-string inputs are stringified.
 */
const _postBoost = async (challengeId, imageId, token) => {
    const data = new URLSearchParams({
        c_id: String(challengeId ?? ''),
        image_id: String(imageId ?? ''),
    }).toString();
    const headers = {
        ...createCommonHeaders(token),
        'content-type': FORM_CONTENT_TYPE,
    };
    return await makePostRequest(ENDPOINTS.boostPhoto, headers, data);
};

/**
 * Pick the entry to boost based on `boostImageIndex` (1-indexed, 0 = last),
 * avoiding any entry that already has turbo applied. Symmetric to the
 * shouldApplyTurbo picker which avoids boosted entries.
 */
const _pickBoostEntry = (entries, challengeId) => {
    const requestedIndex = settings.getEffectiveSetting('boostImageIndex', challengeId);
    return pickEntryAvoidingConflict(entries, requestedIndex, 'turbo');
};

/**
 * Applies a boost to a photo in a challenge
 *
 * Boosts increase the visibility of your photo in a challenge.
 * Picks the entry via `boostImageIndex`, walking backward past any
 * turboed entry until a non-turboed one is found.
 *
 * @param {object} challenge - Challenge object containing id and member data
 * @param {string} token - Authentication token
 * @returns {object|null} - API response or null if boost failed
 */
const applyBoost = async (challenge, token) => {
    const { id, member } = challenge;
    const challengeId = id?.toString?.() || '';
    const entries = member?.ranking?.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
        logger.withCategory('voting').error('No entries available for boosting', { challengeId });
        return null;
    }
    const picked = _pickBoostEntry(entries, challengeId);
    if (!picked) {
        logger
            .withCategory('voting')
            .error("Couldn't apply Boost — your only entry already has Turbo (Boost and Turbo can't share an entry)", {
                challengeId,
            });
        return null;
    }
    const boostImageId = picked.id;
    if (!boostImageId) {
        logger.withCategory('voting').error('Selected boost entry has no id', { challengeId });
        return null;
    }

    const operationId = `apply-boost-${challengeId}`;
    logger
        .withCategory('boost')
        .startOperation(operationId, `Applying boost to image ${boostImageId} in challenge ${challengeId}`, 'DEBUG');

    const response = await _postBoost(challengeId, boostImageId, token);
    if (!response) {
        logger.withCategory('boost').endOperation(operationId, null, 'Boost application failed');
        return null;
    }

    logger.withCategory('boost').endOperation(operationId, `boost applied to image ${boostImageId}`);
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
    const cid = String(challengeId ?? '');
    const iid = String(imageId ?? '');
    const operationId = `apply-boost-entry-${cid}-${iid}`;
    logger
        .withCategory('boost')
        .startOperation(operationId, `Applying boost to specific entry ${iid} in challenge ${cid}`);

    const response = await _postBoost(cid, iid, token);
    if (!response) {
        logger.withCategory('boost').endOperation(operationId, null, 'Boost application to entry failed');
        return null;
    }

    logger.withCategory('boost').endOperation(operationId, `Boost applied successfully to entry ${iid}`);
    return response;
};

module.exports = {
    applyBoost,
    applyBoostToEntry,
};
