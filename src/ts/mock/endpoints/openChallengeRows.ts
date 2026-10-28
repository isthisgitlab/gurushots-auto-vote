/**
 * The open and upcoming challenge fixtures behind mock getMemberChallenges:
 * one keyed object per listing, plus the tier-table builders the listings'
 * prize sets are composed from.
 */
// aislop-ignore-file code-quality/duplicate-block -- declarative fixture table captured from live challenges; one keyed object per challenge keeps it diffable against captures

import { HOUR, DAY } from '../time';
import { prize } from '../challenges/build';
import type { Prize, PrizeTier } from '../../types/gurushots';

/** The tier-table builders' output: every tier carries its prize list. */
type TierTable = Array<PrizeTier & { prizes: Prize[] }>;

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

/** One un-joined listing, keyed as openChallenge reads it. */
type OpenChallengeRow = {
    id: number;
    type: string;
    /** The join price; absent when the item carries no usable one (price-unknown). */
    join_coins?: number;
    title: string;
    url: string;
    /** Seconds the item started ago (negative = not started yet). */
    startedAgo: number;
    closesIn: number;
    entries: number;
    players: number;
    extras?: ListingExtras;
};

// The TOP 50 prize lists the default/exhibition-style tables share.
const TOP_50_PHOTOGRAPHER_PRIZES: Prize[] = [prize('PHOTO_SWAP', 1), prize('COINS', 100)];
const TOP_50_PHOTO_PRIZES: Prize[] = [prize('EXPOSURE_AUTOFILL', 2), prize('COINS', 100)];

/** The default/exhibition-style tier table: the top prize set on the three winner tiers, the shared TOP 50 lists below. */
const gurusTable = ({
    top,
    top50Photographer = TOP_50_PHOTOGRAPHER_PRIZES,
}: {
    top: Prize[];
    top50Photographer?: Prize[];
}): TierTable => [
    { title: 'TOP PHOTOGRAPHER WINNER', rank: { type: 'MEMBER', min_rank: 1, max_rank: 1 }, prizes: top },
    { title: 'TOP PHOTO WINNER', rank: { type: 'IMAGE', min_rank: 1, max_rank: 1 }, prizes: top },
    { title: "GURU'S TOP PICK WINNER", rank: null, prizes: top },
    { title: 'TOP 50 PHOTOGRAPHER', rank: { type: 'MEMBER', min_rank: 2, max_rank: 50 }, prizes: top50Photographer },
    { title: 'TOP 50 PHOTO', rank: { type: 'IMAGE', min_rank: 2, max_rank: 50 }, prizes: TOP_50_PHOTO_PRIZES },
];

/** The flash-style tier table: one prize set per tier. */
const flashTable = ({
    top,
    top3,
    top10,
    top50,
}: {
    top: Prize[];
    top3: Prize[];
    top10: Prize[];
    top50: Prize[];
}): TierTable => [
    { title: 'TOP FLASH WINNER', rank: { type: 'MEMBER', min_rank: 1, max_rank: 1 }, prizes: top },
    { title: 'TOP 3 FLASH WINNER', rank: { type: 'MEMBER', min_rank: 2, max_rank: 3 }, prizes: top3 },
    { title: 'TOP 10 FLASH WINNER', rank: { type: 'MEMBER', min_rank: 4, max_rank: 10 }, prizes: top10 },
    { title: 'TOP 50 FLASH WINNER', rank: { type: 'MEMBER', min_rank: 11, max_rank: 50 }, prizes: top50 },
];

