/**
 * Scenario runtime state: where each challenge is in its user-defined
 * scenario (settings/scenarios.ts) — current phase, remembered photos, which
 * rules already fired, an action in flight, currency spent, and the last
 * action / error for the status line.
 *
 * Shape, keyed by challenge id:
 *   { "<challengeId>": {
 *       scenario, phase, phaseEnteredAt,        // unix seconds
 *       memory: { slot: photoId },
 *       fired: { ruleId: { at, day?, phaseEnteredAt?, unclearHalt?, haltOrigin? } },
 *           // unclearHalt: the spend the rule was stopped after; haltOrigin 'pending': it was stopped from a
 *           // `pending` marker (the app stopped before it knew whether the spend was sent), not from a spend
 *           // GuruShots gave no answer to
 *       inFlight: { ruleId, actionIndex, unclear?, unclearAt?, pending? } | null,
 *           // unclear: the spends of the step at actionIndex that got no answer (a list: one per action type, an
 *           // edit of the scenario can leave several), counted in `spent`, never spent again; unclearAt: when;
 *           // pending: the spend the step is about to make, written down BEFORE it is made. A leftover pending
 *           // marker is found by the next run, in whatever process, and is treated like an unclear one, counted
 *           // when it is recovered
 *       spent: { swaps, keys, fills },
 *       history: { photoId: [[unixSec, votes], …] },   // vote samples (scenarios/speed.ts)
 *       outbox: [{ id, at, message }],                // notices for the host notifiers
 *       published?: { revision, documentFingerprint, phase, phaseEnteredAt, observedAt, validUntil, bindings, profile },
 *           // the overlay the runner prepared for the active phase (settings/scenarioOverlay.ts); a malformed one reads
 *           // as an unavailable publication, never as a corrupt record
 *       lastAction: { at, ruleId, action, outcome } | null,
 *       lastError: { at, message } | null,
 *       gen,                                    // how many times this challenge was reset when it was written
 *       updatedAt                               // ms, for pruning
 *   },
 *   "<challengeId>": { tombstone: true, gen, updatedAt },  // a challenge that was reset: its record is gone, its
 *                                                          // count of resets stays
 *   "@all": <count> }                                      // how many times every challenge was reset
 *
 * Every state read carries the resets it was read under (`epoch`: `@all` and its own `gen`); a write of a state read
 * under older ones is refused, so a step that was running when its challenge was reset cannot bring the old
 * progress back, whichever process it runs in and whatever locks there are.
 *
 * An unreadable file (an empty one included: a file written whole never is, so it was cut short) is `corrupt: 'file'`
 * and a malformed record `corrupt: 'record'`, rather than read as empty: the engine then halts that challenge until the
 * user resets it (every challenge, for a file; this one, for a record), because silently restarting a plan from its
 * first phase could repeat spends. A record that is malformed is kept by every write until it is reset. Mock mode
 * uses createMemoryStateLedger() and never touches the persisted file.
 *
 * Same platform-aware transport as the other side stores; on Capacitor its cache must be hydrated at boot
 * (initializeScenarioStateAsync, shells/capacitor/page.tsx), and the Android background service persists it through the native
 * keyed bridge (the `gs_scenario_state` key in AutoVoteService.kt). That service advances scenarios while the app is
 * open too, so the app re-reads the store (refreshScenarioStateAsync) before it reads or resets scenario state. A
 * reset made in the app is not written into the file from the app's cache (the service may have written it since):
 * it is asked for in a store of its own (`gs_scenario_resets`: `{ "<challengeId>": count, "@all": count }`), and
 * applied by whichever runtime reads or writes the file next. A request is saved before anything can read it, so one
 * that could not be saved has taken effect nowhere. While the app's caches hold nothing known (a start-up read failed)
 * the file reads as `corrupt: 'unloaded'`: plans stay paused and nothing is reset, until a read succeeds.
 */

import type { RawJsonStore, ScenarioEpoch, ScenarioState } from './types/stores';
import * as logger from './logger';
import { platform } from './platform/port';
import { createJsonStore } from './settings/storage';
import { fileErrorMessage } from './errorMessage';
import { createMemoryRawJsonStore } from './parseUntrustedJson';
import { acquireUnlockLock } from './joinStateStore';
import {
    INSTALLATION_KEY,
    createStateFile,
    epochOf,
    isPublication,
    isRecord,
    isReservedSubject,
    isTombstone,
} from './scenarioStateFile';
import type { Mutation, ResetResult, StateLock } from './scenarioStateFile';

