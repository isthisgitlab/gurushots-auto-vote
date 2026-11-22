/**
 * The pure part of a scenario simulation: the request and its assumptions as one validated shape, the virtual clock, the
 * advance from one instant to the next, and the trace of what each pass changed in the simulated record.
 *
 * It runs no rule and makes no request: the lifecycle, the voting pass and the shared outcome reducer run as live, over
 * memory stores and controlled evidence (services/scenarioRunner/simulation.ts), and this module only says when the next pass
 * is and what it showed. Nothing here reads the clock, the settings or any store.
 */

import { isPlainObject } from '../plainObject';
import { isValidId } from '../ids';
import { SCENARIO_CAPS, SIMULATION_OPERATIONS, SIMULATION_OUTCOMES, SIMULATION_SUBJECT_KINDS } from './vocabulary';

import type { Bankroll, Challenge, LibraryPhoto } from '../types/gurushots';
import type { ScenarioPublication, ScenarioState } from '../types/stores';
import type {
    SimulationAssumptions,
    SimulationDeadline,
    SimulationEvent,
    SimulationFacts,
    SimulationOperation,
    SimulationOutcome,
    SimulationRequest,
    SimulationSubject,
} from '../types/scenario';

/** Evidence snapshots one request may carry. */
const MAX_SNAPSHOTS = 32;

/** Events a run keeps; more ends it as `limit`. */
const MAX_EVENTS = 200;

/** Passes a run makes at most. */
const MAX_PASSES = 200;

/** Passes at one instant while work is still being done (a catch-up lands one photo per pass). */
const MAX_PASSES_PER_INSTANT = 6;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
    typeof value === 'string' && list.some((item) => item === value);

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isChallenge = (value: unknown): value is Challenge =>
    isPlainObject(value) && (typeof value.id === 'string' || typeof value.id === 'number');

const isBankroll = (value: unknown): value is Bankroll =>
    isPlainObject(value) && [value.keys, value.swaps, value.fills, value.coins].every(isCount);

const isLibraryPhoto = (value: unknown): value is LibraryPhoto => isPlainObject(value) && typeof value.id === 'string';

const FACT_KEYS = ['challenge', 'bankroll', 'library'] as const;

const parseFacts = (value: unknown): Parsed<SimulationFacts> => {
    if (!isPlainObject(value)) return refuse('invalid-assumptions');
    if (Object.keys(value).some((key) => !isOneOf(FACT_KEYS, key))) return refuse('invalid-assumptions');
    const facts: SimulationFacts = {};
    if (value.challenge !== undefined) {
        if (!isChallenge(value.challenge)) return refuse('invalid-assumptions');
        facts.challenge = value.challenge;
    }
    if (value.bankroll !== undefined) {
        if (!isBankroll(value.bankroll)) return refuse('invalid-assumptions');
        facts.bankroll = value.bankroll;
    }
    if (value.library !== undefined) {
        if (!Array.isArray(value.library) || !value.library.every(isLibraryPhoto)) return refuse('invalid-assumptions');
        facts.library = value.library;
    }
    return { ok: true, value: facts };
};

const parseOutcomes = (value: unknown): Parsed<Partial<Record<SimulationOperation, SimulationOutcome>>> => {
    if (!isPlainObject(value)) return refuse('invalid-assumptions');
    const outcomes: Partial<Record<SimulationOperation, SimulationOutcome>> = {};
    for (const [operation, outcome] of Object.entries(value)) {
        if (!isOneOf(SIMULATION_OPERATIONS, operation) || !isOneOf(SIMULATION_OUTCOMES, outcome)) {
            return refuse('invalid-assumptions');
        }
        outcomes[operation] = outcome;
    }
    return { ok: true, value: outcomes };
};

const parseSnapshots = (value: unknown): Parsed<NonNullable<SimulationAssumptions['snapshots']>> => {
    if (!Array.isArray(value) || value.length > MAX_SNAPSHOTS) return refuse('invalid-assumptions');
    const snapshots: NonNullable<SimulationAssumptions['snapshots']> = [];
    for (const item of value) {
        if (!isPlainObject(item) || Object.keys(item).some((key) => key !== 'at' && key !== 'facts')) {
            return refuse('invalid-assumptions');
        }
        if (typeof item.at !== 'number' || !Number.isSafeInteger(item.at) || item.at < 0) {
            return refuse('invalid-assumptions');
        }
        const facts = parseFacts(item.facts);
        if (!facts.ok) return facts;
        snapshots.push({ at: item.at, facts: facts.value });
    }
    // In time order; snapshots at the same instant keep the order they were written in.
    return { ok: true, value: snapshots.sort((left, right) => left.at - right.at) };
};

