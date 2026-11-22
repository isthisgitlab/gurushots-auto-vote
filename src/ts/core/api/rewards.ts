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
import type { TransportPolicy } from './transportPolicy';
import { ENDPOINTS, createWebHeaders, makeRequireValue } from './constants';

import type {
    CompletedChallenge,
    CompletedChallengesResponse,
    Mission,
    MissionsResponse,
    SuccessResponse,
} from '../types/gurushots';

const requireValue = makeRequireValue('rewards');

/**
 * Reads one page of the member's completed challenges (newest first).
 *
 * @param limit the page size the web app uses
 * @param policy the transport policy to read under (the baseline policy of a scenario's evidence read); without it
 *   the effective policy is captured, as for any business request
 * @returns the challenges (a confirmed empty page is []), or null on a failed request or a body with no list
 */
const getMyCompletedChallenges = async (
    token: string,
    start: number = 0,
    limit: number = 20,
    policy?: TransportPolicy,
): Promise<CompletedChallenge[] | null> => {
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = [`start=${encodeURIComponent(String(start))}`, `limit=${encodeURIComponent(String(limit))}`].join('&');
    const response = await makePostRequest<CompletedChallengesResponse>(
        ENDPOINTS.getMyCompletedChallenges,
        headers,
        data,
        policy,
    );
    if (!response || !Array.isArray(response.completed_challenges)) {
        return null;
    }
    return response.completed_challenges;
};

/**
 * Claims a finished challenge's rewards.
 *
 * @param challengeId the numeric challenge id (not the url slug)
 * @returns true when the server confirmed the claim
 */
const claimChallengeResources = async (challengeId: string | number, token: string): Promise<boolean> => {
    requireValue(challengeId, 'challengeId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `challenge_id=${encodeURIComponent(String(challengeId))}`;
    const response = await makePostRequest<SuccessResponse>(ENDPOINTS.claimResources, headers, data);
    return response?.success === true;
};

/**
 * Lists the member's current missions.
 *
 * @param policy the transport policy to read under (see getMyCompletedChallenges)
 * @returns the missions (a confirmed empty list is []), or null on a failed request or a body with no list
 */
const getMyMissions = async (token: string, policy?: TransportPolicy): Promise<Mission[] | null> => {
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const response = await makePostRequest<MissionsResponse>(ENDPOINTS.getMyMissions, headers, '', policy);
    if (!response || !Array.isArray(response.list)) {
        return null;
    }
    return response.list;
};

/**
 * Claims a completed mission's prizes.
 *
 * @returns true when the server confirmed the claim
 */
const claimMissionPrize = async (missionId: string | number, token: string): Promise<boolean> => {
    requireValue(missionId, 'missionId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `mission_id=${encodeURIComponent(String(missionId))}`;
    const response = await makePostRequest<SuccessResponse>(ENDPOINTS.claimMissionPrizes, headers, data);
    return response?.success === true;
};

export { getMyCompletedChallenges, claimChallengeResources, getMyMissions, claimMissionPrize };
