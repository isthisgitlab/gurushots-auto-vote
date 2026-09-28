/**
 * GuruShots Auto Voter - Turbo Module
 *
 * Handles the Turbo mini-game (earn) and apply-turbo flow on the
 * web API surface. The turbo endpoints live under /rest/ and use a
 * different header profile than the mobile vote/boost calls — they
 * require x-env: WEB and x-api-version: 13. The session token sent
 * via x-token works the same as the mobile flow.
 */

import { makePostRequest } from './api-client';
import { ENDPOINTS, createWebHeaders, makeRequireValue } from './constants';

import type {
    ActionResult,
    ChallengeTurboResponse,
    SuccessResponse,
    TurboBattleSet,
    TurboSelectionResponse,
    TurboSelectionResult,
} from '../types/gurushots';

const TURBO_SELECTION_DELAY_MS = 1200;

const requireValue = makeRequireValue('turbo');

/**
 * Fetches the current Turbo battle set for a challenge.
 */
const getChallengeTurbo = async (challengeId: string | number, token: string): Promise<TurboBattleSet | null> => {
    requireValue(challengeId, 'challengeId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `challenge_id=${encodeURIComponent(String(challengeId))}`;
    const response = await makePostRequest<ChallengeTurboResponse>(ENDPOINTS.challengeTurbo, headers, data);
    if (!response || !Array.isArray(response.images)) {
        return null;
    }
    return {
        battles: response.images.map((img) => ({
            firstImageId: img.first_image?.id,
            secondImageId: img.second_image?.id,
            isSuccess: img.is_success,
        })),
        maxSelections: response.max_selections,
        requiredSelections: response.required_selections,
    };
};

/**
 * Submits a single Turbo battle pick.
 *
 * @param imageId - The chosen image's id from the battle pair.
 */
const submitTurboSelection = async (
    challengeId: string | number,
    imageId: string,
    token: string,
): Promise<TurboSelectionResult> => {
    requireValue(challengeId, 'challengeId');
    requireValue(imageId, 'imageId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `challenge_id=${encodeURIComponent(String(challengeId))}&image_id=${encodeURIComponent(String(imageId))}`;
    const response = await makePostRequest<TurboSelectionResponse>(ENDPOINTS.submitTurboSelection, headers, data);
    if (!response) {
        return { ok: false, success: false, state: null, scores: null, errorCode: null, raw: null };
    }
    return {
        ok: response.success === true && response.is_successful_selection === true,
        success: response.success === true,
        state: response.state || null,
        scores: response.scores || null,
        errorCode: response.error_code || null,
        raw: response,
    };
};

/**
 * Applies a won Turbo to one of the user's entry images.
 *
 * @param imageId - The user's entry photo id (from member.ranking.entries[].id).
 */
const applyTurbo = async (challengeId: string | number, imageId: string, token: string): Promise<ActionResult> => {
    requireValue(challengeId, 'challengeId');
    requireValue(imageId, 'imageId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `challenge_id=${encodeURIComponent(String(challengeId))}&image_id=${encodeURIComponent(String(imageId))}`;
    const response = await makePostRequest<SuccessResponse>(ENDPOINTS.setTurbo, headers, data);
    if (!response) {
        return { ok: false, raw: null };
    }
    return {
        ok: response.success === true,
        raw: response,
    };
};

export { getChallengeTurbo, submitTurboSelection, applyTurbo, TURBO_SELECTION_DELAY_MS };