/**
 * The assumptions of a request, validated: outcomes per kind of operation and timed evidence snapshots, bounded in number and
 * in size. Anything else in them is refused, never ignored.
 */
const parseAssumptions = (value: unknown): Parsed<SimulationAssumptions> => {
    if (value === undefined) return { ok: true, value: {} };
    if (!isPlainObject(value) || Object.keys(value).some((key) => key !== 'outcomes' && key !== 'snapshots')) {
        return refuse('invalid-assumptions');
    }
    if (JSON.stringify(value).length > SCENARIO_CAPS.importBytes) return refuse('assumptions-too-large');
    const assumptions: SimulationAssumptions = {};
    if (value.outcomes !== undefined) {
        const outcomes = parseOutcomes(value.outcomes);
        if (!outcomes.ok) return outcomes;
        assumptions.outcomes = outcomes.value;
    }
    if (value.snapshots !== undefined) {
        const snapshots = parseSnapshots(value.snapshots);
        if (!snapshots.ok) return snapshots;
        assumptions.snapshots = snapshots.value;
    }
    return { ok: true, value: assumptions };
};

const parseSubject = (value: unknown): Parsed<SimulationSubject> => {
    if (!isPlainObject(value) || !isOneOf(SIMULATION_SUBJECT_KINDS, value.kind)) return refuse('invalid-subject');
    if (value.kind === 'installation') {
        // The installation has no challenge: one named is refused, never ignored.
        return Object.keys(value).some((key) => key !== 'kind')
            ? refuse('installation-takes-no-challenge')
            : { ok: true, value: { kind: 'installation' } };
    }
    if (Object.keys(value).some((key) => key !== 'kind' && key !== 'challengeId')) return refuse('invalid-subject');
    if (!isValidId(value.challengeId)) return refuse('challenge-required');
    return { ok: true, value: { kind: value.kind, challengeId: String(value.challengeId) } };
};

/** A request whose scenario draft is only known to be an object: the scenario validator checks it against the schema. */
type RawSimulationRequest = Omit<SimulationRequest, 'scenario' | 'assumptions'> & {
    scenario: { name: string } | { draft: unknown };
    assumptions: SimulationAssumptions;
};

const parseScenarioRef = (value: unknown): Parsed<RawSimulationRequest['scenario']> => {
    if (!isPlainObject(value)) return refuse('invalid-scenario');
    const keys = Object.keys(value);
    if (keys.length !== 1) return refuse('invalid-scenario');
    if (typeof value.name === 'string' && value.name.trim() !== '') {
        return { ok: true, value: { name: value.name.trim() } };
    }
    // A draft is checked by the scenario validator, which names what is wrong with it.
    if (isPlainObject(value.draft)) return { ok: true, value: { draft: value.draft } };
    return refuse('invalid-scenario');
};

/**
 * The request as the handler takes it, validated. The scenario's draft is only known to be an object here: the scenario
 * validator checks it against the schema.
 *
 * Failures are stable codes: `invalid-request`, `invalid-scenario`, `invalid-subject`, `challenge-required`,
 * `installation-takes-no-challenge`, `invalid-until`, `invalid-assumptions`, `assumptions-too-large`.
 */
const parseSimulationRequest = (
    input: unknown,
): { ok: true; request: RawSimulationRequest } | { ok: false; error: string } => {
    if (!isPlainObject(input)) return refuse('invalid-request');
    if (Object.keys(input).some((key) => !['scenario', 'subject', 'until', 'assumptions'].includes(key))) {
        return refuse('invalid-request');
    }
    const scenario = parseScenarioRef(input.scenario);
    if (!scenario.ok) return scenario;
    const subject = parseSubject(input.subject);
    if (!subject.ok) return subject;
    if (typeof input.until !== 'number' || !Number.isSafeInteger(input.until) || input.until < 0) {
        return refuse('invalid-until');
    }
    const assumptions = parseAssumptions(input.assumptions);
    if (!assumptions.ok) return assumptions;
    return {
        ok: true,
        request: {
            scenario: scenario.value,
            subject: subject.value,
            until: input.until,
            assumptions: assumptions.value,
        },
    };
};

