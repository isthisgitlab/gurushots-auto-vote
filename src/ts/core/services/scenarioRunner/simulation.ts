/**
 * The simulation coordinator: runs a scenario's whole lifecycle ahead of time, over memory stores, controlled evidence and
 * assumed outcomes, with a virtual clock — the same installation / pre-join / active / post-close composition and the same
 * voting pass the app runs live (mock/strategy.ts), not a copy of them.
 *
 * What is injected, and nothing else:
 *   - the stores: a memory progress ledger (the settings overlay reads it too, through the simulation scope), and the strategy's
 *     own memory ledgers (entry ages, entry tracker, spend and swap ledgers);
 *   - the evidence: a controlled endpoint set (`controlledEndpoints`) answering from the subject's starting evidence and the
 *     assumption's timed snapshots; whatever neither gives is unknown (a read that failed), never invented;
 *   - the outcomes: each request that changes the account answers what the assumptions say. One the assumptions do not cover
 *     stops the run as `needsEvidence`: the pass that needed it is undone, and the run says which outcome it needs;
 *   - the clock: the virtual one, through the shared clock (simulationScope.ts).
 *
 * The run happens inside the simulation scope (simulationScope.ts): one at a time, no yield to the event loop, no real write and
 * no real request. Nothing real is read after the scope opens except the configuration the scenario's settings come from.
 */

import * as logger from '../../logger';
import { platform } from '../../platform/port';
import { captureInstallationTimezone } from '../installationTimezone';
import { applyBoost } from '../../strategies/real/applyBoost';
import { createMockStrategy } from '../../mock/strategy';
import { INSTALLATION_KEY, createStateLedger, initialState } from '../../scenarioStateStore';
import { createMemoryRawJsonStore } from '../../parseUntrustedJson';
import { createMemoryAutoSpendLedger } from '../../currencyAutoStore';
import { createMemoryEntryAgeLedger } from '../../entryAgeStore';
import { createMemoryLedger } from '../../swapBackStore';
import { createMemoryEntryTracker } from '../newEntryTracker';
import { isClaimable } from '../autoClaim';
import { ISOLATION_BREACHED, runInSimulationScope, simulationScope } from '../../simulationScope';
import { soonestAccountWake } from '../../scheduling/thresholdWindow/ruleWakes';
import { nextWakeAt } from '../../scenarios/nextWake';
import {
    MAX_EVENTS,
    MAX_PASSES,
    MAX_PASSES_PER_INSTANT,
    advanceTo,
    createVirtualClock,
    deadlinesOf,
    traceStateChange,
} from '../../scenarios/simulate';
import { errorMessage } from '../../errorMessage';

import type { MockEndpoints } from '../../mock/apiClient';
import type { ConfigV2 } from '../../types/config';
import type {
    ActionResult,
    Bankroll,
    Challenge,
    CompletedChallenge,
    LibraryPhoto,
    TurboGameResult,
} from '../../types/gurushots';
import type { ScenarioState } from '../../types/stores';
import type { ScenarioDocument } from '../../settings/scenarioSchema';
import type {
    SimulationAssumptions,
    SimulationDiagnostic,
    SimulationEvent,
    SimulationFacts,
    SimulationNeed,
    SimulationOperation,
    SimulationOutcome,
    SimulationResult,
    SimulationStopReason,
    SimulationSubject,
} from '../../types/scenario';

/** How far past the run's end a subject with no challenge looks for its next boundary: a year. */
const LOOKAHEAD_SEC = 366 * 86400;

/** The token the simulated cycles run under: it never reaches a transport. */
const SIMULATION_TOKEN = 'simulation';

/** What the handler read once, before the scope opened. */
type SimulationEvidence = {
    /** The account's balances, or null when the read failed. */
    bankroll: Bankroll | null;
} & (
    | { provenance: 'installation' }
    /** The subject's challenge as its producer listed it. */
    | { provenance: 'active-list' | 'open-list'; challenge: Challenge }
    | { provenance: 'completed-list'; challenge: CompletedChallenge }
);

type SimulationInput = {
    scenario: ScenarioDocument;
    /** Where the scenario came from: a document that is not saved yet, or a stored one. */
    source: 'draft' | 'stored';
    subject: SimulationSubject;
    evidence: SimulationEvidence;
    /** The first instant of the run (unix seconds): the real one when the request was made. */
    start: number;
    /** The last instant of the run (unix seconds). */
    until: number;
    assumptions: SimulationAssumptions;
};

