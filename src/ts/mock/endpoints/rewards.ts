/**
 * Mock counterpart to api/rewards.ts: the finished-challenge and mission
 * prize reads and their claims.
 */

import { simulateApiResponse, mockMethod } from '../simulate';
import { prize } from '../challenges/build';
import type * as rewardsModule from '../../api/rewards';
import type { Prize } from '../../types/gurushots';

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

/** One mission as get_my_missions sends it. */
const mission = (id: number, name: string, current: number, required: number, prizes: Prize[], state: string) => ({
    id,
    name,
    progress: { current, required },
    prizes,
    claim_state: state,
});

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
            mission(900201, 'Reach Allstar Level 2 times', 2, 2, [prize('COINS', 60)], 'CLAIM'),
            mission(
                900202,
                'Win Turbo 4 times',
                1,
                4,
                [prize('COINS', 100), prize('EXPOSURE_AUTOFILL', 3)],
                'DISABLED',
            ),
            mission(
                900203,
                'Vote on 400 photos',
                100,
                400,
                [prize('COINS', 200), prize('EXPOSURE_AUTOFILL', 6)],
                'DISABLED',
            ),
            mission(
                900204,
                'Use a boost',
                0,
                1,
                [prize('COINS', 500), prize('PHOTO_SWAP', 5), prize('EXPOSURE_AUTOFILL', 5)],
                'DISABLED',
            ),
        ];
    },
);

/**
 * Simulate /rest/claim_mission_prizes — always confirms.
 */
const claimMissionPrize: typeof rewardsModule.claimMissionPrize = mockClaim('claimMissionPrize');

export { getMyCompletedChallenges, claimChallengeResources, getMyMissions, claimMissionPrize };