const OPEN_CHALLENGE_ROWS: OpenChallengeRow[] = [
    {
        id: 900001,
        type: 'exhibition',
        join_coins: 0,
        title: 'Best of Black & White',
        url: 'mock-free',
        startedAgo: 5 * DAY,
        closesIn: 3 * HOUR,
        entries: 2800,
        players: 920,
        extras: {
            tags: ['Exhibition', 'Comm', 'test35'],
            badge: 'exhibition',
            max_photo_submits: 4,
            max_players: 0,
            prizes_worth: 600,
            ranking_levels: { level_0: 0, level_1: 50, level_2: 250, level_3: 900, level_4: 1900, level_5: 5000 },
            image: { id: 'photo_cover_best_of_black_white_001', member_id: 'mock_user_001' },
            welcome_message: 'Mock challenge: show us black and white at its best.',
            achievements_and_prizes: gurusTable({
                top: [prize('PHOTO_SWAP', 2), prize('KEY', 1), prize('COINS', 250)],
            }),
        },
    },
    {
        id: 900002,
        type: 'flash',
        join_coins: 100,
        title: 'All Cats',
        url: 'mock-flash',
        startedAgo: DAY,
        closesIn: 2 * DAY,
        entries: 80,
        players: 50,
        extras: {
            tags: ['Flash', 'test35'],
            badge: 'flash',
            max_photo_submits: 3,
            max_players: 100,
            prizes_worth: 85,
            ranking_levels: { level_0: 0, level_1: 50, level_2: 250, level_3: 450, level_4: 900, level_5: 1500 },
            image: { id: 'photo_cover_all_cats_001', member_id: 'mock_user_001' },
            welcome_message: 'Mock challenge: show us your favourite cat.',
            achievements_and_prizes: flashTable({
                top: [prize('PHOTO_SWAP', 2), prize('KEY', 2), prize('COINS', 300)],
                top3: [prize('EXPOSURE_AUTOFILL', 2), prize('KEY', 1), prize('COINS', 120)],
                top10: [prize('PHOTO_SWAP', 1), prize('EXPOSURE_AUTOFILL', 2), prize('COINS', 50)],
                top50: [prize('COINS', 40)],
            }),
        },
    },
    // Paid flash, no cap.
    {
        id: 900003,
        type: 'flash',
        join_coins: 250,
        title: 'My Most Voted',
        url: 'mock-paid',
        startedAgo: 2 * DAY,
        closesIn: 5 * DAY,
        entries: 67,
        players: 67,
        extras: {
            tags: ['Flash', 'test35'],
            badge: 'flash',
            max_photo_submits: 1,
            max_players: 0,
            prizes_worth: 85,
            ranking_levels: { level_0: 0, level_1: 50, level_2: 250, level_3: 450, level_4: 900, level_5: 1500 },
            image: { id: 'photo_cover_my_most_voted_001', member_id: 'mock_user_001' },
            welcome_message: 'Mock challenge: show us your most-voted shot.',
            achievements_and_prizes: flashTable({
                top: [prize('KEY', 1), prize('COINS', 250)],
                top3: [prize('EXPOSURE_AUTOFILL', 2), prize('KEY', 1), prize('COINS', 120)],
                top10: [prize('PHOTO_SWAP', 1), prize('EXPOSURE_AUTOFILL', 2), prize('COINS', 50)],
                top50: [prize('COINS', 40)],
            }),
        },
    },
    {
        id: 900004,
        type: 'flash',
        join_coins: 20,
        title: 'Blue Sky',
        url: 'mock-fail',
        startedAgo: 3 * DAY,
        closesIn: 3 * DAY,
        entries: 160,
        players: 100,
        extras: {
            tags: ['Flash'],
            badge: 'flash',
            max_players: 120,
            prizes_worth: 15,
            ranking_levels: { level_0: 0, level_1: 50, level_2: 250, level_3: 450, level_4: 900, level_5: 1500 },
            image: { id: 'photo_cover_blue_sky_001', member_id: 'mock_user_001' },
            welcome_message: 'Mock challenge: show us your open sky.',
            achievements_and_prizes: flashTable({
                top: [prize('PHOTO_SWAP', 1), prize('EXPOSURE_AUTOFILL', 2), prize('COINS', 60)],
                top3: [prize('PHOTO_SWAP', 1), prize('EXPOSURE_AUTOFILL', 1), prize('COINS', 10)],
                top10: [prize('EXPOSURE_AUTOFILL', 1), prize('COINS', 5)],
                top50: [prize('COINS', 5)],
            }),
        },
    },
    // 900005: unlock succeeds but submit fails → exercises the
    // "coins charged but not joined" (charged-pending-submit) UI/CLI path.
    {
        id: 900005,
        type: 'flash',
        join_coins: 50,
        title: 'Summer Time',
        url: 'mock-submitfail',
        startedAgo: 4 * DAY,
        closesIn: 4 * DAY,
        entries: 112,
        players: 108,
        extras: {
            tags: ['Flash', 'test35'],
            badge: 'flash',
            max_players: 120,
            prizes_worth: 50,
            ranking_levels: { level_0: 0, level_1: 50, level_2: 250, level_3: 450, level_4: 900, level_5: 1500 },
            image: { id: 'photo_cover_summer_time_001', member_id: 'mock_user_001' },
            welcome_message: 'Mock challenge: show us your summer.',
            achievements_and_prizes: flashTable({
                top: [prize('PHOTO_SWAP', 1), prize('EXPOSURE_AUTOFILL', 2), prize('COINS', 120)],
                top3: [prize('EXPOSURE_AUTOFILL', 1), prize('KEY', 1), prize('COINS', 50)],
                top10: [prize('PHOTO_SWAP', 1), prize('COINS', 25)],
                top50: [prize('COINS', 15)],
            }),
        },
    },
    // 900006: free but full — players has reached max_players, so no slot is left.
    {
        id: 900006,
        type: 'default',
        join_coins: 0,
        title: 'Close Up',
        url: 'mock-full',
        startedAgo: 6 * DAY,
        closesIn: 6 * DAY,
        entries: 100,
        players: 100,
        extras: {
            tags: ['Strong', 'No comm', '1 day', 'Turbo'],
            badge: 'speed',
            max_photo_submits: 1,
            max_players: 100,
            prizes_worth: 900,
            ranking_levels: { level_0: 0, level_1: 50, level_2: 250, level_3: 900, level_4: 1900, level_5: 5000 },
            image: { id: 'photo_cover_close_up_001', member_id: 'mock_user_001' },
            welcome_message: 'Mock challenge: show us the details up close.',
            achievements_and_prizes: gurusTable({
                top: [prize('PHOTO_SWAP', 5), prize('EXPOSURE_AUTOFILL', 5)],
            }),
        },
    },
    // 900007: unlock-gated with a price the listing can show.
    {
        id: 900007,
        type: 'default',
        join_coins: 200,
        title: 'Retro Or Vintage',
        url: 'mock-unlock',
        startedAgo: 7 * DAY,
        closesIn: 7 * DAY,
        entries: 90,
        players: 60,
        extras: {
            tags: ['Strong', 'No comm', '1 day', 'Turbo'],
            badge: 'speed',
            max_photo_submits: 2,
            join_unlock: true,
            max_players: 0,
            prizes_worth: 3000,
            ranking_levels: { level_0: 0, level_1: 50, level_2: 250, level_3: 900, level_4: 1900, level_5: 5000 },
            image: { id: 'photo_cover_retro_or_vintage_001', member_id: 'mock_user_001' },
            welcome_message: 'Mock challenge: show us your retro or vintage side.',
            achievements_and_prizes: gurusTable({
                top: [prize('PHOTO_SWAP', 1), prize('EXPOSURE_AUTOFILL', 50)],
            }),
        },
    },
    // 900008: unlock-gated but the item carries no join_coins at all — the price is unknown.
    {
        id: 900008,
        type: 'default',
        title: 'Urban Creatures',
        url: 'mock-price-unknown',
        startedAgo: 8 * DAY,
        closesIn: 8 * DAY,
        entries: 60,
        players: 40,
        extras: {
            tags: ['2 photos', 'No comm', 'Turbo'],
            badge: 'speed',
            max_photo_submits: 2,
            join_unlock: true,
            max_players: 0,
            prizes_worth: 3000,
            ranking_levels: { level_0: 0, level_1: 50, level_2: 250, level_3: 900, level_4: 1900, level_5: 5000 },
            image: { id: 'photo_cover_urban_creatures_001', member_id: 'mock_user_001' },
            welcome_message: 'Mock challenge: show us the creatures of the city.',
            achievements_and_prizes: gurusTable({
                top: [prize('PHOTO_SWAP', 20), prize('EXPOSURE_AUTOFILL', 20)],
                top50Photographer: [prize('PHOTO_SWAP', 1), prize('EXPOSURE_AUTOFILL', 1), prize('COINS', 100)],
            }),
        },
    },
];

