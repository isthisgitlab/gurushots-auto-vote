/**
 * The challenge payloads: the challenge object itself, the member's standing
 * in it (boost, turbo, ranking, rewards) and the list responses that carry
 * them.
 */

import type { UnixSeconds } from './base';
import type { MemberRanking, RankingTotal } from './ranking';
import type { TeamMatch } from './teams';

export type BoostState = 'LOCKED' | 'MISSED' | 'AVAILABLE' | 'AVAILABLE_KEY' | 'USED' | 'UNAVAILABLE' | (string & {});
/** Which game a turbo session is: the classic one, or Snap (yes/no questions). Only the web read reports it. */
type TurboMode = 'classic' | 'snap' | (string & {});
export type TurboState = 'FREE' | 'IN_PROGRESS' | 'TIMER' | 'WON' | 'LOCKED' | 'USED' | 'UNAVAILABLE' | (string & {});

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
    /**
     * App-set, never from the API: the boundary's stable codes (challengeIntegrity) for the wire
     * fields that are present but malformed. Actions refuse the challenge while it carries any.
     */
    dataIssues?: string[];
}

/** get_my_active_challenges. `fetchFailed` marks a failed request (empty list). `pruneUnsafe` marks a read that dropped id-less rows, so absence from this list is not "gone". */
export interface ActiveChallengesResponse {
    challenges: Challenge[];
    fetchFailed?: boolean;
    pruneUnsafe?: boolean;
}

/**
 * The WEB get_my_active_challenges: each challenge's id, the member turbo (the
 * only read that reports a `mode`), the per-entry Guru's picks (`member.ranking.entries`,
 * narrowed by readOverlay in api/challenges.ts) and the challenge-level fields
 * the mobile read omits — every field is what may arrive, and api/challenges.ts
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
            ranking?: { total?: Pick<RankingTotal, 'benchmark'>; entries?: unknown[] };
        };
    }>;
    /** Untrusted elements: the member's own suggested library photos per challenge they have NOT joined, narrowed by readSuggestions in api/challenges.ts. */
    suggested_challenges?: unknown[];
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
