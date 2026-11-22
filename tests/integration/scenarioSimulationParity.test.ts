/**
 * Honest simulation and runtime parity: the simulation coordinator (services/scenarioRunner/simulation.ts) runs the SAME
 * lifecycle, voting pass and normal automation as the live mock composition, over memory stores, controlled evidence, assumed
 * outcomes and a virtual clock. For identical evidence and outcomes the two give the same trace: the operations made on the
 * controlled endpoints (subject, kind, virtual time, outcome), the rule events, and the final progress record.
 *
 * The live side is the REAL mock strategy over the REAL settings, ledger and runner, driven pass by pass at the instants the
 * simulation passed through, with the system clock set to each (what a live cycle at that time would read).
 */

const mockLogs: Array<{ level: string; msg: string }> = [];

jest.mock('../../src/ts/core/logger', () => {
    const category = new Proxy(
        {},
        {
            get:
                (_target, level: string) =>
                (msg: unknown, ...rest: unknown[]) => {
                    mockLogs.push({ level, msg: String(msg) + (typeof rest[0] === 'string' ? ` ${rest[0]}` : '') });
                },
        },
    );
    const named = {
        __esModule: true,
        withCategory: () => category,
        challengeTag: (challenge: { id?: unknown; title?: unknown } | null | undefined) =>
            `[Challenge ${challenge?.id}: ${challenge?.title}]`,
    };
    return new Proxy(named, { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => {}) });
});

import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import { buildChallenge } from '../helpers/challengeFixtures';
import { invalid } from '../helpers/invalid';
import settings = require('../../src/ts/core/settings');
import type * as simulationModule from '../../src/ts/core/services/scenarioRunner/simulation';
import type * as mockStrategyModule from '../../src/ts/core/mock/strategy';
import type * as scenarioStateStoreModule from '../../src/ts/core/scenarioStateStore';
import type * as simulateModule from '../../src/ts/core/scenarios/simulate';
import type * as newEntryTrackerModule from '../../src/ts/core/services/newEntryTracker';
import type * as currencyAutoStoreModule from '../../src/ts/core/currencyAutoStore';
import type * as entryAgeStoreModule from '../../src/ts/core/entryAgeStore';
import type * as autoClaimModule from '../../src/ts/core/services/autoClaim';
import type * as portModule from '../../src/ts/core/platform/port';
import type * as swapBackStoreModule from '../../src/ts/core/swapBackStore';
import type { ScenarioState } from '../../src/ts/core/types/stores';
import type { Bankroll, Challenge, CompletedChallenge, LibraryPhoto } from '../../src/ts/core/types/gurushots';
import type {
    ScenarioExpr,
    SimulationAssumptions,
    SimulationEvent,
    SimulationSubject,
} from '../../src/ts/core/types/scenario';

const { runSimulation, controlledEndpoints, worldOf, applyFacts } =
    require('../../src/ts/core/services/scenarioRunner/simulation') as typeof simulationModule;
const { createMockStrategy } = require('../../src/ts/core/mock/strategy') as typeof mockStrategyModule;
const { mockScenarioStateLedger, INSTALLATION_KEY, initialState } =
    require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule;
const { traceStateChange } = require('../../src/ts/core/scenarios/simulate') as typeof simulateModule;
const { createMemoryEntryTracker } =
    require('../../src/ts/core/services/newEntryTracker') as typeof newEntryTrackerModule;
const { createMemoryAutoSpendLedger } =
    require('../../src/ts/core/currencyAutoStore') as typeof currencyAutoStoreModule;
const { createMemoryEntryAgeLedger } = require('../../src/ts/core/entryAgeStore') as typeof entryAgeStoreModule;
const { platform } = require('../../src/ts/core/platform/port') as typeof portModule;
const { resetClaimThrottle } = require('../../src/ts/core/services/autoClaim') as typeof autoClaimModule;
const { createMemoryLedger } = require('../../src/ts/core/swapBackStore') as typeof swapBackStoreModule;

const ID = 94;
const END = 1_800_000_000;
const HOUR = 3600;
const BANKROLL: Bankroll = { keys: 3, swaps: 3, fills: 3, coins: 100 };

const clock = { now: 0 };

const hours = (value: number) => invalid<ScenarioExpr>({ kind: 'literal', value, quantity: 'duration', unit: 'hours' });
const endFact = () => invalid<ScenarioExpr>({ kind: 'fact', name: 'challenge.end' });
const freeExpiry = () => invalid<ScenarioExpr>({ kind: 'fact', name: 'boost.freeExpiry' });
const before = (from: ScenarioExpr, by: ScenarioExpr) =>
    invalid<ScenarioExpr>({ kind: 'offset', from, by, direction: 'before' });
