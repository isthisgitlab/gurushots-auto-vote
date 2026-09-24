/**
 * Mock counterpart to api/rewards.js: the finished-challenge and mission
 * prize reads and their claims.
 */

const { simulateApiResponse, mockMethod } = require('../simulate');

/**
 * Simulate /rest/get_my_completed_challenges: one finished challenge with
 * unclaimed rewards (claim_state CLAIM) and one already claimed, shaped like
 * the captured web payload. A single short page, so paging stops at once.
 */
const getMyCompletedChallenges = mockMethod(
    {
        name: 'getMyCompletedChallenges',
        tokenArg: 0,
        onNoToken: () => [],
    },
    async () => {
        await simulateApiResponse({}, 200);
        const rewards = (claimState) => ({
            claim_state: claimState,
            sections: [{ type: 'TOTAL', name: 'Total', resources: [{ type: 'COINS', title: 'Coins', value: 60 }] }],
        });
        return [
            { id: 900101, title: 'Mock Finished Challenge', member: { rewards_by_section: rewards('CLAIM') } },
            { id: 900102, title: 'Mock Claimed Challenge', member: { rewards_by_section: rewards('CLAIMED') } },
        ];
    },
);

/** Simulate /rest/claim_resources — always confirms. */
const claimChallengeResources = mockMethod(
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
 * and one still in progress (DISABLED).
 */
const getMyMissions = mockMethod(
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
        ];
    },
);

/** Simulate /rest/claim_mission_prizes — always confirms. */
const claimMissionPrize = mockMethod(
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

module.exports = { getMyCompletedChallenges, claimChallengeResources, getMyMissions, claimMissionPrize };
