/**
 * Mock counterpart to api/rewards.ts: the finished-challenge and mission
 * prize reads and their claims.
 */

import { simulateApiResponse, mockMethod } from '../simulate';
import type * as rewardsModule from '../../api/rewards';

/** A claim endpoint taking `(id, token)`: confirms every claim, resolves false without a token. */
const mockClaim = (name: string) =>
    mockMethod<typeof rewardsModule.claimChallengeResources | typeof rewardsModule.claimMissionPrize>(
        {
            name,
            tokenArg: 1,
            onNoToken: () => false,
        },
        async () => {
            await simulateApiResponse({}, 200);
            return true;
        },
    );

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
            { id: 900301, title: 'Telling A Story', member: { rewards_by_section: rewards('CLAIM') } },
            { id: 900302, title: "Nature's Sounds", member: { rewards_by_section: rewards('CLAIMED') } },
        ];
    },
);

/**
 * Simulate /rest/claim_resources — always confirms.
 */
const claimChallengeResources: typeof rewardsModule.claimChallengeResources = mockClaim('claimChallengeResources');

/**
 * Simulate /rest/get_my_missions: one completed mission (claim_state CLAIM)
 * and three still in progress (DISABLED), so mock mode exercises the
 * mission-aware turbo earn, boost and vote paths.
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
                name: 'Reach Allstar Level 2 times',
                progress: { current: 2, required: 2 },
                prizes: [{ type: 'COINS', amount: 60 }],
                claim_state: 'CLAIM',
            },
            {
                id: 900202,
                name: 'Win Turbo 4 times',
                progress: { current: 1, required: 4 },
                prizes: [
                    { type: 'COINS', amount: 100 },
                    { type: 'EXPOSURE_AUTOFILL', amount: 3 },
                ],
                claim_state: 'DISABLED',
            },
            {
                id: 900203,
                name: 'Vote on 400 photos',
                progress: { current: 100, required: 400 },
                prizes: [
                    { type: 'COINS', amount: 200 },
                    { type: 'EXPOSURE_AUTOFILL', amount: 6 },
                ],
                claim_state: 'DISABLED',
            },
            {
                id: 900204,
                name: 'Use a boost',
                progress: { current: 0, required: 1 },
                prizes: [
                    { type: 'COINS', amount: 500 },
                    { type: 'PHOTO_SWAP', amount: 5 },
                    { type: 'EXPOSURE_AUTOFILL', amount: 5 },
                ],
                claim_state: 'DISABLED',
            },
        ];
    },
);

/**
 * Simulate /rest/claim_mission_prizes — always confirms.
 */
const claimMissionPrize: typeof rewardsModule.claimMissionPrize = mockClaim('claimMissionPrize');

export { getMyCompletedChallenges, claimChallengeResources, getMyMissions, claimMissionPrize };