const earlier = (...of: ScenarioExpr[]) => invalid<ScenarioExpr>({ kind: 'earlier', of });
const issue94Rows = () => [
    { count: 2, at: earlier(before(endFact(), hours(10)), before(freeExpiry(), hours(1))) },
    { count: 3, at: before(endFact(), hours(9)) },
    { count: 4, at: before(endFact(), hours(8)) },
];

const submitOnlyPlan = (name = 'Plan') => ({
    name,
    version: 1,
    start: 'push',
    // Settings and schedules only: not one rule, so only the normal Auto-Submit can submit.
    phases: { push: { schedules: { submit: { alignment: 'end', rows: issue94Rows() } } } },
});

const photos = (): LibraryPhoto[] =>
    ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id, index) => ({
        id,
        labels: ['Pink'],
        upload_date: 9000 + index,
        permission: { allowed: true, message: null },
    }));

const activeChallenge = (entries: number, max = 4): Challenge =>
    buildChallenge({
        id: ID,
        title: 'Issue 94',
        type: 'regular',
        start_time: END - 10 * 24 * HOUR,
        close_time: END,
        max_photo_submits: max,
        member: {
            boost: { state: 'AVAILABLE_KEY' },
            turbo: { state: 'NONE' },
            ranking: {
                entries: Array.from({ length: entries }, (_unused, index) => ({
                    id: `e${index + 1}`,
                    member_id: 'm',
                    votes: 10,
                })),
                exposure: { exposure_factor: 100 },
                swaps: [],
            },
        },
    });

type Fixture = {
    doc: unknown;
    subject: SimulationSubject;
    evidence: Parameters<typeof runSimulation>[0]['evidence'];
    start: number;
    until: number;
    assumptions: SimulationAssumptions;
};

const keyOf = (subject: SimulationSubject) =>
    subject.kind === 'installation' ? INSTALLATION_KEY : subject.challengeId;

/** The live mock composition, replayed at the instants the simulation passed through. */
const replayLive = async (fixture: Fixture, passes: number[]) => {
    const key = keyOf(fixture.subject);
    const world = worldOf(fixture.evidence);
    const now = { sec: passes[0] ?? fixture.start };
    const controlled = controlledEndpoints(world, fixture.assumptions.outcomes ?? {}, { nowSec: () => now.sec });
    const strategy = createMockStrategy(controlled.client, {
        entryTracker: createMemoryEntryTracker(),
        autoSpendLedger: createMemoryAutoSpendLedger(),
        swapLedger: createMemoryLedger(),
        entryAges: createMemoryEntryAgeLedger(),
        scenarioLedger: mockScenarioStateLedger,
        interChallengeDelayMs: 0,
    });
    const pending = [...(fixture.assumptions.snapshots ?? [])];
    const rules: SimulationEvent[] = [];
    if (fixture.subject.kind === 'completed') {
        mockScenarioStateLedger.set(
            key,
            initialState('Plan', settings.getScenario('Plan')?.start ?? '', fixture.start),
        );
    }
    for (const at of passes) {
        now.sec = at;
        clock.now = at;
        while (pending.length > 0 && pending[0].at <= at) applyFacts(world, pending.shift()!.facts, fixture.subject);
        const beforeState = mockScenarioStateLedger.get(key).state;
        const result = await strategy.fetchChallengesAndVote('tok', null, 'full');
        expect(result.success).toBe(true);
        rules.push(
            ...traceStateChange(
                beforeState,
                mockScenarioStateLedger.get(key).state,
                at,
                fixture.subject.kind === 'installation' ? 'installation' : String(key),
            ).filter((event) => event.type === 'rule'),
        );
    }
    return {
        operations: controlled.operations.map((operation) => ({ type: 'operation', ...operation, applied: true })),
        rules,
        finalState: mockScenarioStateLedger.get(key).state,
    };
};

const input = (fixture: Fixture, scenario: ReturnType<typeof settings.getScenario>, source: 'draft' | 'stored') => ({
    scenario: scenario as NonNullable<typeof scenario>,
    source,
    subject: fixture.subject,
    evidence: fixture.evidence,
    start: fixture.start,
    until: fixture.until,
    assumptions: fixture.assumptions,
});

