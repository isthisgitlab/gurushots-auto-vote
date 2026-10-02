/**
 * Shape of one mock challenge as authored in the spec tables.
 */

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
    eventId: number;
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
    status: string;
    startsIn: number;
    closesIn: number;
    joined: boolean;
    entries: number;
    players: number;
    votes: number;
    maxPhotoSubmits: number;
    badge: string;
    type: string;
    tags: string[];
    prizesWorth: number;
    rankingLevels: [number, number, number, number, number];
    boostEnabled: boolean;
    timeLeft: { days: number; hours: number; minutes: number; seconds: number };
    boost: { state: string; timeout: BoostTimeout };
    turbo: { state: string; opensIn: number | null };
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
    /** `factor` 0 = no exposure yet; otherwise a random value of at most `cap`, drawn at generation time. */
    exposure: { factor: ExposureRange | 0; voteFactor: number; voteRatio: number };
    myEntries: RankedEntrySpec[];
}

export type { ChallengeSpec, ExposureRange, RankedEntrySpec };