const STATE_KEY = 'gs_scenario_state';
const RESETS_KEY = 'gs_scenario_resets';

// `strict`: a write the native bridge did not persist is a failed write, not a quiet one (the write-ahead marker is
// worth nothing otherwise). Its cache keeps the latest write when the app's Preferences refuse it: that is the record
// of a spend that may already have been made, and taking it back would let the rule spend again.
const scenarioStateStore = createJsonStore({
    fileName: 'scenarioState.json',
    prefKey: STATE_KEY,
    atomic: true,
    strict: true,
});

// The resets asked for on Android (see the header).
const scenarioResetsStore = createJsonStore({
    fileName: 'scenarioResets.json',
    prefKey: RESETS_KEY,
    atomic: true,
    strict: true,
});

/**
 * Whether the stores hold what is saved. A read that failed (the Android app's caches are filled by a read at start-up;
 * the background service reads through its bridge each time) leaves a store empty because it could not be filled, not
 * because nothing is saved, and a plan restarted from nothing could spend again. Everywhere else the stores are the
 * files themselves.
 */
const scenarioStateLoaded = (): boolean =>
    platform().storage.loaded(STATE_KEY) && platform().storage.loaded(RESETS_KEY);

/**
 * A fresh record for a challenge entering `scenario` at its start phase.
 */
const initialState = (scenario: string, phase: string, nowSec: number): ScenarioState => ({
    scenario,
    phase,
    phaseEnteredAt: nowSec,
    memory: {},
    fired: {},
    inFlight: null,
    spent: { swaps: 0, keys: 0, fills: 0 },
    history: {},
    outbox: [],
    lastAction: null,
    lastError: null,
});

// A record as text (null: there is none), for telling whether it changed.
const textOf = (record: unknown): string | null => (record === undefined ? null : JSON.stringify(record));

/**
 * What writing a state came to: `stale` is a write made under a generation the stored record no longer has (a handoff or
 * an owner change moved it), which no retry can fix.
 */
type SetResult = 'saved' | 'refused' | 'stale' | 'failed';

/** What a lifecycle change of one record answers: the state as written, or why nothing was (`reason`). */
type ChangeResult = { ok: true; state: ScenarioState } | { ok: false; reason: string };

/** The answer of a change that declines: why. */
type Declined = { refuse: string };

/** One subject's record as the whole file lists it: its state, or `state: null` when the record cannot be read. */
type Listed = { key: string; state: ScenarioState | null };

// The key a request for a challenge or the installation (never any other `@` key) may use.
const reservedKeyText = (key: string) => `scenario subject "${key.slice(0, 40)}" is a reserved name — refused`;

// A stored record as a state: a malformed publication is left out and flagged, never the whole record unreadable.
const stateOf = (record: ScenarioState, epoch: ScenarioEpoch): ScenarioState => {
    const { published, ...rest } = structuredClone(record);
    if (published === undefined || isPublication(published)) {
        return { ...rest, ...(published ? { published } : {}), epoch };
    }
    return { ...rest, publicationUnreadable: true, epoch };
};

/**
 * Ledger over a raw-JSON store ({readRaw, writeRaw}).
 *
 * @param acquireLock - see createStateFile
 * @param requests - see createStateFile
 * @param isLoaded - see createStateFile
 */
