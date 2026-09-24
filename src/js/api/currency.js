/**
 * GuruShots Auto Voter - Currency Module
 *
 * Web-API endpoints that SPEND bankroll currency on a challenge the member has
 * already entered, captured from a gurushots.com browser session. Uses the WEB
 * header profile (x-env: WEB, x-api-version: 13) like join/submissions.
 *
 *   keyUnlock        - spend a KEY: LOCKED boost -> AVAILABLE_KEY (not applied)
 *   swapPhoto        - spend a SWAP: replace one entered photo with another
 *   exposureAutofill - spend a FILL: top the challenge exposure up to 100%
 *
 * Each call deducts real currency. Callers (services/currencyActions.js) must
 * re-check the live challenge and bankroll before calling, and guard against
 * double spends.
 *
 * SECURITY: every dynamic value is form-encoded by URLSearchParams (a bare
 * `&`/`=` would otherwise inject extra form fields), and this module never logs
 * the headers object — log redaction is a key allowlist, so it only guards the
 * header names it lists.
 */

const { makePostRequest } = require('./api-client');
const { ENDPOINTS, createWebHeaders, makeRequireValue } = require('./constants');

const requireValue = makeRequireValue('currency');

const toResult = (response) => (response ? { ok: response.success === true, raw: response } : { ok: false, raw: null });

const post = async (url, token, fields) => {
    const headers = createWebHeaders(token);
    const data = new URLSearchParams(fields).toString();
    return toResult(await makePostRequest(url, headers, data));
};

/**
 * Spends a KEY to unlock a LOCKED boost. The boost is only unlocked
 * (state AVAILABLE_KEY) — applying it to a photo is a separate call.
 *
 * @param {string|number} challengeId
 * @param {string} token
 * @param {string} [usage='EXPOSURE_BOOST']
 * @returns {Promise<{ok: boolean, raw: object|null}>}
 */
const keyUnlock = async (challengeId, token, usage = 'EXPOSURE_BOOST') => {
    requireValue(challengeId, 'challengeId');
    requireValue(token, 'token');
    return post(ENDPOINTS.keyUnlock, token, { c_id: String(challengeId), usage: String(usage) });
};

/**
 * Spends a SWAP to replace an entered photo with another photo from the
 * member's library.
 *
 * @param {string|number} challengeId
 * @param {string} oldImageId - the entry being replaced
 * @param {string} newImageId - the replacement photo
 * @param {string} token
 * @returns {Promise<{ok: boolean, raw: object|null}>}
 */
const swapPhoto = async (challengeId, oldImageId, newImageId, token) => {
    requireValue(challengeId, 'challengeId');
    requireValue(oldImageId, 'oldImageId');
    requireValue(newImageId, 'newImageId');
    requireValue(token, 'token');
    return post(ENDPOINTS.swap, token, {
        c_id: String(challengeId),
        el: 'challenges',
        el_id: 'true',
        img_id: String(oldImageId),
        new_img_id: String(newImageId),
    });
};

/**
 * Spends a FILL to top the challenge exposure up to 100%.
 *
 * @param {string|number} challengeId
 * @param {string} memberId - the member's 32-char id (get_current_member_profile)
 * @param {string} token
 * @returns {Promise<{ok: boolean, raw: object|null}>}
 */
const exposureAutofill = async (challengeId, memberId, token) => {
    requireValue(challengeId, 'challengeId');
    requireValue(memberId, 'memberId');
    requireValue(token, 'token');
    return post(ENDPOINTS.exposureAutofill, token, {
        'challenge_ids[0]': String(challengeId),
        el: 'my_challenges',
        el_id: String(memberId),
    });
};

module.exports = { keyUnlock, swapPhoto, exposureAutofill };