/**
 * A virtual clock in unix seconds: it moves only when the run sets it.
 */
const createVirtualClock = (startSec: number) => {
    let sec = startSec;
    return {
        nowMs: () => sec * 1000,
        nowSec: () => sec,
        set: (next: number) => {
            sec = next;
        },
    };
};

/**
 * Where the run goes after a pass at `now`: the earliest of the boundaries the scenario and the evidence name that lies after
 * `now`, if it is not past `until`. A boundary that is not after `now` is never one (no zero-delay loop); one that is unknown
 * is none. `idle`: no boundary is left at all; `horizon`: the next one is past `until`.
 */
const advanceTo = (
    now: number,
    wakes: ReadonlyArray<number | null>,
    until: number,
): { at: number } | { stop: 'idle' } | { stop: 'horizon'; next: number } => {
    const ahead = wakes.filter((wake): wake is number => wake !== null && Number.isFinite(wake) && wake > now);
    if (ahead.length === 0) return { stop: 'idle' };
    const at = Math.min(...ahead);
    return at > until ? { stop: 'horizon', next: at } : { at };
};

/** The identity of a publication for the trace: a new revision is a new publication. */
const publicationOf = (state: ScenarioState | null): ScenarioPublication | null => state?.published ?? null;

/**
 * What a pass changed in the subject's simulated record, as events: a rule recorded as fired, a phase change, a publication
 * made, a notice left for the user. Pure: two records in, the events out.
 *
 * @param subject - the record's key (a challenge id, or the installation's)
 */
const traceStateChange = (
    before: ScenarioState | null,
    after: ScenarioState | null,
    at: number,
    subject: string,
): SimulationEvent[] => {
    if (after === null) return [];
    const events: SimulationEvent[] = [];
    for (const [ruleId, record] of Object.entries(after.fired)) {
        const was = before?.fired[ruleId];
        if (!was || was.at !== record.at) {
            events.push({ type: 'rule', at, subject, phase: before?.phase ?? after.phase, ruleId, applied: true });
        }
    }
    if (before && before.phase !== after.phase) {
        events.push({ type: 'phase', at, subject, from: before.phase, to: after.phase, applied: true });
    }
    const published = publicationOf(after);
    if (published && published.revision !== publicationOf(before)?.revision) {
        events.push({
            type: 'published',
            at,
            subject,
            phase: published.phase,
            validUntil: published.validUntil,
            applied: true,
        });
    }
    const seen = new Set((before?.outbox ?? []).map((notice) => notice.id));
    for (const notice of after.outbox ?? []) {
        if (!seen.has(notice.id)) events.push({ type: 'notice', at, subject, message: notice.message, applied: true });
    }
    return events;
};

/** The deadlines of the final published phase, as the scheduler and the final recheck read them: resolved, never invented. */
const deadlinesOf = (state: ScenarioState | null): SimulationDeadline[] => {
    const published = publicationOf(state);
    if (!published) return [];
    const deadlines: SimulationDeadline[] = [];
    for (const row of published.schedules?.submit?.rows ?? []) {
        deadlines.push({ kind: 'submit', count: row.count, at: row.state === 'known' ? row.at : null });
    }
    for (const kind of ['vote', 'pause'] as const) {
        for (const row of published.schedules?.[kind]?.rows ?? []) {
            deadlines.push({
                kind,
                start: row.state === 'known' ? row.start : null,
                end: row.state === 'known' ? row.end : null,
            });
        }
    }
    deadlines.push({ kind: 'publication', validUntil: published.validUntil });
    return deadlines;
};

export {
    MAX_EVENTS,
    MAX_PASSES,
    MAX_PASSES_PER_INSTANT,
    MAX_SNAPSHOTS,
    advanceTo,
    createVirtualClock,
    deadlinesOf,
    parseAssumptions,
    parseSimulationRequest,
    traceStateChange,
};
export type { RawSimulationRequest };