/** The simulation of a stored scenario, and the live composition's trace under the same evidence and outcomes. */
const bothTraces = async (fixture: Fixture) => {
    expect(settings.saveScenario(fixture.doc)).toMatchObject({ ok: true });
    const subject = fixture.subject;
    if (subject.kind !== 'installation') settings.setChallengeOverride('scenario', subject.challengeId, 'Plan');
    else settings.setInstallationScenario('Plan', platform().capabilities.executor, 0);
    const run = await runSimulation(input(fixture, settings.getScenario('Plan'), 'stored'));
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('busy');
    await mockScenarioStateLedger.removeAll();
    const live = await replayLive(fixture, run.result.passes);
    return { simulated: run.result, live };
};

/** A record as the two runs compare it: the resets the test's own `removeAll` counted, and the installation's assignment generation, are not progress. */
const progressOf = (state: ScenarioState | null) =>
    state && {
        ...state,
        epoch: undefined,
        generation: undefined,
        // A notice's id carries a random token that only keeps ids of the same second apart.
        outbox: state.outbox?.map((notice) => ({ ...notice, id: `${notice.at}` })),
        ...(state.published ? { published: { ...state.published, generation: undefined } } : {}),
    };

const expectParity = ({ simulated, live }: Awaited<ReturnType<typeof bothTraces>>) => {
    expect(simulated.events.filter((event) => event.type === 'operation')).toEqual(live.operations);
    expect(simulated.events.filter((event) => event.type === 'rule')).toEqual(live.rules);
    expect(progressOf(simulated.finalState)).toEqual(progressOf(live.finalState));
};

const submits = (events: SimulationEvent[]) =>
    events.flatMap((event) =>
        event.type === 'operation' && event.operation === 'submitToChallenge' ? [event.at] : [],
    );

const activeFixture = (overrides: Partial<Fixture> = {}, entries = 1): Fixture => ({
    doc: submitOnlyPlan(),
    subject: { kind: 'active', challengeId: String(ID) },
    evidence: { provenance: 'active-list', challenge: activeChallenge(entries), bankroll: BANKROLL },
    start: END - 48 * HOUR,
    until: END,
    assumptions: {
        outcomes: { submit: 'success' },
        snapshots: [{ at: END - 48 * HOUR, facts: { library: photos() } }],
    },
    ...overrides,
});

beforeEach(async () => {
    mockLogs.length = 0;
    installHeadlessStore();
    jest.spyOn(Date, 'now').mockImplementation(() => clock.now * 1000);
    clock.now = END - 48 * HOUR;
    await mockScenarioStateLedger.removeAll();
    resetClaimThrottle();
    settings.setSetting('mock', true);
    settings.setGlobalDefault('autoSubmit', true);
    settings.setGlobalDefault('emergencySubmit', 0);
    settings.rememberChallengeTitles([{ id: ID, title: 'Issue 94', type: 'regular' }]);
});

afterEach(() => {
    jest.restoreAllMocks();
    removeHeadlessStore();
    settings.rememberChallengeTitles([]);
});

const START = END - 48 * HOUR;
const ROW_2 = 1799964000;
const ROW_3 = 1799967600;
const ROW_4 = 1799971200;
const withLibrary = (extra: SimulationAssumptions['snapshots'] = []) => [
    { at: START, facts: { library: photos() } },
    ...extra,
];

