// @ts-check
/**
 * GuruShots Auto Voter - Boost Module
 *
 * This module handles applying boosts to photos in challenges.
 */

import { makePostRequest, createCommonHeaders, FORM_CONTENT_TYPE } from './api-client';
import { ENDPOINTS } from './constants';
import * as logger from '../logger';

/** @import { SuccessResponse } from '../types/gurushots' */

/**
 * POST the GuruShots boost-photo endpoint. Concentrates the form-encoded
 * c_id / image_id contract so the two wrappers below cannot drift apart
 * if the upstream API ever changes shape. Note: turbo's endpoint uses
 * `challenge_id` not `c_id` (verified API contract difference), so the
 * helper is local to boost only — not shared with turbo.
 *
 * Uses URLSearchParams for RFC-compliant application/x-www-form-urlencoded
 * encoding (space → `+`, reserved chars percent-encoded). Both callers
 * normalize their ids first (boostImage's caller stringifies and guards the
 * entry id, applyBoostToEntry maps null/undefined to ''), so values arrive as-is.
 *
 * @param {string} challengeId
 * @param {string} imageId
 * @param {string} token
 * @returns {Promise<SuccessResponse | null>}
 */
const _postBoost = async (challengeId, imageId, token) => {
    const data = new URLSearchParams({
        c_id: String(challengeId),
        image_id: String(imageId),
    }).toString();
    const headers = {
        ...createCommonHeaders(token),
        'content-type': FORM_CONTENT_TYPE,
    };
    return /** @type {SuccessResponse | null} */ (await makePostRequest(ENDPOINTS.boostPhoto, headers, data));
};

/**
 * Boosts an already-chosen entry of a challenge — the auto-cycle transport.
 * Picking the entry (and flagging it as boosted) is the caller's job; see
 * strategies/real/applyBoost.js.
 *
 * @param {string} challengeId - Challenge ID (already stringified)
 * @param {string} boostImageId - Image ID of the chosen entry
 * @param {string} token - Authentication token
 * @returns {Promise<SuccessResponse|null>} - API response or null if boost failed
 */
const boostImage = async (challengeId, boostImageId, token) => {
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
 * @param {number|string|null|undefined} challengeId - Challenge ID
 * @param {string|null|undefined} imageId - Image ID to boost
 * @param {string} token - Authentication token
 * @returns {Promise<SuccessResponse|null>} - API response or null if boost failed
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

export { boostImage, applyBoostToEntry };