const createStateLedger = (
    store: RawJsonStore,
    acquireLock?: (id: string) => StateLock,
    requests?: RawJsonStore,
    isLoaded?: () => boolean,
) => {
    const { read, mutate, resetOne, resetAll } = createStateFile(store, acquireLock, requests, isLoaded);

    // The record each read of a challenge found (as text, made when a write needs it; null: none), by the epoch it handed
    // out, which every state derived from that read carries: what a write is compared against, so that a state is
    // written only over the record it was made from. After a write it is the text written, for the next write of the
    // same states.
    const bases = new WeakMap<ScenarioEpoch, () => string | null>();

    // Writes one challenge's state into the file as it is now (see `set` for what it answers).
    const persist = (
        key: string,
        { epoch, publicationUnreadable: _unreadable, ...state }: ScenarioState,
    ): SetResult => {
        const log = logger.withCategory('scenario');
        if (isReservedSubject(key)) {
            log.error(reservedKeyText(key), null);
            return 'refused';
        }
        let result: Mutation = 'unreadable';
        const made: { text: string | null; changed: boolean; stale: boolean } = {
            text: null,
            changed: false,
            stale: false,
        };
        try {
            result = mutate((map) => {
                const current = epochOf(map, key);
                // Read before a reset: its progress is not brought back.
                if (epoch && (epoch.all !== current.all || epoch.gen !== current.gen)) return null;
                // Written under a generation the record has left (a handoff, an owner change): refused here, in the same
                // step that would write, so no read-then-write gap lets a former owner through.
                const stored = map[key];
                if ((state.generation ?? 0) !== (isRecord(stored) ? (stored.generation ?? 0) : 0)) {
                    made.stale = true;
                    return null;
                }
                // Changed since it was read (by a process whose step lock this one lost, say): not written over.
                const base = epoch ? bases.get(epoch) : undefined;
                if (base && base() !== textOf(map[key])) {
                    made.changed = true;
                    return null;
                }
                const record = { ...state, gen: current.gen, updatedAt: Date.now() };
                made.text = JSON.stringify(record);
                return { ...map, [key]: record };
            });
        } catch (error) {
            log.error(`scenario state could not be written: ${fileErrorMessage(error)}`, null);
        }
        if (result === 'refused') {
            log.warning(
                made.stale
                    ? `scenario state of challenge ${key} moved to another generation meanwhile — not written`
                    : made.changed
                      ? `scenario state of challenge ${key} was changed by another process meanwhile — not written`
                      : `scenario state of challenge ${key} was reset meanwhile — not written`,
                null,
            );
        }
        if (result !== 'done') return result === 'refused' ? (made.stale ? 'stale' : 'refused') : 'failed';
        if (epoch) bases.set(epoch, () => made.text);
        return 'saved';
    };

    return {
        /**
         * The state for one challenge: `{state: null}` when it has none yet, `{state}` when readable, and `corrupt`
         * when it cannot be trusted: `'file'` (the whole file is unreadable: only a reset of every challenge
         * clears it) or `'record'` (this challenge's record is bad: a reset of this challenge does). `epoch` is
         * the resets the answer was read under; a state carries it, and is not written back across a reset.
         * Reading never writes.
         */
        get: (
            challengeId: string | number,
        ): { corrupt: false | 'file' | 'record' | 'unloaded'; state: ScenarioState | null; epoch: ScenarioEpoch } => {
            const key = String(challengeId);
            const { ok, map, unloaded } = read();
            if (!ok) return { corrupt: unloaded ? 'unloaded' : 'file', state: null, epoch: { all: 0, gen: 0 } };
            // A key that is no subject's (`@all` is a count) reads as a record that cannot be used, never as progress.
            if (isReservedSubject(key)) return { corrupt: 'record', state: null, epoch: { all: 0, gen: 0 } };
            const epoch = epochOf(map, key);
            const record = map[key];
            bases.set(epoch, () => textOf(record));
            if (record === undefined || isTombstone(record)) return { corrupt: false, state: null, epoch };
            if (!isRecord(record)) return { corrupt: 'record', state: null, epoch };
            // A malformed publication is left out of the state and flagged, never the whole record unreadable: it is
            // derived data, and the next step publishes it again.
            return { corrupt: false, state: stateOf(record, epoch), epoch };
        },

        /**
         * Changes one subject's record as `make` says, from the record as it is when the file's lock is held (the whole
         * read, the decision and the write are one step, so nothing lands between them). `make` answers the record to
         * store, or `{ refuse }` to leave it as it is; it may carry the generation on, advance it, or finish a handoff.
         * Nothing is written for a file that cannot be read or is not loaded (`state-unreadable`), for a record that
         * cannot be read, or for a subject that is no subject's key.
         */
        change: (key: string, make: (current: ScenarioState | null) => ScenarioState | Declined): ChangeResult => {
            const log = logger.withCategory('scenario');
            if (isReservedSubject(key)) {
                log.error(reservedKeyText(key), null);
                return { ok: false, reason: 'reserved-subject' };
            }
            const out: { declined: string; written: ScenarioState | null } = {
                declined: 'state-unreadable',
                written: null,
            };
            let result: Mutation;
            try {
                result = mutate((map) => {
                    const stored = map[key];
                    const epoch = epochOf(map, key);
                    const present = isRecord(stored) ? stored : null;
                    if (present === null && stored !== undefined && !isTombstone(stored)) {
                        out.declined = 'state-unreadable';
                        return null;
                    }
                    const current = present === null ? null : stateOf(present, epoch);
                    const next = make(current);
                    if ('refuse' in next) {
                        out.declined = next.refuse;
                        return null;
                    }
                    // What is not stored (the epoch a read carried, the flag of a publication left out) is not written.
                    const state = { ...next };
                    delete state.epoch;
                    delete state.publicationUnreadable;
                    out.written = { ...state, gen: epoch.gen, updatedAt: Date.now() };
                    return { ...map, [key]: out.written };
                });
            } catch (error) {
                log.error(`scenario state could not be written: ${fileErrorMessage(error)}`, null);
                return { ok: false, reason: 'not-saved' };
            }
            if (result === 'done' && out.written) return { ok: true, state: out.written };
            if (result === 'refused') return { ok: false, reason: out.declined };
            return { ok: false, reason: result === 'unreadable' ? 'state-unreadable' : result };
        },

        /**
         * Every subject the file holds a record for (a tombstone and the count of resets are not subjects), with its state, or
         * `state: null` for a record that cannot be read. `corrupt` when the file itself cannot be read or is not
         * loaded: then nothing is listed. Reading never writes.
         */
        list: (): { corrupt: false | 'file' | 'unloaded'; subjects: Listed[] } => {
            const { ok, map, unloaded } = read();
            if (!ok) return { corrupt: unloaded ? 'unloaded' : 'file', subjects: [] };
            const subjects = Object.entries(map)
                .filter(([key, record]) => !isReservedSubject(key) && !isTombstone(record))
                .map(([key, record]) => ({
                    key,
                    state: isRecord(record) ? stateOf(record, epochOf(map, key)) : null,
                }));
            return { corrupt: false, subjects };
        },

        /**
         * Store the state for one challenge, under the file's lock: `saved`, `refused` (the state was read before a
         * reset: there is nothing to try again) or `failed` (the lock is held or cannot be made, the file is
         * unreadable, or the write failed: another try may do). Anything but `saved` means the caller must not go
         * on to spend anything.
         */
        set: (challengeId: string | number, state: ScenarioState): SetResult => persist(String(challengeId), state),

        /**
         * Forget one challenge's state (a reset), leaving a count of its resets that keeps a step that was running
         * from bringing it back. An unreadable file is left as it is: clearing it takes a reset of every challenge
         * (removeAll).
         */
        remove: (challengeId: string | number): Promise<ResetResult> =>
            isReservedSubject(String(challengeId)) ? Promise.resolve('unreadable') : resetOne(String(challengeId)),

        /**
         * Forget every challenge's state, an unreadable file included, and count it: no step that was running
         * writes its progress back.
         */
        removeAll: (onlyIfUnreadable?: boolean): Promise<ResetResult> => resetAll(onlyIfUnreadable),
    };
};