// Not started yet: `startedAgo` is negative, so start_time lies ahead. The ids stay clear of the
// open fixtures (the join path must never mistake one for the other). 900103 starts after the
// default 24 h look-ahead, so the window is exercisable too.
const UPCOMING_CHALLENGE_ROWS: OpenChallengeRow[] = [
    {
        id: 900101,
        type: 'default',
        join_coins: 0,
        title: 'Halloween Time',
        url: 'mock-upcoming-free',
        startedAgo: -2 * HOUR,
        closesIn: 3 * DAY,
        entries: 0,
        players: 0,
        extras: { tags: ['Exhibition', 'Default'], max_photo_submits: 2 },
    },
    // No type: the listing shows the badge instead.
    {
        id: 900102,
        type: '',
        join_coins: 150,
        title: 'Finding Alignment',
        url: 'mock-upcoming-paid',
        startedAgo: -20 * HOUR,
        closesIn: 4 * DAY,
        entries: 0,
        players: 0,
        extras: { tags: ['Comm'], badge: 'Team match', max_photo_submits: 4 },
    },
    {
        id: 900103,
        type: 'flash',
        join_coins: 100,
        title: 'Reptiles and Amphibians',
        url: 'mock-upcoming-later',
        startedAgo: -3 * DAY,
        closesIn: 5 * DAY,
        entries: 0,
        players: 0,
    },
];

export { OPEN_CHALLENGE_ROWS, UPCOMING_CHALLENGE_ROWS };
export type { OpenChallengeRow, TierTable };
