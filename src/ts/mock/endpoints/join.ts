/**
 * Mock counterpart to api/join.ts: open (un-joined) challenges, the
 * bankroll, and the coin unlock.
 */

import * as logger from '../../logger';
import { simulateApiResponse, mockMethod } from '../simulate';
import { HOUR, DAY } from '../time';
import type * as joinModule from '../../api/join';

type OpenChallengeRow = [
    id: number,
    type: string,
    join_coins: number,
    title: string,
    url: string,
    startedAgo: number,
    closesIn: number,
    entries: number,
    players: number,
];

/** An open challenge whose start and close are offsets (seconds) from `nowSec`. */
const openChallenge = (nowSec: number, row: OpenChallengeRow) => {
    const [id, type, join_coins, title, url, startedAgo, closesIn, entries, players] = row;
    return {
        id,
        type,
        join_coins,
        title,
        url,
        start_time: nowSec - startedAgo,
        close_time: nowSec + closesIn,
        entries,
        players,
    };
};

const OPEN_CHALLENGE_ROWS: OpenChallengeRow[] = [
    [900001, 'default', 0, 'Mock Free Challenge', 'mock-free', 5 * DAY, 3 * HOUR, 40, 25],
    [900002, 'flash', 100, 'Mock Flash Challenge', 'mock-flash', DAY, 2 * DAY, 80, 50],
    [900003, 'default', 250, 'Mock Paid Challenge', 'mock-paid', 2 * DAY, 5 * DAY, 120, 75],
    [900004, 'flash', 100, 'Mock Unlock-Fails Challenge', 'mock-fail', 3 * DAY, 3 * DAY, 160, 100],
    // 900005: unlock succeeds but submit fails → exercises the
    // "coins charged but not joined" (charged-pending-submit) UI/CLI path.
    [900005, 'flash', 100, 'Mock Submit-Fails Challenge', 'mock-submitfail', 4 * DAY, 4 * DAY, 200, 125],
];

/**
 * Simulate /rest/get_member_challenges (un-joined "open" challenges).
 * Fixtures cover a free join, paid flash, paid normal, and a designated
 * paid id (900004) whose coinsUnlock fails — so the "coins charged but
 * submit failed" / "unlock failed" paths are exercisable without a real
 * account. Id 900005 unlocks but its submit fails (see submitToChallenge).
 */
const getMemberChallenges: typeof joinModule.getMemberChallenges = mockMethod(
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
        return OPEN_CHALLENGE_ROWS.map((row) => openChallenge(nowSec, row));
    },
);

/**
 * Simulate /rest/get_bankroll. Normalized to the flat balance shape the
 * real getBankroll returns.
 */
const getBankroll: typeof joinModule.getBankroll = mockMethod(
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
const coinsUnlock: typeof joinModule.coinsUnlock = mockMethod(
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

export { getMemberChallenges, getBankroll, coinsUnlock };
