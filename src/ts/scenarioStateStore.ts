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
 * (initializeScenarioStateAsync, Capacitor.tsx), and the Android background service persists it through the native
 * keyed bridge (the `gs_scenario_state` key in AutoVoteService.kt). That service advances scenarios while the app is
 * open too, so the app re-reads the store (refreshScenarioStateAsync) before it reads or resets scenario state. A
 * reset made in the app is not written into the file from the app's cache (the service may have written it since):
 * it is asked for in a store of its own (`gs_scenario_resets`: `{ "<challengeId>": count, "@all": count }`), and
 * applied by whichever runtime reads or writes the file next.
 */

import type { RawJsonStore, ScenarioEpoch, ScenarioState } from './types/stores';
import * as logger from './logger';
import { createJsonStore } from './settings/storage';
import { errorMessage } from './errorMessage';
import { acquireUnlockLock } from './joinStateStore';
import { createStateFile, epochOf, isRecord, isTombstone } from './scenarioStateFile';
import type { Mutation, ResetResult, StateLock } from './scenarioStateFile';

// `strict`: a write the native bridge did not persist is a failed write, not a quiet one (the write-ahead marker is
// worth nothing otherwise).
const scenarioStateStore = createJsonStore({
    fileName: 'scenarioState.json',
    prefKey: 'gs_scenario_state',
    atomic: true,
    strict: true,
});

// The resets asked for on Android (see the header).
const scenarioResetsStore = createJsonStore({
    fileName: 'scenarioResets.json',
    prefKey: 'gs_scenario_resets',
    atomic: true,
    strict: true,
});

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

/** What writing a state came to. */
type SetResult = 'saved' | 'refused' | 'failed';

/**
 * Ledger over a raw-JSON store ({readRaw, writeRaw}).
 *
 * @param acquireLock - see createStateFile
 * @param requests - see createStateFile
 */
const createStateLedger = (store: RawJsonStore, acquireLock?: (id: string) => StateLock, requests?: RawJsonStore) => {
    const { read, mutate, resetOne, resetAll } = createStateFile(store, acquireLock, requests);

    // Writes one challenge's state into the file as it is now (see `set` for what it answers).
    const persist = (key: string, { epoch, ...state }: ScenarioState): SetResult => {
        const log = logger.withCategory('scenario');
        let result: Mutation = 'unreadable';
        try {
            result = mutate((map) => {
                const current = epochOf(map, key);
                // Read before a reset: its progress is not brought back.
                if (epoch && (epoch.all !== current.all || epoch.gen !== current.gen)) return null;
                return { ...map, [key]: { ...state, gen: current.gen, updatedAt: Date.now() } };
            });
        } catch (error) {
            log.error(`scenario state could not be written: ${errorMessage(error)}`, null);
        }
        if (result === 'refused')
            log.warning(`scenario state of challenge ${key} was reset meanwhile — not written`, null);
        if (result === 'done') return 'saved';
        return result === 'refused' ? 'refused' : 'failed';
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
        ): { corrupt: false | 'file' | 'record'; state: ScenarioState | null; epoch: ScenarioEpoch } => {
            const key = String(challengeId);
            const { ok, map } = read();
            if (!ok) return { corrupt: 'file', state: null, epoch: { all: 0, gen: 0 } };
            const epoch = epochOf(map, key);
            const record = map[key];
            if (record === undefined || isTombstone(record)) return { corrupt: false, state: null, epoch };
            if (!isRecord(record)) return { corrupt: 'record', state: null, epoch };
            return { corrupt: false, state: { ...structuredClone(record), epoch }, epoch };
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
        remove: (challengeId: string | number): ResetResult => resetOne(String(challengeId)),

        /**
         * Forget every challenge's state, an unreadable file included, and count it: no step that was running
         * writes its progress back.
         */
        removeAll: (): ResetResult => resetAll(),
    };
};

/** Ledger over an in-memory store — mock mode, tests. */
const createMemoryStateLedger = () => {
    let raw: string | null = null;
    return createStateLedger({
        readRaw: () => raw,
        writeRaw: (data) => {
            raw = data;
        },
    });
};

const scenarioStateLedger = createStateLedger(
    scenarioStateStore,
    (id) => acquireUnlockLock(id, { category: 'scenario', internal: true }),
    scenarioResetsStore,
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

export const initializeScenarioStateAsync = async () => {
    await scenarioStateStore.initializeAsync();
    await scenarioResetsStore.initializeAsync();
};
export const refreshScenarioStateAsync = async () => {
    await scenarioStateStore.refreshAsync();
    await scenarioResetsStore.refreshAsync();
};
export const flushScenarioStateWrites = async () => {
    await scenarioStateStore.flushPendingWrites();
    await scenarioResetsStore.flushPendingWrites();
};
export {
    scenarioStateLedger,
    mockScenarioStateLedger,
    createStateLedger,
    createMemoryStateLedger,
    initialState,
    scenarioStepLock,
};
export type { ResetResult, SetResult, StateLock };
