/**
 * Shapes of the GuruShots API payloads the app reads. Type-only: nothing here
 * exists at runtime. Modules pull them in with
 * `import type { Challenge } from '../types/gurushots'`.
 *
 * Nested objects and most fields are optional on purpose. The data comes off
 * the network, and the code optional-chains every per-challenge read (an
 * unguarded throw would abort the whole voting pass), so the types describe
 * what may arrive rather than what usually does.
 */

/** Unix time in seconds, as the API sends it. */
type UnixSeconds = number;

/**
 * When an entry went into its challenge, as the app recorded it: `exact` for a photo the app submitted itself, else the
 * time a challenge fetch first showed it (it went in at or before then).
 */
export interface EntryEnteredTime {
    at: UnixSeconds;
    exact: boolean;
}

/** One of the member's own photos entered in a challenge. */
export interface RankingEntry {
    id: string;
    member_id?: string;
    votes?: number;
    rank?: number;
    views?: number;
    adult?: boolean;
    guru_pick?: boolean;
    boost?: number;
    turbo?: boolean;
    boosting?: boolean;
    boosted?: boolean;
    /** App-set, never from the API: when this entry went in (see EntryEnteredTime). Any server field of this name is discarded. */
    appEntered?: EntryEnteredTime;
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
    /**
     * The member's rows in a benchmark challenge: for each of the top 1/10/100, the vote count AT
     * that rank — `score` is what the rank's holder has, not a target to reach; the gap to it
     * counts the votes needed to PASS it — keyed by `benchmark` `"1" | "10" | "100"`; `score` is
     * a string, `""` when there is none.
     */
    benchmark?: Array<{ benchmark?: string; score?: string }>;
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

export type BoostState = 'LOCKED' | 'MISSED' | 'AVAILABLE' | 'AVAILABLE_KEY' | 'USED' | 'UNAVAILABLE' | (string & {});
/** Which game a turbo session is: the classic one, or Snap (yes/no questions). Only the web read reports it. */
type TurboMode = 'classic' | 'snap' | (string & {});
type TurboState = 'FREE' | 'IN_PROGRESS' | 'TIMER' | 'WON' | 'LOCKED' | 'USED' | 'UNAVAILABLE' | (string & {});

export interface MemberBoost {
    state?: BoostState;
    /** Unix seconds the boost window closes; null/0 when there is none. */
    timeout?: UnixSeconds | null;
}

export interface MemberTurbo {
    state?: TurboState;
    /** Which game the next turbo session is; the bot plays a turbo only when this is 'classic' or 'snap'. */
    mode?: TurboMode;
    /** Unix seconds the turbo timer opens; null when not on a timer. */
    time_to_open?: UnixSeconds | null;
    max_selections?: number;
    required_selections?: number;
    turbo_unlock_amount?: number;
}

interface RewardResource {
    type?: string;
    title?: string;
    value?: number;
}

export interface RewardsBySection {
    /** 'CLAIM' while rewards wait to be claimed. */
    claim_state?: string;
    sections?: Array<{ type?: string; name?: string; resources?: RewardResource[] }>;
}

/** One prize, as the wire carries it. */
export interface Prize {
    type?: string;
    amount?: number;
}

/** One tier of a challenge's `achievements_and_prizes`, with the rank window it covers. */
export interface PrizeTier {
    title?: string;
    rank?: { min_rank?: number; max_rank?: number; type?: string } | null;
    prizes?: Prize[];
}

/** The member's own standing in a challenge. */
export interface ChallengeMember {
    time_joined?: UnixSeconds;
    submit_state?: string;
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
    entries: number;
    players: number;
    max_players?: number;
    votes?: number;
    max_photo_submits?: number;
    prizes_worth?: number;
    first_prizes?: Prize[];
    achievements_and_prizes?: PrizeTier[];
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
    guru_pick_enable?: boolean;
    top_photographer_enable?: boolean;
    levels_rank_enable?: boolean;
    new_ranking_enable?: boolean;
    member?: ChallengeMember;
    /**
     * App-set, never from the API: the instant (Unix seconds) a boost the voting
     * pass held for a fresh photo becomes due. Rides the pass's returned list into
     * the cadence decision so the next cycle lands on it.
     */
    boostHoldUntil?: UnixSeconds;
    /** App-set, never from the API (like `appEntered`): the team match running on this challenge, when the member's team has one. */
    teamMatch?: TeamMatch;
}

/**
 * The signed-in member's standing among their team's match participants, counted
 * in sorted-vote positions over the top `activeSlots` (= `min(ourCount, theirCount)`)
 * members who actually score. Numbers only — never another member's id or name.
 */
export type TeamStanding =
    | { kind: 'active'; position: number; votes: number; activeSlots: number; cushion: number | null }
    | { kind: 'standby'; position: number; votes: number; activeSlots: number; votesToActive: number };

/** Both teams' vote totals in a team match, from our side (`us`) and the opponent's (`them`). */
export interface TeamMatch {
    us: { name: string; votes: number };
    them: { name: string; votes: number };
    /** Absent means running. */
    running?: boolean;
    /** null when the standing is unreadable: a malformed roster, no scoring slots, or the member not listed. */
    me?: TeamStanding | null;
}

/** The WEB get_teams (limit=1): the member's team, only read when `state.status` is STATUS_JOINED. */
export interface TeamsResponse {
    state?: { status?: string };
    data?: { teams?: Array<{ id?: number; current_member?: { id?: string } }> };
}

/** The WEB get_match: the challenge a team's match runs on, each side's total votes and the participants. */
export interface MatchResponse {
    state?: { status?: string };
    data?: {
        challenge_id?: number;
        teams?: Array<{
            id?: number;
            name?: string;
            total_votes?: number;
            /** The match participants in server order; narrowed in api/teams.ts, which never trusts `rank`. */
            members?: Array<{ id?: string; rank?: number; rank_data?: { total?: { votes?: number } } }>;
        }>;
    };
}

/** get_my_active_challenges. `fetchFailed` marks a failed request (empty list). */
export interface ActiveChallengesResponse {
    challenges: Challenge[];
    fetchFailed?: boolean;
}

/**
 * The WEB get_my_active_challenges: each challenge's id, the member turbo (the
 * only read that reports a `mode`) and the challenge-level fields the mobile
 * read omits — every field is what may arrive, and api/challenges.ts
 * shape-checks it before use.
 */
export interface WebActiveChallengesResponse {
    challenges?: Array<{
        id: number | string;
        guru_pick_enable?: boolean;
        top_photographer_enable?: boolean;
        levels_rank_enable?: boolean;
        new_ranking_enable?: boolean;
        first_prizes?: Prize[];
        achievements_and_prizes?: PrizeTier[];
        member?: {
            turbo?: MemberTurbo | null;
            ranking?: { total?: Pick<RankingTotal, 'benchmark'> };
        };
    }>;
    /** Untrusted elements: the member's own suggested library photos per challenge they have NOT joined, narrowed by readSuggestions in api/challenges.ts. */
    suggested_challenges?: unknown[];
}

/** One photo offered for voting. */
export interface VoteImage {
    id: string;
    ratio?: number;
}

/** The challenge as get_vote_images echoes it. */
interface VoteChallenge {
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

/**
 * A write endpoint's body; the code only checks `success`. This and the action
 * payloads below (src/ts/api/*, mirrored by src/ts/mock/*) leave a field
 * optional where a refusal or failure body omits it.
 */
export interface SuccessResponse {
    success?: boolean;
}

/**
 * `{ ok, raw }` from a spend / submit / apply call; `raw` is null when the request failed. `unclear` is set by a
 * spend that goes out once: the request was sent and no usable answer came, so it may have been processed.
 * A refusal (`raw` null, not unclear) was not.
 */
export interface ActionResult {
    ok: boolean;
    raw: SuccessResponse | null;
    unclear?: boolean;
}

/** rest_mobile/signup. */
export interface LoginResponse {
    token?: string;
}

/** get_member_challenges: the challenges the member has not joined yet. */
export interface MemberChallengesResponse {
    items?: Challenge[];
}

/**
 * A Discover row's challenge: an open one (no `status`) or one that has not started yet
 * (`status: 'upcoming'`, a future `start_time`). The literal is the only marker; the open
 * rows' own server status is dropped so it cannot be mistaken for it.
 */
export interface DiscoverChallenge extends Omit<Challenge, 'status'> {
    status?: 'upcoming';
}

/**
 * A challenge as the Discover list receives it: the API item plus what the
 * Chosen Photos settings say for it. `chosenOwn` is the list saved for this
 * challenge alone; `chosenEffectiveCount` is how many photos the join would
 * actually use once every layer is resolved (0 under another account's list).
 */
export interface OpenChallenge extends DiscoverChallenge, ChosenAnnotation {
    /** The challenge's suggested photo ids, when the API lists any. */
    suggestedPhotoIds?: string[];
}

/**
 * What the Chosen Photos settings say about one open challenge. `chosenOwn` is the
 * list saved for it alone — empty while that list was saved under another account,
 * whose photo ids are never sent (`chosenOwnCount` still says how many there are).
 * `chosenEffectiveCount` is how many photos the join would use once every layer is
 * resolved (0 under another account's list).
 */
export interface ChosenAnnotation {
    chosenOwn: string[];
    chosenOwnCount: number;
    chosenEffectiveCount: number;
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
    /** Only the count is read; the entries' own shape is not relied on. */
    achievements?: unknown[];
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
interface TurboBattle {
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

/** start_turbo_session: '2.0' is a Snap session, '1.0' the classic game. */
export interface StartTurboSessionResponse {
    success?: boolean;
    session_type?: string;
    session_id?: string;
    /** Answers already given in this session. */
    position?: number;
    caption?: string | null;
    sub_caption?: string | null;
    /** Untrusted elements: narrowed to well-formed photos by startTurboSession. */
    images?: unknown[];
}

/** submit_snap_vote. */
export interface SnapVoteResponse {
    success?: boolean;
    /** True on the last answer of the session. */
    completed?: boolean;
    community_pct?: number | null;
    error_code?: number | null;
    message?: string | null;
}

/** One photo of a Snap session. */
export interface SnapImage {
    imageId: string;
    memberId: string;
}

/** A started turbo session, normalized from start_turbo_session. */
export type TurboSession =
    | { kind: 'classic' }
    | { kind: 'snap'; sessionId: string; position: number; caption: string; images: SnapImage[] };

/** The outcome of one Snap answer; `unclear` means it was sent and may have been processed. */
export interface SnapVoteResult {
    ok: boolean;
    completed: boolean;
    communityPct: number | null;
    errorCode: number | null;
    unclear: boolean;
    /** True only when a response body came back; false for a request that was refused before an answer or never left. */
    serverAnswered: boolean;
}

/** The outcome of playing one challenge's Turbo mini-game. */
export interface TurboMiniGameResult {
    played: number;
    correct: number;
    flipped: number;
    doubleFailed: number;
    won: boolean;
}

/** Why a Snap game stopped: finished, or the first thing that kept it from going on. */
export type SnapStopReason =
    | 'completed'
    | 'no-model'
    | 'unparsed-caption'
    | 'judge-failed'
    | 'unavailable'
    | 'withdrawn'
    | 'request-failed'
    | 'vote-unclear'
    | 'cancelled';

/** The outcome of playing one challenge's Snap game; `answered` counts the answers that landed in this run. */
export interface SnapGameResult {
    answered: number;
    total: number;
    /** Mean community agreement (%) over this run's answers; null with none. */
    meanAgreement: number | null;
    won: boolean;
    stopReason: SnapStopReason;
}

/** The outcome of one turbo game, tagged by which game it was. */
export type TurboGameResult = ({ kind: 'classic' } & TurboMiniGameResult) | ({ kind: 'snap' } & SnapGameResult);

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
    description?: string;
    claim_state?: string;
    /** Unix seconds the mission expires. */
    expiration_timestamp?: UnixSeconds;
    progress?: { current?: number; required?: number };
    prizes?: Array<{ type?: string; amount?: number }>;
}

/** get_my_missions. */
export interface MissionsResponse {
    list?: Mission[];
}
