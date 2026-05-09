/**
 * GuruShots Auto Voter - Turbo Module
 *
 * Handles the Turbo mini-game (earn) and apply-turbo flow on the
 * web API surface. The turbo endpoints live under /rest/ and use a
 * different header profile than the mobile vote/boost calls — they
 * require x-env: WEB and x-api-version: 13. The session token sent
 * via x-token works the same as the mobile flow.
 */

const { makePostRequest, FORM_CONTENT_TYPE } = require('./api-client');
const { ENDPOINTS } = require('./constants');

const TURBO_SELECTION_DELAY_MS = 1200;

const requireValue = (value, label) => {
    if (value === null || value === undefined || value === '') {
        throw new Error(`turbo: ${label} is required`);
    }
    return value;
};

const createWebHeaders = (token) => ({
    host: 'api.gurushots.com',
    accept: '*/*',
    'content-type': FORM_CONTENT_TYPE,
    'x-api-version': '13',
    'x-env': 'WEB',
    'x-requested-with': 'XMLHttpRequest',
    'x-token': token,
});

/**
 * Fetches the current Turbo battle set for a challenge.
 *
 * @param {string|number} challengeId
 * @param {string} token
 * @returns {Promise<{battles: Array, maxSelections: number, requiredSelections: number}|null>}
 */
const getChallengeTurbo = async (challengeId, token) => {
    requireValue(challengeId, 'challengeId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `challenge_id=${encodeURIComponent(String(challengeId))}`;
    const response = await makePostRequest(ENDPOINTS.challengeTurbo, headers, data);
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
 * @param {string|number} challengeId
 * @param {string} imageId - The chosen image's id from the battle pair.
 * @param {string} token
 * @returns {Promise<{ok: boolean, success: boolean, state: string, scores: object, errorCode: number, raw: object|null}>}
 */
const submitTurboSelection = async (challengeId, imageId, token) => {
    requireValue(challengeId, 'challengeId');
    requireValue(imageId, 'imageId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `challenge_id=${encodeURIComponent(String(challengeId))}&image_id=${encodeURIComponent(String(imageId))}`;
    const response = await makePostRequest(ENDPOINTS.submitTurboSelection, headers, data);
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
 * @param {string|number} challengeId
 * @param {string} imageId - The user's entry photo id (from member.ranking.entries[].id).
 * @param {string} token
 * @returns {Promise<{ok: boolean, raw: object|null}>}
 */
const applyTurbo = async (challengeId, imageId, token) => {
    requireValue(challengeId, 'challengeId');
    requireValue(imageId, 'imageId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `challenge_id=${encodeURIComponent(String(challengeId))}&image_id=${encodeURIComponent(String(imageId))}`;
    const response = await makePostRequest(ENDPOINTS.setTurbo, headers, data);
    if (!response) {
        return { ok: false, raw: null };
    }
    return {
        ok: response.success === true,
        raw: response,
    };
};

module.exports = {
    getChallengeTurbo,
    submitTurboSelection,
    applyTurbo,
    TURBO_SELECTION_DELAY_MS,
};
