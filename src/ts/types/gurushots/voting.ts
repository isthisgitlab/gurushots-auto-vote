/**
 * The voting payloads: the vote-image pool a pass votes on, and the Turbo and
 * Snap mini-game sessions with their results.
 */

import type { RankingExposure } from './ranking';
import type { TurboState } from './challenges';

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
