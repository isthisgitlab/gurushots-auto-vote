/**
 * Shape of one mock challenge as authored in the spec tables.
 */

import type { Prize, PrizeTier, TeamMatch } from '../../types/gurushots';

/** Exposure drawn at generation time: min(cap, floor(random * spread) + base), i.e. base..base+spread-1 clamped to cap. */
interface ExposureRange {
    cap: number;
    spread: number;
    base: number;
}

type BoostTimeout = null | 0 | { availableFor: number };

interface RankedEntrySpec {
    id: string;
    votes: number;
    rank: number;
    guruPick: boolean;
    boost: number;
    turbo: boolean;
    boosted: boolean;
}

/** One mock challenge. Times are seconds relative to generation time (negative = past). */
interface ChallengeSpec {
    title: string;
    welcomeMessage: string;
    url: string;
    status: 'active' | 'upcoming';
    startsIn: number;
    closesIn: number;
    joined: boolean;
    entries: number;
    players: number;
    votes: number;
    maxPhotoSubmits: number;
    badge: string;
    type: 'default' | 'flash' | 'speed' | 'exhibition';
    tags: string[];
    prizesWorth: number;
    rankingLevels: [number, number, number, number, number];
    boostEnabled: boolean;
    timeLeft: { days: number; hours: number; minutes: number; seconds: number };
    boost: { state: 'AVAILABLE' | 'AVAILABLE_KEY' | 'LOCKED' | 'UNAVAILABLE' | 'USED'; timeout: BoostTimeout };
    /** Absent = the challenge has no turbo (`member.turbo` null, `turbo_enable` false) — most real ones do not. */
    turbo?: { state: string; opensIn: number | null; mode?: 'classic' | 'snap' };
    total: {
        votes: number;
        rank: number;
        level: number;
        level_name: string;
        level_rank: number;
        next: number;
        percent: number;
        exposure: number;
        points: number;
        guru_picks: number;
        next_message: string;
    };
    /** Benchmark rows on `member.ranking.total`, when the challenge is a benchmark one; absent on the rest. */
    benchmark?: Array<{ benchmark?: string; score?: string }>;
    firstPrizes?: Prize[];
    achievementsAndPrizes?: PrizeTier[];
    guruPickEnable?: boolean;
    topPhotographerEnable?: boolean;
    levelsRankEnable?: boolean;
    newRankingEnable?: boolean;
    /** Coins to join; emitted as `join_coins`. */
    joinCoins?: number;
    /** Player cap; emitted as `max_players`. */
    maxPlayers?: number;
    /** The cover photo, with non-hex mock ids so mock mode never builds a real CDN url; emitted as `image`. */
    image?: { id: string; member_id: string };
    /** Emitted as `fill_locked` / `swap_locked`. */
    fillLocked?: boolean;
    swapLocked?: boolean;
    /** Swap count; emitted as `member.ranking.swaps` with one mock id per swap. */
    swaps?: number;
    /** `factor` 0 = no exposure yet; otherwise a random value of at most `cap`, drawn at generation time. */
    exposure: { factor: ExposureRange | 0; voteFactor: number; voteRatio: number };
    myEntries: RankedEntrySpec[];
    /** A team match running on this challenge; absent for most specs. */
    teamMatch?: TeamMatch;
}

export type { ChallengeSpec, ExposureRange, RankedEntrySpec };
