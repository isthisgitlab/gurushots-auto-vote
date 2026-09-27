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
 *       fired: { ruleId: { at, day?, phase? } },
 *       inFlight: { ruleId, actionIndex } | null,
 *       spent: { swaps, keys, fills },
 *       history: { photoId: [[unixSec, votes], …] },   // vote samples (scenarios/speed.ts)
 *       outbox: [{ id, at, message }],                // notices for the host notifiers
 *       lastAction: { at, ruleId, action, outcome } | null,
 *       lastError: { at, message } | null,
 *       updatedAt                               // ms, for pruning
 *   } }
 *
 * An unreadable file or a malformed record is reported as `corrupt` rather
 * than read as empty: the engine then halts that challenge until the user
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

import type { RawJsonStore, ScenarioState } from './types/stores';
import * as logger from './logger';
import { createJsonStore } from './settings/storage';
import { isPlainObject } from './plainObject';

const scenarioStateStore = createJsonStore({ fileName: 'scenarioState.json', prefKey: 'gs_scenario_state' });

// Challenges run for days, not months; anything older is a finished challenge.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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
    isPlainObject(r.spent) &&
    (r.history === undefined || isPlainObject(r.history)) &&
    (r.outbox === undefined || Array.isArray(r.outbox)) &&
    (r.inFlight === null ||
        (isPlainObject(r.inFlight) &&
            typeof r.inFlight.ruleId === 'string' &&
            Number.isInteger(r.inFlight.actionIndex)));

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

/**
 * Ledger over a raw-JSON store ({readRaw, writeRaw}).
 */
const createStateLedger = (store: RawJsonStore) => {
    // The engine and the settings overlay read state many times per pass;
    // re-parse only when the stored text changed.
    let lastRaw: string | null | undefined;
    let lastParsed: ParsedStateFile | undefined;

    const read = (): ParsedStateFile => {
        const raw = store.readRaw();
        // lastParsed is set together with lastRaw, and readRaw never returns undefined.
        if (raw === lastRaw) return lastParsed as ParsedStateFile;
        let parsed: ParsedStateFile;
        try {
            const value: unknown = JSON.parse(raw || '{}');
            parsed = isPlainObject(value) ? { ok: true, map: value } : { ok: false, map: {} };
        } catch {
            parsed = { ok: false, map: {} };
        }
        if (!parsed.ok) logger.withCategory('scenario').error('scenario state file is unreadable', null);
        lastRaw = raw;
        lastParsed = parsed;
        return parsed;
    };

    /** @param map */
    const write = (map: Record<string, unknown>) => {
        const cutoff = Date.now() - MAX_AGE_MS;
        const pruned: Record<string, Record<string, unknown>> = {};
        for (const [challengeId, record] of Object.entries(map)) {
            if (isPlainObject(record) && (record.updatedAt as number) > cutoff) pruned[challengeId] = record;
        }
        store.writeRaw(JSON.stringify(pruned));
    };

    return {
        /**
         * The state for one challenge: `{state: null}` when it has none yet,
         * `{state}` when readable, `{corrupt: true}` when the file or this
         * record cannot be trusted.
         */
        get: (challengeId: string | number): { corrupt: boolean; state: ScenarioState | null } => {
            const { ok, map } = read();
            if (!ok) return { corrupt: true, state: null };
            const record = map[String(challengeId)];
            if (record === undefined) return { corrupt: false, state: null };
            if (!isRecord(record)) return { corrupt: true, state: null };
            return { corrupt: false, state: structuredClone(record) };
        },

        /**
         * Store the state for one challenge. An unreadable file is replaced.
         */
        set: (challengeId: string | number, state: ScenarioState) => {
            const { map } = read();
            write({ ...map, [String(challengeId)]: { ...state, updatedAt: Date.now() } });
        },

        /**
         * Forget one challenge's state (a reset). An unreadable file is replaced.
         */
        remove: (challengeId: string | number) => {
            const { map } = read();
            const next = { ...map };
            delete next[String(challengeId)];
            write(next);
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

const scenarioStateLedger = createStateLedger(scenarioStateStore);

// Process-wide in-memory ledger for mock mode, shared by the mock voting pass
// and the scenario IPC handlers so a mock run is inspectable like a real one.
const mockScenarioStateLedger = createMemoryStateLedger();

export const initializeScenarioStateAsync = scenarioStateStore.initializeAsync;
export const refreshScenarioStateAsync = scenarioStateStore.refreshAsync;
export const flushScenarioStateWrites = scenarioStateStore.flushPendingWrites;
export { scenarioStateLedger, mockScenarioStateLedger, createStateLedger, createMemoryStateLedger, initialState };