/** The first call of an operation the run made, as the trace keeps it. */
type OperationRecord = { at: number; subject: string; operation: string; outcome: SimulationOutcome };

/** The world the controlled endpoints answer from. */
type World = {
    active: Challenge | null;
    candidate: Challenge | null;
    completed: CompletedChallenge | null;
    bankroll: Bankroll | null;
    library: LibraryPhoto[] | null;
    /** The photos whose submit landed, by challenge: shown in the challenge's entries when it is next read. */
    landed: Map<string, string[]>;
};

/** What a Turbo game that was not played answers (as the endpoint does when it cannot reach the server). */
const NO_BATTLES: TurboGameResult = { kind: 'classic', played: 0, correct: 0, flipped: 0, doubleFailed: 0, won: false };

/** The world the run starts in: a copy of the starting evidence, which the passes change as they go (the input is left as it was). */
const worldOf = (evidence: SimulationEvidence): World => ({
    active: evidence.provenance === 'active-list' ? structuredClone(evidence.challenge) : null,
    candidate: evidence.provenance === 'open-list' ? structuredClone(evidence.challenge) : null,
    completed: evidence.provenance === 'completed-list' ? structuredClone(evidence.challenge) : null,
    bankroll: evidence.bankroll && { ...evidence.bankroll },
    library: null,
    landed: new Map(),
});

const cloneWorld = (world: World): World => ({
    active: world.active && structuredClone(world.active),
    candidate: world.candidate && structuredClone(world.candidate),
    completed: world.completed && structuredClone(world.completed),
    bankroll: world.bankroll && { ...world.bankroll },
    library: world.library && structuredClone(world.library),
    landed: new Map([...world.landed].map(([id, photos]) => [id, [...photos]])),
});

/** The challenge a snapshot replaces: the one the subject's kind names. */
const applyFacts = (world: World, facts: SimulationFacts, subject: SimulationSubject): void => {
    if (facts.challenge) {
        const copy = structuredClone(facts.challenge);
        if (subject.kind === 'active') world.active = copy;
        else if (subject.kind === 'candidate') world.candidate = copy;
        else if (subject.kind === 'completed') world.completed = copy;
    }
    if (facts.bankroll) world.bankroll = { ...facts.bankroll };
    if (facts.library) world.library = structuredClone(facts.library);
};

const entryIdsOf = (challenge: Challenge): string[] =>
    (challenge.member?.ranking?.entries ?? []).map((entry) => String(entry.id));

/** A candidate that was joined: the same challenge, now with the photos that went in as its entries. */
const joinedFrom = (candidate: Challenge, photos: string[]): Challenge => ({
    ...candidate,
    member: { ...candidate.member, ranking: { ...candidate.member?.ranking, entries: photos.map((id) => ({ id })) } },
});

/** The challenge as it is now: the photos whose submit landed are among its entries. */
const showLanded = (world: World, challenge: Challenge): Challenge => {
    const landed = world.landed.get(String(challenge.id)) ?? [];
    const ranking = challenge.member?.ranking;
    const missing = landed.filter((id) => !entryIdsOf(challenge).includes(id));
    if (missing.length === 0 || !ranking) return challenge;
    ranking.entries = [...(ranking.entries ?? []), ...missing.map((id) => ({ id }))];
    return challenge;
};

type Controlled = {
    client: MockEndpoints;
    operations: OperationRecord[];
    /** The first outcome the run needed and the assumptions do not give, or null. */
    need: () => SimulationNeed | null;
};

/**
 * The controlled endpoints: the endpoint set the mock strategy composes over, answering from `world`. A read the world has no
 * answer for fails as the real one does when it fails; a request that changes the account answers the assumed outcome, and
 * stops the run (`need`) when none is assumed.
 */
