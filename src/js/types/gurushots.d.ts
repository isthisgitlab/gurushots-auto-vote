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
    /**
     * App-set, never from the API: the instant (Unix seconds) a boost the voting
     * pass held for a fresh photo becomes due. Rides the pass's returned list into
     * the cadence decision so the next cycle lands on it.
     */
    boostHoldUntil?: UnixSeconds;
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

/** The challenge as get_vote_images echoes it. */
export interface VoteChallenge {
    id: number | string;
    title: string;
    url?: string;
}

/** get_vote_images: the pool to vote on, with the challenge's current exposure. */
export interface VoteImagesResponse {
    challenge: VoteChallenge;
    voting: { exposure: RankingExposure & { exposure_factor: number } };
    images: VoteImage[];
}

// ---------------------------------------------------------------------------
// Transport-layer payloads (src/js/api/*, mirrored by src/js/mock/*). Raw
// response bodies are what the code reads, every field optional: the body is
// untrusted and each read is guarded.
// ---------------------------------------------------------------------------

/** A write endpoint's body; the code only checks `success`. */
export interface SuccessResponse {
    success?: boolean;
}

/** `{ ok, raw }` from a spend / submit / apply call; `raw` is null when the request failed. */
export interface ActionResult {
    ok: boolean;
    raw: SuccessResponse | null;
}

/** rest_mobile/signup. */
export interface LoginResponse {
    token?: string;
}

/** get_member_challenges: the challenges the member has not joined yet. */
export interface MemberChallengesResponse {
    items?: Challenge[];
}

/** get_bankroll, raw. */
export interface BankrollResponse {
    success?: boolean;
    bankroll?: { challenges?: Array<{ type?: string; amount?: number | string } | null> };
}

/** The account's currency balances, normalized from get_bankroll. */
export interface Bankroll {
    keys: number;
    swaps: number;
    fills: number;
    coins: number;
}

/** One photo of the member's library (get_photos_private items). */
export interface LibraryPhoto {
    id: string;
    labels?: string[];
    /** Always 0 on the live endpoint; get_image_data carries the real count. */
    votes?: number;
    views?: number;
    upload_date?: UnixSeconds;
    permission?: { allowed?: boolean; message?: string | null };
}

/** get_photos_private. */
export interface PhotosPrivateResponse {
    items?: LibraryPhoto[];
}

/** get_image_data `data`: the per-photo popularity record. */
export interface ImageRecord {
    id?: string;
    votes?: number;
    views?: number;
    achievements?: string[];
}

/** get_image_data. */
export interface ImageDataResponse {
    success?: boolean;
    data?: ImageRecord;
}

/** get_current_member_profile. */
export interface CurrentMemberProfileResponse {
    profile?: { id?: string; user_name?: string };
}

/** The signed-in member's identity, resolved from the session token. */
export interface MemberIdentity {
    id: string;
    userName: string;
}

/** search_autocomplete. Entries are untrusted and filtered down to strings. */
export interface SearchAutocompleteResponse {
    items?: unknown[];
}

/** get_challenge_turbo. */
export interface ChallengeTurboResponse {
    images?: Array<{
        first_image?: { id?: string };
        second_image?: { id?: string };
        /** null while the battle is unresolved. */
        is_success?: boolean | null;
    }>;
    max_selections?: number;
    required_selections?: number;
}

/** One Turbo battle pair, normalized from get_challenge_turbo. */
export interface TurboBattle {
    firstImageId?: string;
    secondImageId?: string;
    isSuccess?: boolean | null;
}

export interface TurboBattleSet {
    battles: TurboBattle[];
    maxSelections?: number;
    requiredSelections?: number;
}

/** submit_challenge_turbo_selection. */
export interface TurboSelectionResponse {
    success?: boolean;
    is_successful_selection?: boolean;
    state?: TurboState;
    scores?: Record<string, unknown>;
    error_code?: number;
}

export interface TurboSelectionResult {
    ok: boolean;
    success: boolean;
    state: TurboState | null;
    scores: Record<string, unknown> | null;
    errorCode: number | null;
    raw: TurboSelectionResponse | null;
}

/** The outcome of playing one challenge's Turbo mini-game. */
export interface TurboMiniGameResult {
    played: number;
    correct: number;
    flipped: number;
    doubleFailed: number;
    won: boolean;
}

/** A finished challenge from get_my_completed_challenges. */
export interface CompletedChallenge {
    id: number | string;
    title?: string;
    member?: ChallengeMember;
}

/** get_my_completed_challenges. */
export interface CompletedChallengesResponse {
    completed_challenges?: CompletedChallenge[];
}

/** A mission from get_my_missions; claim_state 'CLAIM' once completed and unclaimed. */
export interface Mission {
    id: number | string;
    name?: string;
    claim_state?: string;
    progress?: { current?: number; required?: number };
    prizes?: Array<{ type?: string; amount?: number }>;
}

/** get_my_missions. */
export interface MissionsResponse {
    list?: Mission[];
}