/** Ledger over an in-memory store — mock mode, tests. */
const createMemoryStateLedger = () => createStateLedger(createMemoryRawJsonStore());

const scenarioStateLedger = createStateLedger(
    scenarioStateStore,
    (id) => acquireUnlockLock(id, { category: 'scenario', internal: true }),
    scenarioResetsStore,
    scenarioStateLoaded,
);

/**
 * The cross-process lock of one challenge's scenario steps: one process runs a challenge's rule steps (or resets it)
 * at a time. Not granted twice, and never waited for.
 */
const scenarioStepLock = (challengeId: string | number): StateLock =>
    acquireUnlockLock(`scenario-${String(challengeId)}`, { category: 'scenario', internal: true });

// Process-wide in-memory ledger for mock mode, shared by the mock voting pass
// and the scenario IPC handlers so a mock run is inspectable like a real one.
const mockScenarioStateLedger = createMemoryStateLedger();

/**
 * The progress ledger of a mode: the in-memory one in mock mode, the persisted one otherwise. Mock mode never reads or
 * writes the persisted `scenarioState` store.
 */
const ledgerFor = (mock: boolean) => (mock ? mockScenarioStateLedger : scenarioStateLedger);

export const initializeScenarioStateAsync = async () => {
    await scenarioStateStore.initializeAsync();
    await scenarioResetsStore.initializeAsync();
};
export const refreshScenarioStateAsync = async () => {
    await scenarioStateStore.refreshAsync();
    await scenarioResetsStore.refreshAsync();
};
// Waits for both stores, whether or not the first one's last write persisted, and says so if either did not.
export const flushScenarioStateWrites = async () => {
    const settled = await Promise.allSettled([
        scenarioStateStore.flushPendingWrites(),
        scenarioResetsStore.flushPendingWrites(),
    ]);
    const failed = settled.find((outcome) => outcome.status === 'rejected');
    if (failed) throw failed.reason;
};

export {
    INSTALLATION_KEY,
    scenarioStateLedger,
    scenarioStateLoaded,
    mockScenarioStateLedger,
    ledgerFor,
    createStateLedger,
    createMemoryStateLedger,
    initialState,
    scenarioStepLock,
};
export type { StateLock };