const controlledEndpoints = (
    world: World,
    assumed: NonNullable<SimulationAssumptions['outcomes']>,
    clock: { nowSec: () => number },
): Controlled => {
    const operations: OperationRecord[] = [];
    const state: { need: SimulationNeed | null } = { need: null };

    /** Answers a request that changes the account: the assumed outcome's answer, its effect only when it went through. */
    const act = <R>(
        operation: SimulationOperation,
        endpoint: string,
        subject: string,
        answers: { success: () => R; refused: () => R; unclear: () => R },
        effect?: () => void,
    ): R => {
        const outcome = assumed[operation];
        const at = clock.nowSec();
        if (outcome === undefined) {
            // Not assumed: nothing is done, and the run stops on it. (The answer given only lets the pass finish.)
            state.need ??= { operation, subject, at };
            return answers.unclear();
        }
        operations.push({ at, subject, operation: endpoint, outcome });
        if (outcome === 'success') effect?.();
        return answers[outcome]();
    };

    /** The library as an eligible-photos read shows it: the photos already entered in the challenge are left out. */
    const eligible = (search: string): LibraryPhoto[] => {
        const entered = new Set([
            ...(world.active ? entryIdsOf(world.active) : []),
            ...(world.active ? (world.landed.get(String(world.active.id)) ?? []) : []),
        ]);
        const found = (world.library ?? []).filter((photo) => !entered.has(String(photo.id)));
        return search === ''
            ? found
            : found.filter((photo) => (photo.labels ?? []).some((label) => label.toLowerCase() === search));
    };

    const spend = (key: keyof Bankroll) => () => {
        if (world.bankroll && world.bankroll[key] > 0) world.bankroll[key] -= 1;
    };

    const action = (success: boolean, unclear = false): ActionResult => ({
        ok: success,
        raw: success ? { success: true } : unclear ? null : { success: false },
        ...(unclear ? { unclear: true } : {}),
    });
    const actionAnswers = () => ({
        success: () => action(true),
        refused: () => action(false),
        unclear: () => action(false, true),
    });
    const booleanAnswers = { success: () => true, refused: () => false, unclear: () => false };

    const client: MockEndpoints = {
        authenticate: async () => null,
        getActiveChallenges: async () => ({
            challenges: world.active ? [showLanded(world, world.active)] : [],
        }),
        // The images a vote would go to are future data the run has no evidence of: unknown.
        getVoteImages: async () => null,
        submitVotes: async () => undefined,
        applyBoost: async (challenge, token) =>
            applyBoost(challenge, token, async (challengeId) =>
                act(
                    'boost',
                    'applyBoost',
                    challengeId,
                    { success: () => ({ success: true }), refused: () => null, unclear: () => null },
                    () => {
                        if (world.active?.member?.boost) world.active.member.boost.state = 'USED';
                    },
                ),
            ),
        applyBoostToEntry: async (challengeId) =>
            act('boost', 'applyBoostToEntry', String(challengeId), {
                success: () => ({ success: true }),
                refused: () => null,
                unclear: () => null,
            }),
        applyTurbo: async (challengeId) => act('turbo', 'applyTurbo', String(challengeId), actionAnswers()),
        runTurboGame: async (challenge) =>
            act<TurboGameResult>('turbo', 'runTurboGame', String(challenge?.id), {
                success: () => ({ kind: 'classic', played: 1, correct: 1, flipped: 0, doubleFailed: 0, won: true }),
                refused: () => NO_BATTLES,
                unclear: () => NO_BATTLES,
            }),
        getEligiblePhotos: async (_challengeId, _token, options = {}) =>
            eligible(typeof options.search === 'string' ? options.search.trim().toLowerCase() : ''),
        getEligiblePhotosWalk: async (_challengeId, _token, options = {}) => {
            if (world.library === null) return { items: [], truncated: true, nextStart: 0, stop: 'failed' };
            const found = eligible(typeof options.search === 'string' ? options.search.trim().toLowerCase() : '');
            const { skip } = options;
            return {
                items: skip ? found.filter((photo) => !skip(photo)) : found,
                ...(skip ? { skipped: found.filter((photo) => skip(photo)).map((photo) => String(photo.id)) } : {}),
                truncated: false,
                nextStart: found.length,
                stop: 'end',
            };
        },
        getLibrarySuggestedIds: async () => null,
        getImageData: async () => null,
        submitToChallenge: async (challengeId, imageIds) =>
            act('submit', 'submitToChallenge', String(challengeId), actionAnswers(), () => {
                const id = String(challengeId);
                const photos = [...(world.landed.get(id) ?? []), ...imageIds];
                world.landed.set(id, photos);
                // A candidate that went in is a joined challenge from now on.
                if (world.candidate && String(world.candidate.id) === id) {
                    world.active = joinedFrom(world.candidate, photos);
                    world.candidate = null;
                }
            }),
        getMemberChallenges: async (_token, filter = 'open') =>
            filter === 'open' ? (world.candidate ? [world.candidate] : []) : null,
        getSuggestedPhotoIds: async () => [],
        getBankroll: async () => (world.bankroll ? { ...world.bankroll } : null),
        getMyCompletedChallenges: async (_token, start = 0, limit = 20) =>
            world.completed ? [world.completed].slice(start, start + limit) : [],
        claimChallengeResources: async (challengeId) =>
            act('claim', 'claimChallengeResources', String(challengeId), booleanAnswers, () => {
                // Claimed: nothing is waiting any more. The rewards' value is not credited: it is not known.
                const rewards = world.completed?.member?.rewards_by_section;
                if (world.completed && rewards && isClaimable(world.completed)) rewards.claim_state = 'CLAIMED';
            }),
        // The missions are unknown to the run: no list is read, and none is claimed without an assumed outcome.
        getMyMissions: async () => null,
        claimMissionPrize: async (missionId) =>
            act('claim', 'claimMissionPrize', `mission:${missionId}`, booleanAnswers),
        getCurrentMemberProfile: async () => null,
        searchTagAutocomplete: async () => [],
        coinsUnlock: async (challengeId) =>
            act('join', 'coinsUnlock', String(challengeId), actionAnswers(), () => {
                const price = world.candidate?.join_coins;
                if (world.bankroll && typeof price === 'number')
                    world.bankroll.coins = Math.max(0, world.bankroll.coins - price);
            }),
        keyUnlock: async (challengeId) =>
            act('keyUnlock', 'keyUnlock', String(challengeId), actionAnswers(), spend('keys')),
        swapPhoto: async (challengeId) =>
            act('swap', 'swapPhoto', String(challengeId), actionAnswers(), spend('swaps')),
        exposureAutofill: async (challengeId) =>
            act('fill', 'exposureAutofill', String(challengeId), actionAnswers(), spend('fills')),
    };
    return { client, operations, need: () => state.need };
};

