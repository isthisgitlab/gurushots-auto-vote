/**
 * Prize-claim API calls (WEB profile), captured from the web app:
 *
 *   getMyCompletedChallenges - page through finished challenges; a challenge
 *                              with unclaimed rewards carries
 *                              member.rewards_by_section.claim_state === 'CLAIM'
 *   claimChallengeResources  - claim one finished challenge's rewards
 *   getMyMissions            - list current missions; a completed, unclaimed
 *                              mission carries claim_state === 'CLAIM'
 *   claimMissionPrize        - claim one completed mission's prizes
 *
 * Both claim calls answer a bare `{success:true}` — no updated balances.
 *
 * SECURITY: every dynamic value is encodeURIComponent'd into the form body, and
 * this module never logs the headers object (log redaction is a key allowlist,
 * so it only guards the header names it lists).
 */

import { makePostRequest } from './api-client';
import { ENDPOINTS, createWebHeaders, makeRequireValue } from './constants';

/**
 * @import { CompletedChallenge, CompletedChallengesResponse, Mission, MissionsResponse, SuccessResponse } from '../types/gurushots'
 */

const requireValue = makeRequireValue('rewards');

/**
 * Reads one page of the member's completed challenges (newest first).
 *
 * @param {string} token
 * @param {number} [start=0]
 * @param {number} [limit=20] the page size the web app uses
 * @returns {Promise<CompletedChallenge[]>} the challenges, or [] on failure
 */
const getMyCompletedChallenges = async (token, start = 0, limit = 20) => {
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = [`start=${encodeURIComponent(String(start))}`, `limit=${encodeURIComponent(String(limit))}`].join('&');
    const response = /** @type {CompletedChallengesResponse | null} */ (
        await makePostRequest(ENDPOINTS.getMyCompletedChallenges, headers, data)
    );
    if (!response || !Array.isArray(response.completed_challenges)) {
        return [];
    }
    return response.completed_challenges;
};

/**
 * Claims a finished challenge's rewards.
 *
 * @param {string|number} challengeId the numeric challenge id (not the url slug)
 * @param {string} token
 * @returns {Promise<boolean>} true when the server confirmed the claim
 */
const claimChallengeResources = async (challengeId, token) => {
    requireValue(challengeId, 'challengeId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `challenge_id=${encodeURIComponent(String(challengeId))}`;
    const response = /** @type {SuccessResponse | null} */ (
        await makePostRequest(ENDPOINTS.claimResources, headers, data)
    );
    return response?.success === true;
};

/**
 * Lists the member's current missions.
 *
 * @param {string} token
 * @returns {Promise<Mission[]>} the missions, or [] on failure
 */
const getMyMissions = async (token) => {
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const response = /** @type {MissionsResponse | null} */ (
        await makePostRequest(ENDPOINTS.getMyMissions, headers, '')
    );
    if (!response || !Array.isArray(response.list)) {
        return [];
    }
    return response.list;
};

/**
 * Claims a completed mission's prizes.
 *
 * @param {string|number} missionId
 * @param {string} token
 * @returns {Promise<boolean>} true when the server confirmed the claim
 */
const claimMissionPrize = async (missionId, token) => {
    requireValue(missionId, 'missionId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `mission_id=${encodeURIComponent(String(missionId))}`;
    const response = /** @type {SuccessResponse | null} */ (
        await makePostRequest(ENDPOINTS.claimMissionPrizes, headers, data)
    );
    return response?.success === true;
};

export { getMyCompletedChallenges, claimChallengeResources, getMyMissions, claimMissionPrize };
