/**
 * Shapes of the small persisted side stores (metadata.json and the ledgers in
 * swapBackStore / currencyAutoStore / scenarioStateStore). Type-only: nothing
 * here exists at runtime.
 */

import type { EntryEnteredTime } from './gurushots';

/** What `updateThrough` came to: saved, left alone because `update` declined (answered null), or not saved. */
export type ThroughResult = 'saved' | 'aborted' | 'failed';

/** What the native compare-and-write answered: saved, or not because the key had changed (and what it holds). */
export type CasAnswer = { saved: boolean; current: string | null };

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

/** One swap-back record: a slot holding a replacement for a boosted, turbo'd or guru-picked photo. */
export interface SwapBackRecord {
    /** The photo now in the slot. */
    currentId: string;
    /** The boosted, turbo'd or guru-picked original to swap back in. */
    previousId: string;
    previousMemberId: string;
    /** What the original carries; priority boost > turbo > guruPick when it carries several. */
    kind: 'boost' | 'turbo' | 'guruPick';
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
    /** False for a record a submit created before any fetch had seen the challenge. */
    observed: boolean;
    /**
     * Unix seconds of the first fetch that showed this record's entries; for a record from an older file (0 until it is
     * observed again), the earliest time a fetch stamped one of them. Either way an entry whose `entered` time is 0 was
     * there by then, which is the time the UI shows for it ("or earlier").
     */
    firstSeen: number;
    /**
     * The Boost-pinned-submit failure latch: the pinned photo that could not be submitted, and the Boost window it
     * failed in. A new Boost window or a different pin is a new key; the latch is dropped once its window passed.
     */
    pinSubmitFailed?: { imageId: string; boostDeadline: number } | null;
}

/**
 * Per challenge id, per entry id: when the entry went in — its recorded time (exact when the app submitted it), or for
 * an entry of unknown age the record's `firstSeen` (not exact: it was there by then). An entry the ledger does not hold
 * is left out.
 */
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

/**
 * What the scenario runner published for a challenge's active phase: the one prepared settings overlay everything else
 * reads (settings/scenarioOverlay.ts). Only the resolved binding values are held; the phase's literals and its profile
 * are read from the current configuration, and `documentFingerprint` proves they still are what the publication was
 * made from.
 */
export interface ScenarioPublication {
    /** Counts the publications of this record (1 for the first). */
    revision: number;
    /** A hash of the phase's definition and of the profile it selects, as they were when this was published. */
    documentFingerprint: string;
    phase: string;
    /** The phase entry this was published for: a publication does not outlive its phase entry. */
    phaseEnteredAt: number;
    /** unix seconds: when the evidence the bindings were resolved from was observed */
    observedAt: number;
    /** unix seconds: the next instant a binding result can change at, or null when none is known */
    validUntil: number | null;
    /** setting key → resolved value, one per binding of the phase */
    bindings: Record<string, unknown>;
    /** The profile the phase selected, or null. */
    profile: string | null;
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
    /** The overlay the runner published for the active phase (see ScenarioPublication). */
    published?: ScenarioPublication;
    /**
     * The assignment generation of this subject (absent: 0). A runner step writes only while the stored generation is the
     * one it read; a handoff and an owner change of the installation scenario advance it, so a former owner fails its next write.
     */
    generation?: number;
    /** Set while the subject is paused: no rule action and no publication update runs (`at`: unix seconds). */
    paused?: { at: number; reason: string } | null;
    /**
     * A handoff to another scenario that was begun and not finished: the assignment it left (`from`), the one it goes to
     * (`to`; null: none) and the generation it was begun at. While it stands the subject runs no action.
     */
    handoff?: { from: string; to: string | null; generation: number; at: number } | null;
    /** The last lifecycle request applied to the subject (unix seconds), for a repeated request to answer the same. */
    lastRequest?: { id: string; result: string; at: number } | null;
    /**
     * Not stored: set when the stored record held a `published` field that is malformed. The field is left out of the
     * state (the next write drops it), and the publication reads as unavailable; the rest of the record is intact.
     */
    publicationUnreadable?: true;
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

/**
 * The priority Stop fence (scenarioStopFence.json): one small cell, apart from the progress ledger and from any control
 * inbox. `stopEpoch` counts the full Stops; `blocked` is set by a Stop and cleared only by a fresh explicit user re-arm.
 */
export interface ScenarioStopFence {
    stopEpoch: number;
    blocked: boolean;
    lastStop: { requestId: string; at: number; durable: boolean } | null;
}