/** The strategy's fresh memory stores, and the raw store behind the progress ledger (to put a pass's changes back). */
const memoryStores = () => {
    const raw = createMemoryRawJsonStore();
    const scenarioLedger = createStateLedger(raw);
    return {
        raw,
        stores: {
            entryTracker: createMemoryEntryTracker(),
            autoSpendLedger: createMemoryAutoSpendLedger(),
            swapLedger: createMemoryLedger(),
            entryAges: createMemoryEntryAgeLedger(),
            scenarioLedger,
            interChallengeDelayMs: 0,
        },
    };
};

/**
 * The real configuration with the scenario and its assignment applied in memory: the draft (or the stored scenario) under its
 * name, assigned to the subject. Nothing of the argument is changed.
 */
const simulatedSettings =
    (scenario: ScenarioDocument, source: 'draft' | 'stored', subject: SimulationSubject) =>
    (config: ConfigV2): ConfigV2 => {
        const name = scenario.name;
        const sameName = (key: string) => key.trim().toLowerCase() === name.trim().toLowerCase();
        const scenarios =
            source === 'draft'
                ? {
                      ...Object.fromEntries(Object.entries(config.scenarios).filter(([key]) => !sameName(key))),
                      [name]: scenario,
                  }
                : config.scenarios;
        if (subject.kind === 'installation') {
            return {
                ...config,
                scenarios,
                installationScenario: { scenario: name, executor: platform().capabilities.executor, generation: 0 },
            };
        }
        const record = config.challenges[subject.challengeId] ?? {};
        return {
            ...config,
            scenarios,
            challenges: {
                ...config.challenges,
                [subject.challengeId]: { ...record, values: { ...record.values, scenario: name } },
            },
        };
    };

