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
 *       fired: { ruleId: { at, day?, phaseEnteredAt?, unclearHalt? } },   // unclearHalt: the spend it stopped after
 *       inFlight: { ruleId, actionIndex, unclear?, unclearAt? } | null,   // unclear: the spend that got no answer, and when
 *       spent: { swaps, keys, fills },
 *       history: { photoId: [[unixSec, votes], …] },   // vote samples (scenarios/speed.ts)
 *       outbox: [{ id, at, message }],                // notices for the host notifiers
 *       lastAction: { at, ruleId, action, outcome } | null,
 *       lastError: { at, message } | null,
 *       updatedAt                               // ms, for pruning
 *   } }
 *
 * An unreadable file (an empty one included: a file written whole never is, so it was cut short) or a malformed
 * record is reported as `corrupt` rather than read as empty: the engine then halts that challenge until the user
 * resets it, because silently restarting a plan from its first phase could
 * repeat spends. Mock mode uses createMemoryStateLedger() and never touches
 * the persisted file.
 *
 * Same platform-aware transport as the other side stores; on Capacitor its
 * cache must be hydrated at boot (initializeScenarioStateAsync, Capacitor.tsx),
 * and the Android background service persists it through the native keyed
 * bridge (the `gs_scenario_state` key in AutoVoteService.kt). That service
 * advances scenarios while the app is open too, so the app re-reads the store
 * (refreshScenarioStateAsync) before it reads or resets scenario state.
 */

import type { RawJsonStore, ScenarioEpoch, ScenarioState, SpendAction } from './types/stores';
import * as logger from './logger';
import { createJsonStore } from './settings/storage';
import { isPlainObject } from './plainObject';
import { errorMessage } from './errorMessage';
import { acquireWithin } from './lockWait';
import { acquireUnlockLock } from './joinStateStore';

const NO_LOCK: StateLock = { ok: true, release: () => {} };

const scenarioStateStore = createJsonStore({
    fileName: 'scenarioState.json',
    prefKey: 'gs_scenario_state',
    atomic: true,
});

// Challenges run for days, not months; anything older is a finished challenge.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const SPEND_ACTIONS: ReadonlySet<unknown> = new Set<SpendAction>(['swap', 'unlockBoost', 'fillExposure']);

const isSpendAction = (value: unknown): value is SpendAction => SPEND_ACTIONS.has(value);

const isFiredRecord = (value: unknown): boolean =>
    isPlainObject(value) && (value.unclearHalt === undefined || isSpendAction(value.unclearHalt));

const isStringMap = (value: unknown): boolean =>
    isPlainObject(value) && Object.values(value).every((v) => typeof v === 'string');

/**
 * @param r - an untrusted parsed-JSON value
 */
const isRecord = (r: unknown): r is ScenarioState =>
    isPlainObject(r) &&
    typeof r.scenario === 'string' &&
    typeof r.phase === 'string' &&
    Number.isFinite(r.phaseEnteredAt) &&
    isStringMap(r.memory) &&
    isPlainObject(r.fired) &&
    Object.values(r.fired).every(isFiredRecord) &&
    isPlainObject(r.spent) &&
    Object.values(r.spent).every((count) => Number.isFinite(count) && Number(count) >= 0) &&
    (r.history === undefined || isPlainObject(r.history)) &&
    (r.outbox === undefined || Array.isArray(r.outbox)) &&
    (r.inFlight === null ||
        (isPlainObject(r.inFlight) &&
            typeof r.inFlight.ruleId === 'string' &&
            Number.isInteger(r.inFlight.actionIndex) &&
            (r.inFlight.unclear === undefined || isSpendAction(r.inFlight.unclear)) &&
            (r.inFlight.pending === undefined || isSpendAction(r.inFlight.pending)) &&
            (r.inFlight.unclearAt === undefined || Number.isFinite(r.inFlight.unclearAt)))) &&
    (r.gen === undefined || Number.isFinite(r.gen));

// What a reset of one challenge leaves in its place: the record is gone, its count of resets is not.
const isTombstone = (r: unknown): boolean => isPlainObject(r) && r.tombstone === true && Number.isFinite(r.gen);

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

type ParsedStateFile = { ok: boolean; map: Record<string, unknown> };

/** A cross-process lock, as joinStateStore's acquireUnlockLock gives one. */
type StateLock = { ok: boolean; release: () => void };

/** How a reset ended: done, not done because a lock is held, or not done because the file is unreadable. */
type ResetResult = 'removed' | 'busy' | 'unreadable';

/** What a change of the file came to: `refused` is a write of a state read before a reset. */
type Mutation = 'done' | 'busy' | 'unreadable' | 'refused';

// The state file is one file for every challenge, so a change of it is read-modify-write of the whole: two processes
// running different challenges would drop each other's change (a fired rule, a spend counter, an unclear marker,
// and with it the protection against repeating a landed spend). It is changed only under this lock, held briefly.
const FILE_LOCK_ID = 'scenariostate';
const FILE_LOCK_WAIT_MS = 500;
// The file's count of resets of every challenge (a challenge id is never a key like it).
const ALL_KEY = '@all';

const countOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * The resets a challenge's state is read under: of every challenge, and of this one. A tombstone keeps the count of
 * a challenge whose record was reset away; a record that cannot be read has none.
 */
const epochOf = (map: Record<string, unknown>, key: string): ScenarioEpoch => {
    const record = map[key];
    return { all: countOf(map[ALL_KEY]), gen: isPlainObject(record) ? countOf(record.gen) : 0 };
};

// A count that is higher than the last one, and than any a clock-less earlier reset could have left.
const nextCount = (previous: number): number => Math.max(previous + 1, Date.now());

