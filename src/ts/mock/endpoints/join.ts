/**
 * Mock counterpart to api/join.ts: open and upcoming (un-joined) challenges,
 * their suggested photos, the bankroll, and the coin unlock.
 */

import * as logger from '../../logger';
import { simulateApiResponse, mockMethod } from '../simulate';
import { HOUR, DAY } from '../time';
import { SUGGESTED_PHOTO_IDS, hexPhotoId } from '../photoLibrary';
import type * as joinModule from '../../api/join';
import type { Prize } from '../../types/gurushots';

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
 * how many photos it takes, its first prizes, and its join gating (`max_players`
 * cap, the unlock requirement — which the item itself never carries raw; the
 * member's submit state does, derived below).
 */
type ListingExtras = {
    tags?: string[];
    badge?: string;
    max_photo_submits?: number;
    max_players?: number;
    join_unlock?: boolean;
    first_prizes?: Prize[];
};

/** An open challenge whose start and close are offsets (seconds) from `nowSec`. */
const openChallenge = (nowSec: number, row: OpenChallengeRow) => {
    const [id, type, join_coins, title, url, startedAgo, closesIn, entries, players, extras] = row;
    // Real items carry the member's submit state, not the raw unlock flag: 'join_unlock' on an
    // unlock-gated one, 'join' otherwise.
    const { join_unlock, ...listing } = extras ?? {};
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
        member: { submit_state: join_unlock === true ? 'join_unlock' : 'join' },
    };
};

const OPEN_CHALLENGE_ROWS: OpenChallengeRow[] = [
    [
        900001,
        'default',
        0,
        'Mock Free Challenge',
        'mock-free',
        5 * DAY,
        3 * HOUR,
        40,
        25,
        { tags: ['Exhibition'], max_photo_submits: 1 },
    ],
    [
        900002,
        'flash',
        100,
        'Mock Flash Challenge',
        'mock-flash',
        DAY,
        2 * DAY,
        80,
        50,
        { tags: ['No comm', '3 photos'], max_photo_submits: 3 },
    ],
    // An ordinary paid one; with 900007 it carries first_prizes, so the Discover prize line renders in mock mode.
    [
        900003,
        'default',
        250,
        'Mock Paid Challenge',
        'mock-paid',
        2 * DAY,
        5 * DAY,
        120,
        75,
        {
            first_prizes: [
                { type: 'KEY', amount: 1 },
                { type: 'COINS', amount: 250 },
            ],
        },
    ],
    [900004, 'flash', 100, 'Mock Unlock-Fails Challenge', 'mock-fail', 3 * DAY, 3 * DAY, 160, 100],
    // 900005: unlock succeeds but submit fails → exercises the
    // "coins charged but not joined" (charged-pending-submit) UI/CLI path.
    [900005, 'flash', 100, 'Mock Submit-Fails Challenge', 'mock-submitfail', 4 * DAY, 4 * DAY, 200, 125],
    // 900006: free but full — players has reached max_players, so no slot is left.
    [
        900006,
        'default',
        0,
        'Mock Full Challenge',
        'mock-full',
        6 * DAY,
        6 * DAY,
        150,
        150,
        { tags: ['Exhibition'], max_photo_submits: 1, max_players: 150 },
    ],
    // 900007: unlock-gated with a price the listing can show; with 900003 it carries first_prizes for the Discover prize line.
    [
        900007,
        'default',
        200,
        'Mock Unlock Challenge',
        'mock-unlock',
        7 * DAY,
        7 * DAY,
        90,
        60,
        {
            tags: ['Comm'],
            max_photo_submits: 2,
            join_unlock: true,
            first_prizes: [
                { type: 'PHOTO_SWAP', amount: 1 },
                { type: 'EXPOSURE_AUTOFILL', amount: 50 },
            ],
        },
    ],
    // 900008: unlock-gated but the item carries no join_coins at all — the price is unknown.
    [
        900008,
        'default',
        undefined,
        'Mock Price-Unknown Challenge',
        'mock-price-unknown',
        8 * DAY,
        8 * DAY,
        60,
        40,
        { tags: ['Comm'], max_photo_submits: 2, join_unlock: true },
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
        'Mock Upcoming Free Challenge',
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
        'Mock Upcoming Paid Challenge',
        'mock-upcoming-paid',
        -20 * HOUR,
        4 * DAY,
        0,
        0,
        { tags: ['Comm'], badge: 'Team match', max_photo_submits: 4 },
    ],
    [900103, 'flash', 100, 'Mock Upcoming Later Challenge', 'mock-upcoming-later', -3 * DAY, 5 * DAY, 0, 0],
];

/**
 * Simulate /rest/get_member_challenges: the un-joined "open" challenges, or the "upcoming" ones
 * (not started yet, `status: 'upcoming'`, a future start_time). Open fixtures cover a free join, paid flash, paid normal, a designated
 * paid id (900004) whose coinsUnlock fails — so the "coins charged but
 * submit failed" / "unlock failed" paths are exercisable without a real
 * account — and id 900005, which unlocks but its submit fails (see
 * submitToChallenge). The gating trio rides on 900006-900008: full
 * (players at max_players), unlock-priced, and unlock-priced with no usable
 * join_coins (price-unknown).
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

// The shape a real photo id answers to, and how many suggestions one challenge carries.
const PHOTO_ID_SHAPE = /^[0-9a-f]{32}$/;
const MAX_SUGGESTED_PHOTOS = 20;

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
        return pool.filter((id) => PHOTO_ID_SHAPE.test(id)).slice(0, MAX_SUGGESTED_PHOTOS);
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