/** The soonest instant after `now` the scenario wants to look at the subject again (null: none is known). */
const subjectWake = async (
    input: SimulationInput,
    state: ScenarioState | null,
    world: World,
    timezone: string,
    now: number,
): Promise<number | null> => {
    const { scenario, subject, until } = input;
    // A subject with no challenge looks ahead past the run's end (never to a challenge's close time), so the run can say where it would look next.
    const lookahead = until + LOOKAHEAD_SEC;
    if (subject.kind === 'installation') {
        const start = await soonestAccountWake(now, () => ({
            installation: { scenario, state, timezone, horizon: lookahead },
            candidates: [],
            claimAt: null,
            missionExpiry: null,
        }));
        return start?.startTime ?? null;
    }
    const challenge = subject.kind === 'active' ? world.active : subject.kind === 'candidate' ? world.candidate : null;
    const record = state ?? { phase: scenario.start, phaseEnteredAt: now, memory: {}, fired: {}, inFlight: null };
    return nextWakeAt({
        scenario,
        state: record,
        // A closed challenge has no close time to look up to: the run's own horizon bounds it, as for the installation.
        challenge,
        horizon: lookahead,
        now,
        timezone,
        phaseClock: state !== null,
        facts: challenge
            ? { challenge, state: { phaseEnteredAt: record.phaseEnteredAt, memory: record.memory }, now, timezone }
            : null,
    });
};

/**
 * Why the requested subject's scenario halted, from the runner's own signal (never from a notice's text): null when none did. A
 * halt of another subject — a challenge run still runs the installation's stage — is not this run's.
 */
const haltOf = (key: string): string | null =>
    simulationScope()?.halts.find((halt) => halt.subject === key)?.reason ?? null;

/** A run that stopped before it began, or whose result was discarded: halted, with the reason and nothing else. */
const haltedResult = (input: SimulationInput, halted: string): SimulationResult => ({
    events: [],
    assumptions: input.assumptions,
    diagnostics: [],
    deadlines: [],
    finalState: null,
    stopReason: 'halted',
    stoppedAt: input.start,
    passes: [],
    needs: null,
    halted,
});

/** What the run used, and where each came from. */
const diagnosticsOf = (input: SimulationInput, timezone: string): SimulationDiagnostic[] => {
    const { scenario, subject, evidence } = input;
    return [
        { key: 'scenario', value: scenario.name, provenance: input.source === 'draft' ? 'draft' : 'saved scenario' },
        {
            key: 'subject',
            value: subject.kind === 'installation' ? 'installation' : subject.challengeId,
            provenance: evidence.provenance,
        },
        { key: 'timezone', value: timezone, provenance: 'installation setting' },
        ...(subject.kind === 'completed'
            ? [
                  {
                      key: 'progress',
                      value: scenario.start,
                      provenance: 'assumed: the challenge ran under this scenario from its start phase',
                  },
              ]
            : []),
        { key: 'start', value: input.start, provenance: 'clock when the request was made' },
        { key: 'until', value: input.until, provenance: 'request' },
        {
            key: 'bankroll',
            value: evidence.bankroll ? 'read' : 'unknown',
            provenance: evidence.bankroll ? 'account read before the run' : 'read failed; not assumed',
        },
    ];
};

/**
 * The run itself, inside the scope: pass after pass of the live composition at the virtual clock's instants, until the
 * horizon, nothing more is due, an outcome is needed, the scenario halts, or a cap is reached.
 */