/**
 * The state file's text as a map. No file is no state yet; a file with nothing in it was cut short, and is not read
 * as "no state".
 */
const parseStateFile = (raw: string | null): ParsedStateFile => {
    try {
        const value: unknown = raw === null ? {} : JSON.parse(raw);
        return isPlainObject(value) ? { ok: true, map: value } : { ok: false, map: {} };
    } catch {
        return { ok: false, map: {} };
    }
};

// The map without the records of challenges that finished long ago (the count of resets of every challenge stays).
const pruned = (map: Record<string, unknown>): Record<string, unknown> => {
    const cutoff = Date.now() - MAX_AGE_MS;
    return Object.fromEntries(
        Object.entries(map).filter(
            ([key, record]) => key === ALL_KEY || (isPlainObject(record) && (record.updatedAt as number) > cutoff),
        ),
    );
};

/**
 * The state file over a raw-JSON store: its parsed text (re-parsed only when the stored text changed: the engine and
 * the settings overlay read state many times per pass), its whole-file write (older records pruned) and the lock its
 * changes are made under.
 *
 * @param acquireLock - the cross-process lock of the file's changes; none where one process owns the file (mock
 *   mode, Android) and in tests
 */
const createStateFile = (store: RawJsonStore, acquireLock?: (id: string) => StateLock) => {
    let lastRaw: string | null | undefined;
    let lastParsed: ParsedStateFile | undefined;

    const read = (): ParsedStateFile => {
        const raw = store.readRaw();
        // lastParsed is set together with lastRaw, and readRaw never returns undefined.
        if (raw === lastRaw) return lastParsed as ParsedStateFile;
        const parsed = parseStateFile(raw);
        if (!parsed.ok) logger.withCategory('scenario').error('scenario state file is unreadable', null);
        lastRaw = raw;
        lastParsed = parsed;
        return parsed;
    };

    const write = (map: Record<string, unknown>) => store.writeRaw(JSON.stringify(pruned(map)));

    /**
     * Runs `change` under the file's lock, waited for a moment. False when the lock could not be had (nothing ran).
     */
    const underFileLock = (change: () => void): boolean => {
        const lock = acquireLock ? acquireWithin(() => acquireLock(FILE_LOCK_ID), FILE_LOCK_WAIT_MS) : NO_LOCK;
        if (!lock) {
            logger
                .withCategory('scenario')
                .warning('scenario state is locked by another process — nothing written', null);
            return false;
        }
        try {
            change();
            return true;
        } finally {
            lock.release();
        }
    };

    /**
     * Rewrites the file as `change` makes it from the file as it is now (read again under the lock); `change`
     * answers null to refuse. An unreadable file is never replaced by one challenge's change: that would wipe every
     * challenge's progress.
     */
    const mutate = (change: (map: Record<string, unknown>) => Record<string, unknown> | null): Mutation => {
        let result: Mutation = 'unreadable';
        const ran = underFileLock(() => {
            const { ok, map } = read();
            if (!ok) return;
            const next = change(map);
            if (next) write(next);
            result = next ? 'done' : 'refused';
        });
        return ran ? result : 'busy';
    };

    return { read, write, underFileLock, mutate };
};

/**
 * Ledger over a raw-JSON store ({readRaw, writeRaw}).
 *
 * @param acquireLock - see createStateFile
 */
const createStateLedger = (store: RawJsonStore, acquireLock?: (id: string) => StateLock) => {
    const { read, write, underFileLock, mutate } = createStateFile(store, acquireLock);

    // Writes one challenge's state into the file as it is now; false when it could not be (see `set`).
    const persist = (key: string, { epoch, ...state }: ScenarioState): boolean => {
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
        return result === 'done';
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
         * Store the state for one challenge, under the file's lock. False when it could not be written (the lock
         * is held, the file is unreadable, the write failed, or the state was read before a reset): the caller must
         * not go on to spend anything.
         */
        set: (challengeId: string | number, state: ScenarioState): boolean => persist(String(challengeId), state),

        /**
         * Forget one challenge's state (a reset), leaving a count of its resets that keeps a step that was running
         * from bringing it back. An unreadable file is left as it is: clearing it takes a reset of every challenge
         * (removeAll).
         */
        remove: (challengeId: string | number): ResetResult => {
            const key = String(challengeId);
            let result: ResetResult = 'unreadable';
            const ran = underFileLock(() => {
                const { ok, map } = read();
                if (!ok) return;
                const gen = nextCount(epochOf(map, key).gen);
                write({ ...map, [key]: { tombstone: true, gen, updatedAt: Date.now() } });
                result = 'removed';
            });
            return ran ? result : 'busy';
        },

        /**
         * Forget every challenge's state, an unreadable file included, and count it: no step that was running
         * writes its progress back.
         */
        removeAll: (): ResetResult => {
            const ran = underFileLock(() => {
                const { ok, map } = read();
                write({ [ALL_KEY]: nextCount(ok ? countOf(map[ALL_KEY]) : 0) });
            });
            return ran ? 'removed' : 'busy';
        },
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

const scenarioStateLedger = createStateLedger(scenarioStateStore, (id) =>
    acquireUnlockLock(id, { category: 'scenario', internal: true }),
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

export const initializeScenarioStateAsync = scenarioStateStore.initializeAsync;
export const refreshScenarioStateAsync = scenarioStateStore.refreshAsync;
export const flushScenarioStateWrites = scenarioStateStore.flushPendingWrites;
export {
    scenarioStateLedger,
    mockScenarioStateLedger,
    createStateLedger,
    createMemoryStateLedger,
    initialState,
    scenarioStepLock,
};
export type { ResetResult, StateLock };
