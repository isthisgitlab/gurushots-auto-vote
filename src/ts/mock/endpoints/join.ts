/**
 * Mock counterpart to api/join.ts: open and upcoming (un-joined) challenges,
 * their suggested photos, the bankroll, and the coin unlock.
 */

import * as logger from '../../logger';
import { simulateApiResponse, mockMethod } from '../simulate';
import { copyPrizes } from '../challenges/build';
import { SUGGESTED_PHOTO_IDS, hexPhotoId } from '../photoLibrary';
import { LIBRARY_ID_RE, MAX_PER_CHALLENGE } from '../../strategies/real/suggestedPhotos';
import { OPEN_CHALLENGE_ROWS, UPCOMING_CHALLENGE_ROWS } from './openChallengeRows';
import type * as joinModule from '../../api/join';
import type { OpenChallengeRow, TierTable } from './openChallengeRows';
import type { PrizeTier } from '../../types/gurushots';

const copyPrizeTiers = (tiers: TierTable): PrizeTier[] =>
    tiers.map((tier) => ({ ...tier, prizes: copyPrizes(tier.prizes) }));

/** An open challenge whose start and close are offsets (seconds) from `nowSec`. */
const openChallenge = (nowSec: number, row: OpenChallengeRow) => {
    const { id, type, join_coins, title, url, startedAgo, closesIn, entries, players, extras } = row;
    // Real items carry the member's submit state, not the raw unlock flag: 'join_unlock' on an
    // unlock-gated one, 'join' otherwise.
    const { join_unlock, achievements_and_prizes: tiers, ...listing } = extras ?? {};
    // One-level copy per row: no emitted row may share an array with another
    // row or with the constants the tier tables are built from.
    const firstPrizes = tiers?.[0]?.prizes;
    return {
        id,
        type,
        ...(join_coins === undefined ? {} : { join_coins }),
        title,
        url,
        start_time: nowSec - startedAgo,
        close_time: nowSec + closesIn,
        entries,
        players,
        ...listing,
        ...(firstPrizes ? { first_prizes: copyPrizes(firstPrizes) } : {}),
        ...(tiers ? { achievements_and_prizes: copyPrizeTiers(tiers) } : {}),
        member: { submit_state: join_unlock === true ? 'join_unlock' : 'join' },
    };
};

/**
 * Simulate /rest/get_member_challenges: the un-joined "open" challenges, or the "upcoming" ones
 * (not started yet, `status: 'upcoming'`, a future start_time). Open fixtures cover a free
 * exhibition and four paid flash challenges — on 900004 coinsUnlock fails, so the "unlock failed"
 * path is exercisable without a real account, and on 900005 the unlock succeeds but the submit
 * fails (see submitToChallenge; the "coins charged but not joined" path) — while the gating trio
 * rides on 900006-900008: full (players at max_players), unlock-priced, and unlock-priced with no
 * usable join_coins (price-unknown).
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
    async (_token, filter) => {
        await simulateApiResponse({}, 400);
        const nowSec = Math.floor(Date.now() / 1000);
        if (filter === 'upcoming') {
            return UPCOMING_CHALLENGE_ROWS.map((row) => ({ ...openChallenge(nowSec, row), status: 'upcoming' }));
        }
        // close_time / start_time are epoch SECONDS, matching joined
        // challenges. VERIFIED against the live get_member_challenges
        // response (2026-09-19): both are present on every open challenge,
        // alongside type/title/join_coins/tags/entries/players. Spread
        // across the join window so `autoJoinWithinHoursOfEnd` is
        // exercisable in mock mode: 900001 ends in 3h (inside any window),
        // the rest end in 2-8 days (outside a 24h one).
        return OPEN_CHALLENGE_ROWS.map((row) => openChallenge(nowSec, row));
    },
);

/**
 * The one open challenge the suggestion fixture hangs off (900001, the free
 * one), and its pool. The first three ids are library photos in the server's
 * 32-hex shape, so a picker join can actually match them; `photo_pink_flower_001`
 * exists in the library too but is not 32-hex, so the shape filter must drop it;
 * the hex padding pushes the pool past the 20-per-challenge cap so the cap is
 * exercisable (only the first three are matchable, which is all the picker needs).
 */
const SUGGESTED_IDS_BY_CHALLENGE: Record<string, string[]> = {
    '900001': [
        ...SUGGESTED_PHOTO_IDS,
        'photo_pink_flower_001',
        ...Array.from({ length: 18 }, (_, i) => hexPhotoId(i + 10)),
    ],
};

/** The mock counterpart's signature, mirroring the real getSuggestedPhotoIds. */
type GetSuggestedPhotoIds = (token: string, challengeId: string | number) => Promise<string[]>;

/**
 * Simulate the challenge's suggested-photo read: the pool for that challenge,
 * through the same shape filter and per-challenge cap the real ids answer to.
 * No token, or a challenge without suggestions, resolves an empty list.
 */
const getSuggestedPhotoIds: GetSuggestedPhotoIds = mockMethod(
    {
        name: 'getSuggestedPhotoIds',
        tokenArg: 0,
        onNoToken: () => [],
    },
    async (_token, challengeId) => {
        await simulateApiResponse({}, 150);
        const pool = SUGGESTED_IDS_BY_CHALLENGE[String(challengeId)] ?? [];
        return pool.filter((id) => LIBRARY_ID_RE.test(id)).slice(0, MAX_PER_CHALLENGE);
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

export { getMemberChallenges, getSuggestedPhotoIds, getBankroll, coinsUnlock };
