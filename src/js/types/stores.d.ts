/**
 * Shapes of the small persisted side stores (metadata.json and the ledgers in
 * swapBackStore / currencyAutoStore / scenarioStateStore). Type-only: nothing
 * here exists at runtime.
 */

/**
 * The raw-JSON transport a ledger sits on: settings/storage.js
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
 * Challenge ids are numeric strings, so no id collides with `updateCheck`.
 */
export type MetadataFile = { updateCheck: UpdateCheckData } & { [challengeId: string]: ChallengeMetadataEntry };

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
}

/** The entry-age ledger a voting pass reads and writes (entryAgeStore). */
export type EntryAgeLedger = ReturnType<typeof import('../entryAgeStore').createEntryAgeLedger>;

/** A scenario rule that finished firing. */
export interface ScenarioFiredRecord {
    at: number;
    day?: string;
    phaseEnteredAt?: number;
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
    inFlight: { ruleId: string; actionIndex: number } | null;
    /** currency spent, by kind (swaps / keys / fills) */
    spent: Record<string, number>;
    /** photo id → [[unixSec, votes], …] vote samples (scenarios/speed.js) */
    history?: Record<string, Array<[number, number]>>;
    /** notices for the host notifiers */
    outbox?: Array<{ id: string; at: number; message: string }>;
    lastAction?: { at: number; ruleId: string; action: string; outcome: string } | null;
    lastError?: { at: number; message: string } | null;
    /** ms, for pruning */
    updatedAt?: number;
}