describe('issue 94: a phase of settings and schedules only', () => {
    test('submits through normal Auto-Submit at each virtual deadline, and matches the live composition', async () => {
        const both = await bothTraces(activeFixture());
        // Row 2 is end - 10h, row 3 end - 9h, row 4 end - 8h: one photo each, by the normal automation (no rule exists).
        expect(submits(both.simulated.events)).toEqual([ROW_2, ROW_3, ROW_4]);
        expect(both.simulated.stopReason).toBe('idle');
        expect(both.simulated.events.some((event) => event.type === 'rule')).toBe(false);
        expectParity(both);
    });

    test('a late start catches up one photo per pass at the same instant, like live', async () => {
        const late = ROW_4 + 60;
        const both = await bothTraces(
            activeFixture({
                start: late,
                assumptions: {
                    outcomes: { submit: 'success' },
                    snapshots: [{ at: late, facts: { library: photos() } }],
                },
            }),
        );
        expect(submits(both.simulated.events)).toEqual([late, late, late]);
        expectParity(both);
    });

    test('an entry added from outside before the pass stands the fill down for its row, and matches live', async () => {
        const both = await bothTraces(
            activeFixture({
                assumptions: {
                    outcomes: { submit: 'success' },
                    snapshots: withLibrary([{ at: ROW_2, facts: { challenge: activeChallenge(2) } }]),
                },
            }),
        );
        // Row 2 is already satisfied by the outside entry: nothing is submitted for it.
        expect(submits(both.simulated.events)).toEqual([ROW_3, ROW_4]);
        expectParity(both);
    });

    test.each(['refused', 'unclear'] as const)(
        'a %s submit is recorded as that outcome, and matches live',
        async (outcome) => {
            const both = await bothTraces(
                activeFixture({ assumptions: { outcomes: { submit: outcome }, snapshots: withLibrary() } }),
            );
            expect(both.simulated.events.filter((event) => event.type === 'operation').length).toBeGreaterThan(0);
            expect(
                both.simulated.events.every((event) => event.type !== 'operation' || event.outcome === outcome),
            ).toBe(true);
            expectParity(both);
        },
    );

    test('a queue phase (a named photo pool) submits from the pool in order, and matches live', async () => {
        expect(settings.setPhotoPool('Wall', ['p4', 'p5', 'p6'])).toBe('ok');
        const doc = submitOnlyPlan();
        const both = await bothTraces(
            activeFixture({
                doc: { ...doc, phases: { push: { ...doc.phases.push, photoPool: { name: 'Wall' } } } },
            }),
        );
        expect(submits(both.simulated.events)).toEqual([ROW_2, ROW_3, ROW_4]);
        expect([...(both.simulated.finalState?.poolProgress?.push?.consumed ?? [])].sort()).toEqual(['p4', 'p5', 'p6']);
        expectParity(both);
    });
});

const installationPlan = (rules: unknown[] = []) => ({
    name: 'Plan',
    version: 1,
    scope: 'installation',
    start: 'main',
    phases: {
        main: {
            settings: { autoClaimPrizes: true },
            rules: [
                {
                    id: 'later',
                    if: [{ type: 'inPhaseFor', min: '6h' }],
                    do: [
                        { type: 'notify', message: 'six hours in' },
                        { type: 'goto', phase: 'next' },
                    ],
                },
                ...rules,
            ],
        },
        next: {},
    },
});

const installationFixture = (overrides: Partial<Fixture> = {}): Fixture => ({
    doc: installationPlan(),
    subject: { kind: 'installation' },
    evidence: { provenance: 'installation', bankroll: BANKROLL },
    start: START,
    until: START + 24 * HOUR,
    assumptions: {},
    ...overrides,
});

describe('the installation: no challenge', () => {
    test('its policy is published and its account rule runs at its virtual boundary, and matches live', async () => {
        const both = await bothTraces(installationFixture());
        const { events } = both.simulated;
        expect(events.map((event) => event.type)).toEqual(['published', 'rule', 'phase', 'notice']);
        expect(events.find((event) => event.type === 'rule')).toMatchObject({ at: START + 6 * HOUR, ruleId: 'later' });
        expect(both.simulated.stopReason).toBe('idle');
        expectParity(both);
    });

    test('an account rule that claims a mission finds the missions unknown: nothing is claimed or assumed, like live', async () => {
        const both = await bothTraces(
            installationFixture({
                doc: installationPlan([{ id: 'mission', do: [{ type: 'claimMissionReward', missionId: 'm1' }] }]),
                assumptions: { outcomes: { claim: 'success' } },
            }),
        );
        expect(both.simulated.events.some((event) => event.type === 'operation')).toBe(false);
        expect(both.simulated.needs).toBeNull();
        expectParity(both);
    });
});

const candidate = (): Challenge =>
    buildChallenge({
        id: 77,
        title: 'Open Call',
        type: 'regular',
        start_time: START - HOUR,
        close_time: START + 10 * HOUR,
        max_photo_submits: 4,
        member: { submit_state: 'join' },
    });

const admissionPlan = () => ({
    name: 'Plan',
    version: 1,
    start: 'go',
    phases: {
        go: {
            schedules: {
                submit: {
                    alignment: 'absolute',
                    rows: [
                        {
                            count: 1,
                            at: invalid<ScenarioExpr>({ kind: 'literal', value: START + HOUR, quantity: 'instant' }),
                        },
                    ],
                },
            },
        },
    },
});

