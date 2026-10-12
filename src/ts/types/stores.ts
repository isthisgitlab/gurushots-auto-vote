/**
 * Shapes of the small persisted side stores (metadata.json and the ledgers in
 * swapBackStore / currencyAutoStore / scenarioStateStore). Type-only: nothing
 * here exists at runtime.
 */

/**
 * The raw-JSON transport a ledger sits on: settings/storage.ts
 * createJsonStore(), or an in-memory fake (mock mode, tests).
 */
export interface RawJsonStore {
    /** Raw JSON string, or null when never written. */
    readRaw(): string | null;
    writeRaw(data: string): void;
}

/** One challenge's entry in metadata.json. */
export interface ChallengeMetadataEntry {
    /** ISO timestamp of the last vote. */
    lastVoteTime?: string;
    /** Exposure level when the vote occurred (may exceed 100). */
    exposureBump?: number;
    /** Entry-id snapshot for voteOnNewEntry (compared as a set). */
    entryIds?: string[];
}

/** The `updateCheck` bookkeeping block of metadata.json. */
export interface UpdateCheckData {
    /** Unix timestamp (ms) of the last update check. */
    lastCheck: number | null;
    /** Legacy metadata-resident skipped version. */
    skipVersion: string | null;
}

/**
 * metadata.json: the `updateCheck` block plus one entry per challenge id.
 * Challenge ids are numeric strings, so no id collides with `updateCheck`;
 * metadata.ts reads a challenge's entry through its `challengeEntry` accessor.
 */
export interface MetadataFile {
    updateCheck: UpdateCheckData;
    [challengeId: string]: ChallengeMetadataEntry | UpdateCheckData;
}

/** One swap-back record: a slot holding a replacement for a boosted/turbo'd photo. */
export interface SwapBackRecord {
    /** The photo now in the slot. */
    currentId: string;
    /** The boosted/turbo'd original to swap back in. */
    previousId: string;
    previousMemberId: string;
    kind: 'boost' | 'turbo';
    /** ms timestamp, for pruning. */
    at: number;
}

/** Automatic exposure fills spent on one challenge. */
export interface AutoSpendRecord {
    fills: number;
    /** ms timestamp, for pruning. */
    at: number;
}

/** When each of one challenge's entries entered it (entryAgeStore). */
export interface EntryAgeRecord {
    /** The challenge's close time (Unix seconds), for pruning. */
    closeTime: number;
    /** Unix seconds each entry id was first seen; 0 = already there on the first sighting. */
    entered: Record<string, number>;
    /** The photo a boost fill-new submitted and is waiting to boost. */
    pending: string | null;
    /** Auto-submitted entries without a theme match; never inferred for manual entries. */
    uncertain?: string[];
}

/** The entry-age ledger a voting pass reads and writes (entryAgeStore). */
export type EntryAgeLedger = ReturnType<typeof import('../entryAgeStore').createEntryAgeLedger>;

/** The scenario actions that spend currency. */
export type SpendAction = 'swap' | 'unlockBoost' | 'fillExposure';

/** A scenario rule that finished firing. */
export interface ScenarioFiredRecord {
    at: number;
    /** the local day it fired: that day's midnight, unix seconds */
    day?: number;
    phaseEnteredAt?: number;
    /**
     * The action type of a spend that got no answer, after which the rule was stopped so that it is never spent
     * again: the rule stays held for the phase it stopped in (see repeatBlock).
     */
    unclearHalt?: SpendAction;
    /**
     * Set when the rule was stopped from a `pending` marker (the app stopped before it knew whether the spend was
     * sent), not from one that got no answer from GuruShots: the notice words them differently.
     */
    haltOrigin?: 'pending';
}

/** A challenge's runtime position in its scenario (scenarioStateStore record). */
export interface ScenarioState {
    scenario: string;
    phase: string;
    /** unix seconds */
    phaseEnteredAt: number;
    /** slot → photo id */
    memory: Record<string, string>;
    /** rule id → when it fired */
    fired: Record<string, ScenarioFiredRecord>;
    /**
     * `unclear`: the spends of the step at `actionIndex` that got no answer (one per action type: an edit of the
     * scenario can leave several) and are never spent again, already counted in `spent`; `unclearAt`: when (unix
     * seconds); `pending`: the spend the step is about to make, written down BEFORE it is made, so that a step whose
     * result was never written (a crash, a lock held) is found on the next run and treated like `unclear`: looked
     * at, never spent again, and counted when it is recovered
     */
    inFlight: {
        ruleId: string;
        actionIndex: number;
        unclear?: SpendAction[];
        unclearAt?: number;
        pending?: SpendAction;
        /** The `unclear` spends that came from a `pending` marker: the app, not GuruShots, did not know. */
        lost?: SpendAction[];
    } | null;
    /** currency spent, by kind (swaps / keys / fills) */
    spent: Record<string, number>;
    /** photo id → [[unixSec, votes], …] vote samples (scenarios/speed.ts) */
    history?: Record<string, Array<[number, number]>>;
    /** notices for the host notifiers */
    outbox?: Array<{ id: string; at: number; message: string }>;
    lastAction?: { at: number; ruleId: string; action: string; outcome: string } | null;
    lastError?: { at: number; message: string } | null;
    /** ms, for pruning */
    updatedAt?: number;
    /** how many times this challenge's record was reset when the stored one was written (see ScenarioEpoch) */
    gen?: number;
    /**
     * Not stored: the resets this state was read under. A write of a state read under older ones is refused, so a
     * step that was running when its challenge (or every challenge) was reset cannot bring the old progress back.
     */
    epoch?: ScenarioEpoch;
}

/** The resets a state was read under: of every challenge (`all`) and of its own challenge (`gen`). */
export interface ScenarioEpoch {
    all: number;
    gen: number;
}
