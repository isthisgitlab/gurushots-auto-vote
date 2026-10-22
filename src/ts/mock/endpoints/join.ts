/**
 * Mock counterpart to api/join.ts: open and upcoming (un-joined) challenges,
 * their suggested photos, the bankroll, and the coin unlock.
 */

import * as logger from '../../logger';
import { simulateApiResponse, mockMethod } from '../simulate';
import { HOUR, DAY } from '../time';
import { SUGGESTED_PHOTO_IDS, hexPhotoId } from '../photoLibrary';
import { LIBRARY_ID_RE, MAX_PER_CHALLENGE } from '../../strategies/real/suggestedPhotos';
import type * as joinModule from '../../api/join';
import type { Prize, PrizeTier } from '../../types/gurushots';

type OpenChallengeRow = [
    id: number,
    type: string,
    /** The join price; absent when the item carries no usable one (price-unknown). */
    join_coins: number | undefined,
    title: string,
    url: string,
    startedAgo: number,
    closesIn: number,
    entries: number,
    players: number,
    extras?: ListingExtras,
];

/**
 * What a listing shows besides the title: the challenge's own tags and badge,
 * how many photos it takes, its prizes (the achievement tiers — the first
 * ones derive from the top tier in openChallenge —, what the set is worth,
 * the vote threshold per ranking level), the image and welcome message that
 * mirror the live listing's fields (`image` itself is read by no non-mock
 * code), and its join gating (`max_players` cap, the unlock requirement —
 * which the item itself never carries raw; the member's submit state does,
 * derived below).
 */
type ListingExtras = {
    tags?: string[];
    badge?: string;
    max_photo_submits?: number;
    max_players?: number;
    join_unlock?: boolean;
    prizes_worth?: number;
    ranking_levels?: Record<string, number>;
    image?: { id: string; member_id: string };
    welcome_message?: string;
    achievements_and_prizes?: TierTable;
};

/** The tier-table builders' output: every tier carries its prize list. */
type TierTable = Array<PrizeTier & { prizes: Prize[] }>;

// The TOP 50 prize lists the default/exhibition-style tables share.
const TOP_50_PHOTOGRAPHER_PRIZES: Prize[] = [
    { type: 'PHOTO_SWAP', amount: 1 },
    { type: 'COINS', amount: 100 },
];
const TOP_50_PHOTO_PRIZES: Prize[] = [
    { type: 'EXPOSURE_AUTOFILL', amount: 2 },
    { type: 'COINS', amount: 100 },
];

/** The default/exhibition-style tier table: the top prize set on the three winner tiers, the shared TOP 50 lists below. */
const gurusTable = (topPrizes: Prize[], top50Photographer: Prize[] = TOP_50_PHOTOGRAPHER_PRIZES): TierTable => [
    { title: 'TOP PHOTOGRAPHER WINNER', rank: { type: 'MEMBER', min_rank: 1, max_rank: 1 }, prizes: topPrizes },
    { title: 'TOP PHOTO WINNER', rank: { type: 'IMAGE', min_rank: 1, max_rank: 1 }, prizes: topPrizes },
    { title: "GURU'S TOP PICK WINNER", rank: null, prizes: topPrizes },
    { title: 'TOP 50 PHOTOGRAPHER', rank: { type: 'MEMBER', min_rank: 2, max_rank: 50 }, prizes: top50Photographer },
    { title: 'TOP 50 PHOTO', rank: { type: 'IMAGE', min_rank: 2, max_rank: 50 }, prizes: TOP_50_PHOTO_PRIZES },
];

/** The flash-style tier table: one prize set per tier. */
const flashTable = (top: Prize[], top3: Prize[], top10: Prize[], top50: Prize[]): TierTable => [
    { title: 'TOP FLASH WINNER', rank: { type: 'MEMBER', min_rank: 1, max_rank: 1 }, prizes: top },
    { title: 'TOP 3 FLASH WINNER', rank: { type: 'MEMBER', min_rank: 2, max_rank: 3 }, prizes: top3 },
    { title: 'TOP 10 FLASH WINNER', rank: { type: 'MEMBER', min_rank: 4, max_rank: 10 }, prizes: top10 },
    { title: 'TOP 50 FLASH WINNER', rank: { type: 'MEMBER', min_rank: 11, max_rank: 50 }, prizes: top50 },
];

const copyPrizes = (prizes: Prize[]): Prize[] => prizes.map((prize) => ({ ...prize }));

const copyPrizeTiers = (tiers: TierTable): PrizeTier[] =>
    tiers.map((tier) => ({ ...tier, prizes: copyPrizes(tier.prizes) }));