describe('a candidate that is not joined yet', () => {
    test('is admitted when its first row is due, through the join pass, and matches live', async () => {
        const both = await bothTraces({
            doc: admissionPlan(),
            subject: { kind: 'candidate', challengeId: '77' },
            evidence: { provenance: 'open-list', challenge: candidate(), bankroll: BANKROLL },
            start: START,
            until: START + 3 * HOUR,
            assumptions: { outcomes: { submit: 'success' }, snapshots: withLibrary() },
        });
        expect(submits(both.simulated.events)).toEqual([START + HOUR]);
        expectParity(both);
    });
});

const completed = () =>
    invalid<CompletedChallenge>({
        id: 55,
        title: 'Done',
        member: {
            rewards_by_section: {
                claim_state: 'CLAIM',
                sections: [{ type: 'TOTAL', name: 'Total', resources: [{ type: 'COINS', title: 'Coins', value: 60 }] }],
            },
        },
    });

const closedPlan = () => ({
    name: 'Plan',
    version: 1,
    start: 'main',
    phases: { main: { rules: [{ id: 'claim', stages: ['postClose'], do: [{ type: 'claimChallengeReward' }] }] } },
});

describe('a completed challenge', () => {
    const fixture = (outcome: 'success' | 'refused' | 'unclear'): Fixture => ({
        doc: closedPlan(),
        subject: { kind: 'completed', challengeId: '55' },
        evidence: { provenance: 'completed-list', challenge: completed(), bankroll: BANKROLL },
        start: START,
        until: START + 2 * HOUR,
        assumptions: { outcomes: { claim: outcome } },
    });

    test.each(['success', 'refused', 'unclear'] as const)(
        'claims its reward by its post-close rule: %s, and matches live',
        async (outcome) => {
            const both = await bothTraces(fixture(outcome));
            expect(both.simulated.events.find((event) => event.type === 'operation')).toMatchObject({
                operation: 'claimChallengeResources',
                subject: '55',
                outcome,
            });
            expect(both.simulated.diagnostics).toContainEqual(expect.objectContaining({ key: 'progress' }));
            expectParity(both);
        },
    );
});

/** The simulation alone, over a scenario that is not saved or assigned anywhere. */
const simulateDraft = async (fixture: Fixture) => {
    const checked = settings.checkScenario(fixture.doc);
    if (!checked.ok) throw new Error('invalid draft');
    const run = await runSimulation(input(fixture, checked.scenario, 'draft'));
    if (!run.ok) throw new Error(run.error);
    return run.result;
};