const drive = async (
    input: SimulationInput,
    clock: ReturnType<typeof createVirtualClock>,
    memory: ReturnType<typeof memoryStores>,
    timezone: string,
): Promise<SimulationResult> => {
    const { subject, until, assumptions } = input;
    const key = subject.kind === 'installation' ? INSTALLATION_KEY : subject.challengeId;
    const label = subject.kind === 'installation' ? 'installation' : subject.challengeId;
    const world = worldOf(input.evidence);
    const controlled = controlledEndpoints(world, assumptions.outcomes ?? {}, clock);
    const strategy = createMockStrategy(controlled.client, memory.stores);
    const pending = [...(assumptions.snapshots ?? [])];
    // A closed challenge has post-close work only if it ran under the scenario while it was joined: the run starts it at the
    // scenario's start phase (stated in the diagnostics).
    if (subject.kind === 'completed') {
        memory.stores.scenarioLedger.set(key, initialState(input.scenario.name, input.scenario.start, input.start));
    }
    const events: SimulationEvent[] = [];
    const passInstants: number[] = [];
    const finish = async (stopReason: SimulationStopReason, at: number, preview: number | null) => {
        const state = memory.stores.scenarioLedger.get(key).state;
        if (preview !== null)
            events.push({ type: 'preview', at: preview, subject: label, reason: 'next-wake', applied: false });
        return {
            events,
            assumptions,
            diagnostics: diagnosticsOf(input, timezone),
            deadlines: deadlinesOf(state),
            finalState: state,
            stopReason,
            stoppedAt: at,
            passes: passInstants,
            needs: null,
            halted: haltOf(key),
        } satisfies SimulationResult;
    };

    let at = input.start;
    let passes = 0;
    let atThisInstant = 0;
    for (;;) {
        if (passes >= MAX_PASSES || events.length >= MAX_EVENTS) return finish('limit', at, null);
        passes += 1;
        passInstants.push(at);
        clock.set(at);
        for (let due = pending[0]; due && due.at <= at; due = pending[0]) {
            pending.shift();
            applyFacts(world, due.facts, subject);
        }

        // What a pass that needed an unassumed outcome is undone to.
        const savedLedger = memory.raw.readRaw();
        const savedWorld = cloneWorld(world);
        const before = memory.stores.scenarioLedger.get(key).state;
        const logged = controlled.operations.length;

        const result = await strategy.fetchChallengesAndVote(SIMULATION_TOKEN, null, 'full');
        const need = controlled.need();
        if (need) {
            memory.raw.writeRaw(savedLedger ?? '{}');
            Object.assign(world, savedWorld);
            controlled.operations.length = logged;
            const stopped = await finish('needsEvidence', at, null);
            return { ...stopped, finalState: before, needs: need };
        }
        if (!result.success)
            return { ...(await finish('halted', at, null)), halted: result.error ?? 'the cycle failed' };

        const after = memory.stores.scenarioLedger.get(key).state;
        const made = controlled.operations
            .slice(logged)
            .map((operation) => ({ type: 'operation' as const, ...operation, applied: true as const }));
        events.push(...made, ...traceStateChange(before, after, at, label));
        const halted = haltOf(key);
        if (halted !== null) return finish('halted', at, null);

        // Work was done at this instant: another pass at it (a catch-up lands one photo per pass), up to a bound.
        atThisInstant = made.length > 0 ? atThisInstant + 1 : 0;
        if (made.length > 0 && atThisInstant < MAX_PASSES_PER_INSTANT) continue;

        const wake = await subjectWake(input, after, world, timezone, at);
        const next = advanceTo(at, [wake, pending[0]?.at ?? null], until);
        if ('at' in next) {
            at = next.at;
            atThisInstant = 0;
            continue;
        }
        return next.stop === 'horizon' ? finish('horizon', until, next.next) : finish('idle', at, null);
    }
};

/**
 * Runs the simulation. Resolves `simulation-busy` while another one runs, and an isolation breach as a halted run with no
 * result (nothing it computed is kept). Never touches the real stores or the transport: while it runs, every real write and
 * every request refuses (simulationScope.ts).
 */
const runSimulation = async (
    input: SimulationInput,
): Promise<{ ok: true; result: SimulationResult } | { ok: false; error: 'simulation-busy' }> => {
    const timezone = captureInstallationTimezone();
    if (timezone === null) return { ok: true, result: haltedResult(input, 'timezone-unavailable') };
    const clock = createVirtualClock(input.start);
    const memory = memoryStores();
    const scope = {
        nowMs: clock.nowMs,
        ledger: memory.stores.scenarioLedger,
        patchSettings: simulatedSettings(input.scenario, input.source, input.subject),
        breach: null,
        halts: [],
    };
    try {
        const run = await runInSimulationScope(scope, () => drive(input, clock, memory, timezone));
        if (run.ok) return { ok: true, result: run.value };
        if (run.error === 'simulation-busy') return { ok: false, error: 'simulation-busy' };
        logger.withCategory('scenario').error(`simulation stopped: ${run.breach.message}`, null);
        return { ok: true, result: haltedResult(input, ISOLATION_BREACHED) };
    } catch (error) {
        logger.withCategory('scenario').error(`simulation failed: ${errorMessage(error) || error}`, null);
        throw error;
    }
};

export { SIMULATION_TOKEN, applyFacts, controlledEndpoints, runSimulation, simulatedSettings, worldOf };
export type { SimulationEvidence, SimulationInput };
