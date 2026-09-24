/**
 * Mock counterpart to api/join.js: open (un-joined) challenges, the
 * bankroll, and the coin unlock.
 */

const logger = require('../../logger');
const { simulateApiResponse, mockMethod } = require('../simulate');

/**
 * Simulate /rest/get_member_challenges (un-joined "open" challenges).
 * Fixtures cover a free join, paid flash, paid normal, and a designated
 * paid id (900004) whose coinsUnlock fails — so the "coins charged but
 * submit failed" / "unlock failed" paths are exercisable without a real
 * account. Id 900005 unlocks but its submit fails (see submitToChallenge).
 */
const getMemberChallenges = mockMethod(
    {
        name: 'getMemberChallenges',
        tokenArg: 0,
        debug: (token, filter) => {
            logger.withCategory('challenges').debug(`Filter: ${filter}`, null);
        },
        onNoToken: () => [],
    },
    async () => {
        await simulateApiResponse({}, 400);
        // close_time / start_time are epoch SECONDS, matching joined
        // challenges. VERIFIED against the live get_member_challenges
        // response (2026-09-19): both are present on every open challenge,
        // alongside type/title/join_coins/tags/entries/players. Spread
        // across the join window so `autoJoinWithinHoursOfEnd` is
        // exercisable in mock mode: 900001 ends in 3h (inside any window),
        // the rest end in 2-5 days (outside a 24h one).
        const nowSec = Math.floor(Date.now() / 1000);
        return [
            {
                id: 900001,
                type: 'default',
                join_coins: 0,
                title: 'Mock Free Challenge',
                url: 'mock-free',
                start_time: nowSec - 5 * 86400,
                close_time: nowSec + 3 * 3600,
            },
            {
                id: 900002,
                type: 'flash',
                join_coins: 100,
                title: 'Mock Flash Challenge',
                url: 'mock-flash',
                start_time: nowSec - 1 * 86400,
                close_time: nowSec + 2 * 86400,
            },
            {
                id: 900003,
                type: 'default',
                join_coins: 250,
                title: 'Mock Paid Challenge',
                url: 'mock-paid',
                start_time: nowSec - 2 * 86400,
                close_time: nowSec + 5 * 86400,
            },
            {
                id: 900004,
                type: 'flash',
                join_coins: 100,
                title: 'Mock Unlock-Fails Challenge',
                url: 'mock-fail',
                start_time: nowSec - 3 * 86400,
                close_time: nowSec + 3 * 86400,
            },
            // 900005: unlock succeeds but submit fails → exercises the
            // "coins charged but not joined" (charged-pending-submit) UI/CLI path.
            {
                id: 900005,
                type: 'flash',
                join_coins: 100,
                title: 'Mock Submit-Fails Challenge',
                url: 'mock-submitfail',
                start_time: nowSec - 4 * 86400,
                close_time: nowSec + 4 * 86400,
            },
        ];
    },
);

/**
 * Simulate /rest/get_bankroll. Normalized to the flat balance shape the
 * real getBankroll returns.
 */
const getBankroll = mockMethod(
    {
        name: 'getBankroll',
        tokenArg: 0,
        onNoToken: () => null,
    },
    async () => {
        await simulateApiResponse({}, 300);
        return { keys: 8, swaps: 41, fills: 818, coins: 17540 };
    },
);

/**
 * Simulate /rest/coins_unlock. Fixture 900004 fails (success:false) so the
 * unlock-failure and charged-pending-submit paths can be tested.
 */
const coinsUnlock = mockMethod(
    {
        name: 'coinsUnlock',
        tokenArg: 1,
        debug: (challengeId) => {
            logger.withCategory('challenges').debug(`Unlock challenge ID: ${challengeId}`, null);
        },
        onNoToken: () => ({ ok: false, raw: null }),
    },
    async (challengeId) => {
        await simulateApiResponse({}, 400);
        if (String(challengeId) === '900004') {
            return { ok: false, raw: { success: false } };
        }
        return { ok: true, raw: { success: true } };
    },
);

module.exports = { getMemberChallenges, getBankroll, coinsUnlock };
