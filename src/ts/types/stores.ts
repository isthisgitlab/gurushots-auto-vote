/**
 * Shapes of the small persisted side stores (metadata.json and the ledgers in
 * swapBackStore / currencyAutoStore / scenarioStateStore). Type-only: nothing
 * here exists at runtime.
 */

import type { EntryEnteredTime } from './gurushots';

/** What `updateThrough` came to: saved, left alone because `update` declined (answered null), or not saved. */
export type ThroughResult = 'saved' | 'aborted' | 'failed';

/**
 * The raw-JSON transport a ledger sits on: settings/storage.ts
 * createJsonStore(), or an in-memory fake (mock mode, tests).
 */
export interface RawJsonStore {
    /** Raw JSON string, or null when never written. */
    readRaw(): string | null;
    writeRaw(data: string): void;
    /** Calls `listener` when the store's data is discarded (a wipe of local data). Absent on a store that is not wiped. */
    onDiscard?(listener: () => void): void;
    /**
     * `updateThrough` where the store is read and written in one step (a desktop, the background service): its outcome
     * is the answer. Null where the write is only queued (the Android app window): use `updateThrough`. Absent where
     * a write is made before `writeRaw` returns.
     */
    updateNow?(update: (current: string | null) => string | null): ThroughResult | null;
    /**
     * Writes a value made from the current one that nothing reads before it is saved (the Android app, whose writes
     * go behind a cache, puts it in the cache only once it is): `saved`; `failed` (it was not, and nothing changed); or
     * `aborted` (`update` answered null: it looked at the value it would overwrite, as it is when its turn comes, and
     * wrote nothing). `update` may be called again, on a newer value, when a write was queued while this one was
     * being saved: it must make the same change (compute anything that varies, a count, once, outside it).
     * Absent where a write is made before it returns.
     */
    updateThrough?(update: (current: string | null) => string | null): Promise<ThroughResult>;
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
    /** Ids whose `entered` time is the app's own submit time (exact), not the time a fetch first showed them. */
    exact: string[];
    /** The account the entries belong to (from the entries' `member_id`); null until a listing says. */
    memberId: string | null;
    /** False for a record a submit created before any fetch had seen the challenge. */
    observed: boolean;
    /**
     * Unix seconds of the first fetch that showed this record's entries (0: not yet, or a file from before it was
     * kept). An entry whose `entered` time is 0 was there by then, which is the time the UI shows for it ("or earlier").
     */
    firstSeen: number;
}

/** Per challenge id, per entry id: the entry's recorded time (only entries whose time is known). */
export type EntryTimes = Record<string, Record<string, EntryEnteredTime>>;

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
