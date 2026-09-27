/**
 * Mock counterpart to api/rewards.ts: the finished-challenge and mission
 * prize reads and their claims.
 */

import { simulateApiResponse, mockMethod } from '../simulate';
import type * as rewardsModule from '../../api/rewards';

/**
 * Simulate /rest/get_my_completed_challenges: one finished challenge with
 * unclaimed rewards (claim_state CLAIM) and one already claimed, shaped like
 * the captured web payload. A single short page, so paging stops at once.
 */
const getMyCompletedChallenges: typeof rewardsModule.getMyCompletedChallenges = mockMethod(
    {
        name: 'getMyCompletedChallenges',
        tokenArg: 0,
        onNoToken: () => [],
    },
    async () => {
        await simulateApiResponse({}, 200);
        const rewards = (claimState: string) => ({
            claim_state: claimState,
            sections: [{ type: 'TOTAL', name: 'Total', resources: [{ type: 'COINS', title: 'Coins', value: 60 }] }],
        });
        return [
            { id: 900101, title: 'Mock Finished Challenge', member: { rewards_by_section: rewards('CLAIM') } },
            { id: 900102, title: 'Mock Claimed Challenge', member: { rewards_by_section: rewards('CLAIMED') } },
        ];
    },
);

/**
 * Simulate /rest/claim_resources — always confirms.
 */
const claimChallengeResources: typeof rewardsModule.claimChallengeResources = mockMethod(
    {
        name: 'claimChallengeResources',
        tokenArg: 1,
        onNoToken: () => false,
    },
    async () => {
        await simulateApiResponse({}, 200);
        return true;
    },
);

/**
 * Simulate /rest/get_my_missions: one completed mission (claim_state CLAIM)
 * and two still in progress (DISABLED) — one a "Win Turbo" mission, so mock
 * mode exercises the mission-aware turbo earn.
 */
const getMyMissions: typeof rewardsModule.getMyMissions = mockMethod(
    {
        name: 'getMyMissions',
        tokenArg: 0,
        onNoToken: () => [],
    },
    async () => {
        await simulateApiResponse({}, 200);
        return [
            {
                id: 900201,
                name: 'Vote on 400 photos',
                progress: { current: 400, required: 400 },
                prizes: [{ type: 'COINS', amount: 20 }],
                claim_state: 'CLAIM',
            },
            {
                id: 900202,
                name: 'Play 6 Duels',
                progress: { current: 0, required: 6 },
                prizes: [{ type: 'COINS', amount: 60 }],
                claim_state: 'DISABLED',
            },
            {
                id: 900203,
                name: 'Win Turbo 4 times',
                progress: { current: 1, required: 4 },
                prizes: [{ type: 'COINS', amount: 30 }],
                claim_state: 'DISABLED',
            },
        ];
    },
);

/**
 * Simulate /rest/claim_mission_prizes — always confirms.
 */
const claimMissionPrize: typeof rewardsModule.claimMissionPrize = mockMethod(
    {
        name: 'claimMissionPrize',
        tokenArg: 1,
        onNoToken: () => false,
    },
    async () => {
        await simulateApiResponse({}, 200);
        return true;
    },
);

export { getMyCompletedChallenges, claimChallengeResources, getMyMissions, claimMissionPrize };
