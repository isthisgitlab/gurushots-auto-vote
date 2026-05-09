/**
 * GuruShots Auto Voter - Submissions Module
 *
 * Web-API endpoints captured from gurushots.com browser session for the
 * auto-fill feature: list eligible photos, submit photos to a challenge,
 * and re-fetch a single challenge's live state. Uses the same WEB header
 * profile as the turbo flow (x-env: WEB, x-api-version: 13).
 */

const { makePostRequest, FORM_CONTENT_TYPE } = require('./api-client');
const { ENDPOINTS } = require('./constants');

const requireValue = (value, label) => {
    if (value === null || value === undefined || value === '') {
        throw new Error(`submissions: ${label} is required`);
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
 * Fetches the user's photo library filtered to photos eligible for
 * submission to a given challenge. The server applies the eligibility
 * filter via permission.allowed on each item; we still defensively
 * filter again client-side in the picker.
 *
 * @param {string|number} challengeId
 * @param {string} token
 * @param {{limit?: number, start?: number}} [options]
 * @returns {Promise<Array<object>>} list of photo items, or empty array on failure
 */
const getEligiblePhotos = async (challengeId, token, options = {}) => {
    requireValue(challengeId, 'challengeId');
    requireValue(token, 'token');
    const limit = Number.isFinite(options.limit) ? options.limit : 100;
    const start = Number.isFinite(options.start) ? options.start : 0;
    const headers = createWebHeaders(token);
    const params = [
        `c_id=${encodeURIComponent(String(challengeId))}`,
        `limit=${encodeURIComponent(String(limit))}`,
        'order=date',
        'sort=desc',
        `start=${encodeURIComponent(String(start))}`,
        'usage=submit',
    ];
    const data = params.join('&');
    const response = await makePostRequest(ENDPOINTS.photosPrivate, headers, data);
    if (!response || !Array.isArray(response.items)) {
        return [];
    }
    return response.items;
};

/**
 * Submits one or more photos to a challenge.
 *
 * @param {string|number} challengeId
 * @param {Array<string>} imageIds - non-empty list of photo ids
 * @param {string} token
 * @returns {Promise<{ok: boolean, raw: object|null}>}
 */
const submitToChallenge = async (challengeId, imageIds, token) => {
    requireValue(challengeId, 'challengeId');
    requireValue(token, 'token');
    if (!Array.isArray(imageIds) || imageIds.length === 0) {
        throw new Error('submissions: imageIds must be a non-empty array');
    }
    const headers = createWebHeaders(token);
    const params = [`c_id=${encodeURIComponent(String(challengeId))}`, 'el=challenges', 'el_id=true'];
    imageIds.forEach((id, index) => {
        params.push(`image_ids[${index}]=${encodeURIComponent(String(id))}`);
    });
    const data = params.join('&');
    const response = await makePostRequest(ENDPOINTS.submitToChallenge, headers, data);
    if (!response) {
        return { ok: false, raw: null };
    }
    return {
        ok: response.success === true,
        raw: response,
    };
};

module.exports = {
    getEligiblePhotos,
    submitToChallenge,
};