describe('honesty', () => {
    test('without an assumed outcome the run stops as needsEvidence, names it, and undoes the pass that needed it', async () => {
        const simulationWithoutOutcome = await simulateDraft(
            activeFixture({ assumptions: { snapshots: withLibrary() } }),
        );
        expect(simulationWithoutOutcome.stopReason).toBe('needsEvidence');
        expect(simulationWithoutOutcome.needs).toEqual({ operation: 'submit', subject: String(ID), at: ROW_2 });
        // Nothing the pass did is kept: no operation, and the record is as it was before that pass.
        expect(simulationWithoutOutcome.events.some((event) => event.type === 'operation')).toBe(false);
        expect(simulationWithoutOutcome.finalState?.lastAction).toBeNull();
        expect(simulationWithoutOutcome.finalState?.fired).toEqual({});
    });

    test('nothing real is written: no store write, no change to the saved settings or scenarios', async () => {
        const store = installHeadlessStore();
        settings.setSetting('mock', true);
        settings.setGlobalDefault('autoSubmit', true);
        settings.setGlobalDefault('emergencySubmit', 0);
        const saved = { ...Object.fromEntries(store.keys), config: store.value };
        const spies = [
            jest.spyOn(store, 'write'),
            jest.spyOn(store, 'writeKey'),
            jest.spyOn(store, 'compareAndWriteKey'),
        ];
        // (The settings above were written through the same store: only what the simulation writes is counted.)
        for (const spy of spies) spy.mockClear();
        const result = await simulateDraft(activeFixture());
        const realStorageWritesDuringSimulation = spies.flatMap((spy) => spy.mock.calls.map((call): unknown[] => call));
        expect(result.events.filter((event) => event.type === 'operation')).toHaveLength(3);
        expect(realStorageWritesDuringSimulation).toHaveLength(0);
        expect({ ...Object.fromEntries(store.keys), config: store.value }).toEqual(saved);
        // The unsaved scenario was never stored, and no assignment was made.
        expect(settings.getScenario('Plan')).toBeNull();
        expect(settings.getChallengeOverride('scenario', String(ID))).toBeNull();
        expect(mockScenarioStateLedger.get(ID).state).toBeNull();
    });

    test('no timer is scheduled but the isolation sentinel, and the scope is closed afterwards', async () => {
        const timers = jest.spyOn(globalThis, 'setTimeout');
        await simulateDraft(activeFixture());
        expect(timers.mock.calls.map((call) => call[1])).toEqual([0]);
        // Outside the scope the settings and the clock are the real ones again.
        expect(settings.getScenario('Plan')).toBeNull();
    });

    test('unknown future data stays unknown: votes, ranks and rewards are never invented', async () => {
        const result = await simulateDraft(activeFixture());
        const sampled = Object.keys(result.finalState?.history ?? {});
        // Only the photo the evidence showed has a vote sample; the photos the run submitted have no votes to sample.
        expect(sampled).toEqual(['e1']);
        expect(result.events.some((event) => event.type === 'operation' && event.operation === 'submitVotes')).toBe(
            false,
        );
        expect(result.needs).toBeNull();
    });

    test('a challenge close time is never rewritten to search beyond it', async () => {
        const fixture = activeFixture({ until: END + 100 * HOUR });
        const result = await simulateDraft(fixture);
        expect(result.passes.every((at) => at <= END)).toBe(true);
        expect(result.stopReason).toBe('idle');
        const evidence = fixture.evidence;
        expect(evidence.provenance === 'active-list' && evidence.challenge.close_time).toBe(END);
    });

    test('a run is deterministic: the same request twice gives the same result', async () => {
        const first = await simulateDraft(activeFixture());
        const second = await simulateDraft(activeFixture());
        expect(progressOf(second.finalState)).toEqual(progressOf(first.finalState));
        expect(second.events).toEqual(first.events);
    });

    test('a draft is simulated without being saved, and matches the live run of the same scenario once saved', async () => {
        const fixture = activeFixture();
        const drafted = await simulateDraft(fixture);
        const both = await bothTraces(fixture);
        expect(drafted.events.filter((event) => event.type === 'operation')).toEqual(both.live.operations);
    });

    test('a handoff changes the saved assignment, which a simulation never does: the step fails and the rule stays', async () => {
        const doc = {
            name: 'Plan',
            version: 1,
            start: 'main',
            phases: { main: { rules: [{ id: 'pass-on', do: [{ type: 'handoffScenario', to: null }] }] } },
        };
        const result = await simulateDraft(activeFixture({ doc, until: START + HOUR }));
        expect(result.halted).toBeNull();
        expect(result.finalState?.lastError?.message).toMatch(/handoff.*simulation does not do/);
        expect(result.finalState?.handoff).toBeUndefined();
    });
});

describe('previews are prospective, and never applied', () => {
    test('a candidate not yet admitted at the horizon shows where the run would look next', async () => {
        const result = await simulateDraft({
            doc: admissionPlan(),
            subject: { kind: 'candidate', challengeId: '77' },
            evidence: { provenance: 'open-list', challenge: candidate(), bankroll: BANKROLL },
            start: START,
            until: START + HOUR / 2,
            assumptions: { outcomes: { submit: 'success' }, snapshots: withLibrary() },
        });
        expect(result.stopReason).toBe('horizon');
        expect(result.stoppedAt).toBe(START + HOUR / 2);
        expect(result.events.filter((event) => event.type === 'operation')).toEqual([]);
        expect(result.events.at(-1)).toEqual({
            type: 'preview',
            at: START + HOUR,
            subject: '77',
            reason: 'next-wake',
            applied: false,
        });
    });

    test('a completed challenge whose rule is not yet due is previewed the same way', async () => {
        const doc = {
            name: 'Plan',
            version: 1,
            start: 'main',
            phases: {
                main: {
                    rules: [
                        {
                            id: 'claim',
                            stages: ['postClose'],
                            if: [{ type: 'inPhaseFor', min: '3h' }],
                            do: [{ type: 'claimChallengeReward' }],
                        },
                    ],
                },
            },
        };
        const result = await simulateDraft({
            doc,
            subject: { kind: 'completed', challengeId: '55' },
            evidence: { provenance: 'completed-list', challenge: completed(), bankroll: BANKROLL },
            start: START,
            until: START + HOUR,
            assumptions: { outcomes: { claim: 'success' } },
        });
        expect(result.stopReason).toBe('horizon');
        expect(result.events.at(-1)).toMatchObject({ type: 'preview', at: START + 3 * HOUR, applied: false });
    });
});