/** An open challenge whose start and close are offsets (seconds) from `nowSec`. */
const openChallenge = (nowSec: number, row: OpenChallengeRow) => {
    const [id, type, join_coins, title, url, startedAgo, closesIn, entries, players, extras] = row;
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

const OPEN_CHALLENGE_ROWS: OpenChallengeRow[] = [
    [
        900001,
        'exhibition',
        0,
        'Best of Black & White',
        'mock-free',
        5 * DAY,
        3 * HOUR,
        2800,
        920,
        {
            tags: ['Exhibition', 'Comm', 'test35'],
            badge: 'exhibition',
            max_photo_submits: 4,
            max_players: 0,
            prizes_worth: 600,
            ranking_levels: { level_0: 0, level_1: 50, level_2: 250, level_3: 900, level_4: 1900, level_5: 5000 },
            image: { id: 'photo_cover_best_of_black_white_001', member_id: 'mock_user_001' },
            welcome_message: 'Mock challenge: show us black and white at its best.',
            achievements_and_prizes: gurusTable([
                { type: 'PHOTO_SWAP', amount: 2 },
                { type: 'KEY', amount: 1 },
                { type: 'COINS', amount: 250 },
            ]),
        },
    ],
    [
        900002,
        'flash',
        100,
        'All Cats',
        'mock-flash',
        DAY,
        2 * DAY,
        80,
        50,
        {
            tags: ['Flash', 'test35'],
            badge: 'flash',
            max_photo_submits: 3,
            max_players: 100,
            prizes_worth: 85,
            ranking_levels: { level_0: 0, level_1: 50, level_2: 250, level_3: 450, level_4: 900, level_5: 1500 },
            image: { id: 'photo_cover_all_cats_001', member_id: 'mock_user_001' },
            welcome_message: 'Mock challenge: show us your favourite cat.',
            achievements_and_prizes: flashTable(
                [
                    { type: 'PHOTO_SWAP', amount: 2 },
                    { type: 'KEY', amount: 2 },
                    { type: 'COINS', amount: 300 },
                ],
                [
                    { type: 'EXPOSURE_AUTOFILL', amount: 2 },
                    { type: 'KEY', amount: 1 },
                    { type: 'COINS', amount: 120 },
                ],
                [
                    { type: 'PHOTO_SWAP', amount: 1 },
                    { type: 'EXPOSURE_AUTOFILL', amount: 2 },
                    { type: 'COINS', amount: 50 },
                ],
                [{ type: 'COINS', amount: 40 }],
            ),
        },
    ],
    // Paid flash, no cap.
    [
        900003,
        'flash',
        250,
        'My Most Voted',
        'mock-paid',
        2 * DAY,
        5 * DAY,
        67,
        67,
        {
            tags: ['Flash', 'test35'],
            badge: 'flash',
            max_photo_submits: 1,
            max_players: 0,
            prizes_worth: 85,
            ranking_levels: { level_0: 0, level_1: 50, level_2: 250, level_3: 450, level_4: 900, level_5: 1500 },
            image: { id: 'photo_cover_my_most_voted_001', member_id: 'mock_user_001' },
            welcome_message: 'Mock challenge: show us your most-voted shot.',
            achievements_and_prizes: flashTable(
                [
                    { type: 'KEY', amount: 1 },
                    { type: 'COINS', amount: 250 },
                ],
                [
                    { type: 'EXPOSURE_AUTOFILL', amount: 2 },
                    { type: 'KEY', amount: 1 },
                    { type: 'COINS', amount: 120 },
                ],
                [
                    { type: 'PHOTO_SWAP', amount: 1 },
                    { type: 'EXPOSURE_AUTOFILL', amount: 2 },
                    { type: 'COINS', amount: 50 },
                ],
                [{ type: 'COINS', amount: 40 }],
            ),
        },
    ],
    [
        900004,
        'flash',
        20,
        'Blue Sky',
        'mock-fail',
        3 * DAY,
        3 * DAY,
        160,
        100,
        {
            tags: ['Flash'],
            badge: 'flash',
            max_players: 120,
            prizes_worth: 15,
            ranking_levels: { level_0: 0, level_1: 50, level_2: 250, level_3: 450, level_4: 900, level_5: 1500 },
            image: { id: 'photo_cover_blue_sky_001', member_id: 'mock_user_001' },
            welcome_message: 'Mock challenge: show us your open sky.',
            achievements_and_prizes: flashTable(
                [
                    { type: 'PHOTO_SWAP', amount: 1 },
                    { type: 'EXPOSURE_AUTOFILL', amount: 2 },
                    { type: 'COINS', amount: 60 },
                ],
                [
                    { type: 'PHOTO_SWAP', amount: 1 },
                    { type: 'EXPOSURE_AUTOFILL', amount: 1 },
                    { type: 'COINS', amount: 10 },
                ],
                [
                    { type: 'EXPOSURE_AUTOFILL', amount: 1 },
                    { type: 'COINS', amount: 5 },
                ],
                [{ type: 'COINS', amount: 5 }],
            ),
        },
    ],
    // 900005: unlock succeeds but submit fails → exercises the
    // "coins charged but not joined" (charged-pending-submit) UI/CLI path.
    [
        900005,
        'flash',
        50,
        'Summer Time',
        'mock-submitfail',
        4 * DAY,
        4 * DAY,
        112,
        108,
        {
            tags: ['Flash', 'test35'],
            badge: 'flash',
            max_players: 120,
            prizes_worth: 50,
            ranking_levels: { level_0: 0, level_1: 50, level_2: 250, level_3: 450, level_4: 900, level_5: 1500 },
            image: { id: 'photo_cover_summer_time_001', member_id: 'mock_user_001' },
            welcome_message: 'Mock challenge: show us your summer.',
            achievements_and_prizes: flashTable(
                [
                    { type: 'PHOTO_SWAP', amount: 1 },
                    { type: 'EXPOSURE_AUTOFILL', amount: 2 },
                    { type: 'COINS', amount: 120 },
                ],
                [
                    { type: 'EXPOSURE_AUTOFILL', amount: 1 },
                    { type: 'KEY', amount: 1 },
                    { type: 'COINS', amount: 50 },
                ],
                [
                    { type: 'PHOTO_SWAP', amount: 1 },
                    { type: 'COINS', amount: 25 },
                ],
                [{ type: 'COINS', amount: 15 }],
            ),
        },
    ],
    // 900006: free but full — players has reached max_players, so no slot is left.
    [
        900006,
        'default',
        0,
        'Close Up',
        'mock-full',
        6 * DAY,
        6 * DAY,
        100,
        100,
        {
            tags: ['Strong', 'No comm', '1 day', 'Turbo'],
            badge: 'speed',
            max_photo_submits: 1,
            max_players: 100,
            prizes_worth: 900,
            ranking_levels: { level_0: 0, level_1: 50, level_2: 250, level_3: 900, level_4: 1900, level_5: 5000 },
            image: { id: 'photo_cover_close_up_001', member_id: 'mock_user_001' },
            welcome_message: 'Mock challenge: show us the details up close.',
            achievements_and_prizes: gurusTable([
                { type: 'PHOTO_SWAP', amount: 5 },
                { type: 'EXPOSURE_AUTOFILL', amount: 5 },
            ]),
        },
    ],
    // 900007: unlock-gated with a price the listing can show.
    [
        900007,
        'default',
        200,
        'Retro Or Vintage',
        'mock-unlock',
        7 * DAY,
        7 * DAY,
        90,
        60,
        {
            tags: ['Strong', 'No comm', '1 day', 'Turbo'],
            badge: 'speed',
            max_photo_submits: 2,
            join_unlock: true,
            max_players: 0,
            prizes_worth: 3000,
            ranking_levels: { level_0: 0, level_1: 50, level_2: 250, level_3: 900, level_4: 1900, level_5: 5000 },
            image: { id: 'photo_cover_retro_or_vintage_001', member_id: 'mock_user_001' },
            welcome_message: 'Mock challenge: show us your retro or vintage side.',
            achievements_and_prizes: gurusTable([
                { type: 'PHOTO_SWAP', amount: 1 },
                { type: 'EXPOSURE_AUTOFILL', amount: 50 },
            ]),
        },
    ],
    // 900008: unlock-gated but the item carries no join_coins at all — the price is unknown.
    [
        900008,
        'default',
        undefined,
        'Urban Creatures',
        'mock-price-unknown',
        8 * DAY,
        8 * DAY,
        60,
        40,
        {
            tags: ['2 photos', 'No comm', 'Turbo'],
            badge: 'speed',
            max_photo_submits: 2,
            join_unlock: true,
            max_players: 0,
            prizes_worth: 3000,
            ranking_levels: { level_0: 0, level_1: 50, level_2: 250, level_3: 900, level_4: 1900, level_5: 5000 },
            image: { id: 'photo_cover_urban_creatures_001', member_id: 'mock_user_001' },
            welcome_message: 'Mock challenge: show us the creatures of the city.',
            achievements_and_prizes: gurusTable(
                [
                    { type: 'PHOTO_SWAP', amount: 20 },
                    { type: 'EXPOSURE_AUTOFILL', amount: 20 },
                ],
                [
                    { type: 'PHOTO_SWAP', amount: 1 },
                    { type: 'EXPOSURE_AUTOFILL', amount: 1 },
                    { type: 'COINS', amount: 100 },
                ],
            ),
        },
    ],
];

// Not started yet: `startedAgo` is negative, so start_time lies ahead. The ids stay clear of the
// open fixtures (the join path must never mistake one for the other). 900103 starts after the
// default 24 h look-ahead, so the window is exercisable too.
const UPCOMING_CHALLENGE_ROWS: OpenChallengeRow[] = [
    [
        900101,
        'default',
        0,
        'Halloween Time',
        'mock-upcoming-free',
        -2 * HOUR,
        3 * DAY,
        0,
        0,
        { tags: ['Exhibition', 'Default'], max_photo_submits: 2 },
    ],
    // No type: the listing shows the badge instead.
    [
        900102,
        '',
        150,
        'Finding Alignment',
        'mock-upcoming-paid',
        -20 * HOUR,
        4 * DAY,
        0,
        0,
        { tags: ['Comm'], badge: 'Team match', max_photo_submits: 4 },
    ],
    [900103, 'flash', 100, 'Reptiles and Amphibians', 'mock-upcoming-later', -3 * DAY, 5 * DAY, 0, 0],
];

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
