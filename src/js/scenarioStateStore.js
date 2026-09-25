/**
 * Scenario runtime state: where each challenge is in its user-defined
 * scenario (settings/scenarios.js) — current phase, remembered photos, which
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
 *       history: { photoId: [[unixSec, votes], …] },   // vote samples (scenarios/speed.js)
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
 * cache must be hydrated at boot (initializeScenarioStateAsync, Capacitor.jsx),
 * and the Android background service persists it through the native keyed
 * bridge (the `gs_scenario_state` key in AutoVoteService.kt). That service
 * advances scenarios while the app is open too, so the app re-reads the store
 * (refreshScenarioStateAsync) before it reads or resets scenario state.
 */

const logger = require('./logger');
const { createJsonStore } = require('./settings/storage');

const scenarioStateStore = createJsonStore({ fileName: 'scenarioState.json', prefKey: 'gs_scenario_state' });

// Challenges run for days, not months; anything older is a finished challenge.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isStringMap = (value) => isPlainObject(value) && Object.values(value).every((v) => typeof v === 'string');

const isRecord = (r) =>
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

/** A fresh record for a challenge entering `scenario` at its start phase. */
const initialState = (scenario, phase, nowSec) => ({
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

/**
 * Ledger over a raw-JSON store ({readRaw, writeRaw}).
 */
const createStateLedger = (store) => {
    // The engine and the settings overlay read state many times per pass;
    // re-parse only when the stored text changed.
    let lastRaw;
    let lastParsed;

    const read = () => {
        const raw = store.readRaw();
        if (raw === lastRaw) return lastParsed;
        let parsed;
        try {
            const value = JSON.parse(raw || '{}');
            parsed = isPlainObject(value) ? { ok: true, map: value } : { ok: false, map: {} };
        } catch {
            parsed = { ok: false, map: {} };
        }
        if (!parsed.ok) logger.withCategory('scenario').error('scenario state file is unreadable', null);
        lastRaw = raw;
        lastParsed = parsed;
        return parsed;
    };

    const write = (map) => {
        const cutoff = Date.now() - MAX_AGE_MS;
        const pruned = {};
        for (const [challengeId, record] of Object.entries(map)) {
            if (isPlainObject(record) && record.updatedAt > cutoff) pruned[challengeId] = record;
        }
        store.writeRaw(JSON.stringify(pruned));
    };

    return {
        /**
         * The state for one challenge: `{state: null}` when it has none yet,
         * `{state}` when readable, `{corrupt: true}` when the file or this
         * record cannot be trusted.
         */
        get: (challengeId) => {
            const { ok, map } = read();
            if (!ok) return { corrupt: true, state: null };
            const record = map[String(challengeId)];
            if (record === undefined) return { corrupt: false, state: null };
            if (!isRecord(record)) return { corrupt: true, state: null };
            return { corrupt: false, state: structuredClone(record) };
        },

        /** Store the state for one challenge. An unreadable file is replaced. */
        set: (challengeId, state) => {
            const { map } = read();
            write({ ...map, [String(challengeId)]: { ...state, updatedAt: Date.now() } });
        },

        /** Forget one challenge's state (a reset). An unreadable file is replaced. */
        remove: (challengeId) => {
            const { map } = read();
            const next = { ...map };
            delete next[String(challengeId)];
            write(next);
        },
    };
};

/** Ledger over an in-memory store — mock mode, tests. */
const createMemoryStateLedger = () => {
    let raw = null;
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

module.exports = {
    scenarioStateLedger,
    mockScenarioStateLedger,
    createStateLedger,
    createMemoryStateLedger,
    initialState,
    initializeScenarioStateAsync: scenarioStateStore.initializeAsync,
    refreshScenarioStateAsync: scenarioStateStore.refreshAsync,
    flushScenarioStateWrites: scenarioStateStore.flushPendingWrites,
};
