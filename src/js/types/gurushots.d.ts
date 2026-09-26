/**
 * Shapes of the GuruShots API payloads the app reads. Type-only: nothing here
 * exists at runtime. JS files pull them in with
 * `/** @import { Challenge } from '../types/gurushots' *\/`.
 *
 * Nested objects and most fields are optional on purpose. The data comes off
 * the network, and the code optional-chains every per-challenge read (an
 * unguarded throw would abort the whole voting pass), so the types describe
 * what may arrive rather than what usually does.
 */

/** Unix time in seconds, as the API sends it. */
export type UnixSeconds = number;

/** One of the member's own photos entered in a challenge. */
export interface RankingEntry {
    id: string;
    member_id?: string;
    votes?: number;
    rank?: number;
    views?: number;
    adult?: boolean;
    event_id?: number;
    guru_pick?: boolean;
    boost?: number;
    turbo?: boolean;
    boosting?: boolean;
    boosted?: boolean;
}

export interface RankingTotal {
    votes?: number;
    rank?: number;
    level?: number;
    level_name?: string;
    level_rank?: number;
    next?: number;
    percent?: number;
    exposure?: number;
    points?: number;
    guru_picks?: number;
    next_message?: string;
}

export interface RankingExposure {
    /** 0–100. */
    exposure_factor?: number;
    vote_exposure_factor?: number;
    vote_ratio?: number;
}

export interface MemberRanking {
    total?: RankingTotal;
    exposure?: RankingExposure;
    entries?: RankingEntry[];
    /** The member's swap history in this challenge; its length is the swap count. */
    swaps?: Array<{ id: string }>;
}

export type BoostState = 'LOCKED' | 'AVAILABLE' | 'AVAILABLE_KEY' | 'USED' | 'UNAVAILABLE' | (string & {});
export type TurboState = 'FREE' | 'IN_PROGRESS' | 'TIMER' | 'WON' | 'LOCKED' | 'USED' | 'UNAVAILABLE' | (string & {});

export interface MemberBoost {
    state?: BoostState;
    /** Unix seconds the boost window closes; null/0 when there is none. */
    timeout?: UnixSeconds | null;
}

export interface MemberTurbo {
    state?: TurboState;
    /** Unix seconds the turbo timer opens; null when not on a timer. */
    time_to_open?: UnixSeconds | null;
    max_selections?: number;
    required_selections?: number;
    turbo_unlock_type?: string;
    turbo_unlock_amount?: number;
}

export interface RewardResource {
    type?: string;
    title?: string;
    value?: number;
}

export interface RewardsBySection {
    /** 'CLAIM' while rewards wait to be claimed. */
    claim_state?: string;
    sections?: Array<{ type?: string; name?: string; resources?: RewardResource[] }>;
}

/** The member's own standing in a challenge. */
export interface ChallengeMember {
    time_joined?: UnixSeconds;
    boost?: MemberBoost;
    turbo?: MemberTurbo;
    ranking?: MemberRanking;
    rewards_by_section?: RewardsBySection;
}

/** A challenge as returned by get_my_active_challenges (and its mock). */
export interface Challenge {
    /** Compared and stored as `String(challenge.id)`. */
    id: number | string;
    title: string;
    url?: string;
    welcome_message?: string;
    start_time: UnixSeconds;
    close_time: UnixSeconds;
    status?: string;
    /** 'flash', 'default', …; empty or absent for a regular challenge. */
    type?: string;
    badge?: string;
    tags?: string[];
    entries?: number;
    players?: number;
    votes?: number;
    max_photo_submits?: number;
    vote_minimum_players?: number;
    prizes_worth?: number;
    /** Keyed `level_0` … `level_5`: the vote threshold for each level. */
    ranking_levels?: Record<string, number>;
    /** Coins to join; 0 or absent when free. */
    join_coins?: number;
    /** The cover photo, used to build a thumbnail URL. */
    image?: { id?: string; member_id?: string };
    boost_enable?: boolean;
    turbo_enable?: boolean;
    fill_enable?: boolean;
    fill_locked?: boolean;
    swap_enable?: boolean;
    swap_locked?: boolean;
    top_photo_enable?: boolean;
    member?: ChallengeMember;
}

/** get_my_active_challenges. `fetchFailed` marks a failed request (empty list). */
export interface ActiveChallengesResponse {
    challenges: Challenge[];
    fetchFailed?: boolean;
}

/** One photo offered for voting. */
export interface VoteImage {
    id: string;
    ratio?: number;
}

/** get_vote_images. */
export interface VoteImagesResponse {
    challenge?: Challenge;
    voting?: { exposure?: RankingExposure };
    images: VoteImage[];
}
