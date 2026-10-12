/**
 * GuruShots Auto Voter - Boost Module
 *
 * This module handles applying boosts to photos in challenges.
 */

import { makePostRequest, createCommonHeaders, FORM_CONTENT_TYPE } from './api-client';
import { ENDPOINTS } from './constants';
import * as logger from '../logger';

import type { SuccessResponse } from '../types/gurushots';

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
 */
const _postBoost = async (challengeId: string, imageId: string, token: string): Promise<SuccessResponse | null> => {
    const data = new URLSearchParams({
        c_id: challengeId,
        image_id: imageId,
    }).toString();
    const headers = {
        ...createCommonHeaders(token),
        'content-type': FORM_CONTENT_TYPE,
    };
    return await makePostRequest<SuccessResponse>(ENDPOINTS.boostPhoto, headers, data);
};

/**
 * Boosts an already-chosen entry of a challenge — the auto-cycle transport.
 * Picking the entry (and flagging it as boosted) is the caller's job; see
 * strategies/real/applyBoost.ts.
 *
 * @param challengeId - Challenge ID (already stringified)
 * @param boostImageId - Image ID of the chosen entry
 * @param token - Authentication token
 * @returns API response or null if boost failed
 */
const boostImage = async (
    challengeId: string,
    boostImageId: string,
    token: string,
): Promise<SuccessResponse | null> => {
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
 * @param challengeId - Challenge ID
 * @param imageId - Image ID to boost
 * @param token - Authentication token
 * @returns API response or null if boost failed
 */
const applyBoostToEntry = async (
    challengeId: number | string | null | undefined,
    imageId: string | null | undefined,
    token: string,
): Promise<SuccessResponse | null> => {
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
