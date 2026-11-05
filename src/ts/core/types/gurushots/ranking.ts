/**
 * The member's ranking inside one challenge: the entry rows, the totals and
 * the exposure factors, as the API sends them.
 */

import type { UnixSeconds } from './base';

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
