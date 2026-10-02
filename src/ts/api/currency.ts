/**
 * GuruShots Auto Voter - Currency Module
 *
 * Web-API endpoints that SPEND bankroll currency on a challenge the member has
 * already entered, captured from a gurushots.com browser session. Uses the WEB
 * header profile (x-env: WEB, x-api-version: 13) like join/submissions.
 *
 *   keyUnlock        - spend a KEY: LOCKED/MISSED boost -> AVAILABLE_KEY (not applied)
 *   swapPhoto        - spend a SWAP: replace one entered photo with another
 *   exposureAutofill - spend a FILL: top the challenge exposure up to 100%
 *
 * Each call deducts real currency. Callers (services/currencyActions.ts) must
 * re-check the live challenge and bankroll before calling, and guard against
 * double spends.
 *
 * SECURITY: every dynamic value is form-encoded by URLSearchParams (a bare
 * `&`/`=` would otherwise inject extra form fields), and this module never logs
 * the headers object — log redaction is a key allowlist, so it only guards the
 * header names it lists.
 */

import { makePostRequest } from './api-client';
import { ENDPOINTS, createWebHeaders, makeRequireValue } from './constants';

import type { ActionResult, SuccessResponse } from '../types/gurushots';

const requireValue = makeRequireValue('currency');

const toResult = (response: SuccessResponse | null): ActionResult =>
    response ? { ok: response.success === true, raw: response } : { ok: false, raw: null };

const post = async (url: string, token: string, fields: Record<string, string>): Promise<ActionResult> => {
    const headers = createWebHeaders(token);
    const data = new URLSearchParams(fields).toString();
    return toResult(await makePostRequest<SuccessResponse>(url, headers, data));
};

/**
 * Spends a KEY to unlock a LOCKED or MISSED boost. The boost is only unlocked
 * (state AVAILABLE_KEY) — applying it to a photo is a separate call.
 */
const keyUnlock = async (
    challengeId: string | number,
    token: string,
    usage: string = 'EXPOSURE_BOOST',
): Promise<ActionResult> => {
    requireValue(challengeId, 'challengeId');
    requireValue(token, 'token');
    return post(ENDPOINTS.keyUnlock, token, { c_id: String(challengeId), usage });
};

/**
 * Spends a SWAP to replace an entered photo with another photo from the
 * member's library.
 *
 * @param oldImageId - the entry being replaced
 * @param newImageId - the replacement photo
 */
const swapPhoto = async (
    challengeId: string | number,
    oldImageId: string,
    newImageId: string,
    token: string,
): Promise<ActionResult> => {
    requireValue(challengeId, 'challengeId');
    requireValue(oldImageId, 'oldImageId');
    requireValue(newImageId, 'newImageId');
    requireValue(token, 'token');
    return post(ENDPOINTS.swap, token, {
        c_id: String(challengeId),
        el: 'challenges',
        el_id: 'true',
        img_id: oldImageId,
        new_img_id: newImageId,
    });
};

/**
 * Spends a FILL to top the challenge exposure up to 100%.
 *
 * @param memberId - the member's 32-char id (get_current_member_profile)
 */
const exposureAutofill = async (
    challengeId: string | number,
    memberId: string,
    token: string,
): Promise<ActionResult> => {
    requireValue(challengeId, 'challengeId');
    requireValue(memberId, 'memberId');
    requireValue(token, 'token');
    return post(ENDPOINTS.exposureAutofill, token, {
        'challenge_ids[0]': String(challengeId),
        el: 'my_challenges',
        el_id: memberId,
    });
};

export { keyUnlock, swapPhoto, exposureAutofill };
