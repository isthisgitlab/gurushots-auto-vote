/**
 * The pure part of a simulation (scenarios/simulate.ts): the one request and its assumptions, validated and bounded; the
 * virtual clock; the advance from one instant to the next; the trace of what a pass changed; the resolved deadlines. It runs no
 * rule and reads no clock — the lifecycle itself is exercised against the live composition in
 * tests/integration/scenarioSimulationParity.test.ts.
 */

import { invalid } from '../helpers/invalid';
import type * as simulateModule from '../../src/ts/core/scenarios/simulate';
import type * as vocabularyModule from '../../src/ts/core/scenarios/vocabulary';
import type { ScenarioPublication, ScenarioState } from '../../src/ts/core/types/stores';

const {
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
} = require('../../src/ts/core/scenarios/simulate') as typeof simulateModule;
const { SCENARIO_CAPS } = require('../../src/ts/core/scenarios/vocabulary') as typeof vocabularyModule;

const UNTIL = 1_800_000_000;
const valid = (patch: Record<string, unknown> = {}) => ({
    scenario: { name: 'Plan' },
    subject: { kind: 'active', challengeId: 7 },
    until: UNTIL,
    ...patch,
});
const bankroll = { keys: 1, swaps: 2, fills: 3, coins: 4 };

describe('the request', () => {
    test('a stored scenario by name, on a challenge, until an instant: the id becomes text, assumptions default to none', () => {
        expect(parseSimulationRequest(valid({ scenario: { name: '  Plan ' } }))).toEqual({
            ok: true,
            request: {
                scenario: { name: 'Plan' },
                subject: { kind: 'active', challengeId: '7' },
                until: UNTIL,
                assumptions: {},
            },
        });
    });

    test('an unsaved draft is carried as it is, for the scenario validator to check', () => {
        const draft = { name: 'Draft', phases: {} };
        expect(parseSimulationRequest(valid({ scenario: { draft } }))).toMatchObject({
            ok: true,
            request: { scenario: { draft } },
        });
    });

    test('the installation has no challenge: one named is refused, never ignored', () => {
        expect(parseSimulationRequest(valid({ subject: { kind: 'installation' } }))).toMatchObject({
            ok: true,
            request: { subject: { kind: 'installation' } },
        });
        expect(parseSimulationRequest(valid({ subject: { kind: 'installation', challengeId: '7' } }))).toEqual({
            ok: false,
            error: 'installation-takes-no-challenge',
        });
    });

    test.each(['candidate', 'active', 'completed'])('a %s subject needs a valid challenge id', (kind) => {
        expect(parseSimulationRequest(valid({ subject: { kind, challengeId: 'c-1' } }))).toMatchObject({
            ok: true,
            request: { subject: { kind, challengeId: 'c-1' } },
        });
        expect(parseSimulationRequest(valid({ subject: { kind } }))).toEqual({
            ok: false,
            error: 'challenge-required',
        });
        expect(parseSimulationRequest(valid({ subject: { kind, challengeId: '' } }))).toEqual({
            ok: false,
            error: 'challenge-required',
        });
        expect(parseSimulationRequest(valid({ subject: { kind, challengeId: 5, extra: 1 } }))).toEqual({
            ok: false,
            error: 'invalid-subject',
        });
    });

    test.each([
        [null, 'invalid-request'],
        ['text', 'invalid-request'],
        [[], 'invalid-request'],
        [valid({ extra: true }), 'invalid-request'],
        [valid({ scenario: null }), 'invalid-scenario'],
        [valid({ scenario: {} }), 'invalid-scenario'],
        [valid({ scenario: { name: '  ' } }), 'invalid-scenario'],
        [valid({ scenario: { name: 'a', draft: {} } }), 'invalid-scenario'],
        [valid({ scenario: { draft: 'text' } }), 'invalid-scenario'],
        [valid({ subject: null }), 'invalid-subject'],
        [valid({ subject: { kind: 'sleeping' } }), 'invalid-subject'],
        [valid({ until: undefined }), 'invalid-until'],
        [valid({ until: 1.5 }), 'invalid-until'],
        [valid({ until: -1 }), 'invalid-until'],
        [valid({ until: '2026-12-01' }), 'invalid-until'],
    ])('refuses %p as %s', (input, error) => {
        expect(parseSimulationRequest(input)).toEqual({ ok: false, error });
    });
});

describe('the assumptions: bounded, and nothing else', () => {
    test('outcomes per kind of operation, and timed snapshots of the challenge, the bankroll and the library, in time order', () => {
        const parsed = parseAssumptions({
            outcomes: { submit: 'success', join: 'refused', claim: 'unclear' },
            snapshots: [
                { at: 200, facts: { bankroll } },
                { at: 100, facts: { challenge: { id: 7, title: 'x' }, library: [{ id: 'p1' }] } },
            ],
        });
        expect(parsed).toEqual({
            ok: true,
            value: {
                outcomes: { submit: 'success', join: 'refused', claim: 'unclear' },
                snapshots: [
                    { at: 100, facts: { challenge: { id: 7, title: 'x' }, library: [{ id: 'p1' }] } },
                    { at: 200, facts: { bankroll } },
                ],
            },
        });
    });

    test('none given is none assumed', () => {
        expect(parseAssumptions(undefined)).toEqual({ ok: true, value: {} });
        expect(parseAssumptions({})).toEqual({ ok: true, value: {} });
    });

    test.each([
        ['text'],
        [[]],
        [{ other: 1 }],
        [{ outcomes: 'success' }],
        [{ outcomes: { fly: 'success' } }],
        [{ outcomes: { submit: 'maybe' } }],
        [{ snapshots: 'now' }],
        [{ snapshots: [null] }],
        [{ snapshots: [{ at: 1, facts: {}, extra: 1 }] }],
        [{ snapshots: [{ at: 1.5, facts: {} }] }],
        [{ snapshots: [{ at: -1, facts: {} }] }],
        [{ snapshots: [{ at: 1 }] }],
        [{ snapshots: [{ at: 1, facts: { votes: 3 } }] }],
        [{ snapshots: [{ at: 1, facts: { challenge: { title: 'no id' } } }] }],
        [{ snapshots: [{ at: 1, facts: { bankroll: { keys: 1 } } }] }],
        [{ snapshots: [{ at: 1, facts: { bankroll: { ...bankroll, keys: -1 } } }] }],
        [{ snapshots: [{ at: 1, facts: { library: 'p1' } }] }],
        [{ snapshots: [{ at: 1, facts: { library: [{ id: 5 }] } }] }],
    ])('refuses %p', (assumptions) => {
        expect(parseAssumptions(invalid(assumptions))).toEqual({ ok: false, error: 'invalid-assumptions' });
    });

    test('at most MAX_SNAPSHOTS snapshots, and no more than an imported scenario in size', () => {
        const snapshot = { at: 1, facts: {} };
        expect(parseAssumptions({ snapshots: Array.from({ length: MAX_SNAPSHOTS }, () => snapshot) }).ok).toBe(true);
        expect(parseAssumptions({ snapshots: Array.from({ length: MAX_SNAPSHOTS + 1 }, () => snapshot) })).toEqual({
            ok: false,
            error: 'invalid-assumptions',
        });
        const heavy = { at: 1, facts: { library: [{ id: 'p', labels: ['x'.repeat(SCENARIO_CAPS.importBytes)] }] } };
        expect(parseAssumptions({ snapshots: [heavy] })).toEqual({ ok: false, error: 'assumptions-too-large' });
    });

    test('the caps are what the run is held to', () => {
        expect([MAX_EVENTS, MAX_PASSES, MAX_PASSES_PER_INSTANT]).toEqual([200, 200, 6]);
    });
});

describe('the virtual clock', () => {
    test('moves only when the run sets it', () => {
        const clock = createVirtualClock(1000);
        expect([clock.nowSec(), clock.nowMs()]).toEqual([1000, 1_000_000]);
        clock.set(1500);
        expect([clock.nowSec(), clock.nowMs()]).toEqual([1500, 1_500_000]);
    });
});

describe('advancing to the next instant', () => {
    test('goes to the earliest boundary after now, unknown ones supplying none', () => {
        expect(advanceTo(100, [null, 300, 200, null], 1000)).toEqual({ at: 200 });
    });

    test('a boundary that is not after now is no boundary: no zero-delay loop', () => {
        expect(advanceTo(100, [100, 50, 100.5], 1000)).toEqual({ at: 100.5 });
        expect(advanceTo(100, [100, 50, NaN, Infinity, null], 1000)).toEqual({ stop: 'idle' });
    });

    test('idle when nothing is left; the horizon, with the next boundary, when it lies past until', () => {
        expect(advanceTo(100, [], 1000)).toEqual({ stop: 'idle' });
        expect(advanceTo(100, [1001, 2000], 1000)).toEqual({ stop: 'horizon', next: 1001 });
        expect(advanceTo(100, [1000], 1000)).toEqual({ at: 1000 });
    });
});

const state = (patch: Partial<ScenarioState> = {}): ScenarioState => ({
    scenario: 'Plan',
    phase: 'a',
    phaseEnteredAt: 10,
    memory: {},
    fired: {},
    inFlight: null,
    spent: { swaps: 0, keys: 0, fills: 0 },
    history: {},
    outbox: [],
    lastAction: null,
    lastError: null,
    ...patch,
});

const publication = (patch: Partial<ScenarioPublication> = {}): ScenarioPublication => ({
    revision: 1,
    documentFingerprint: 'f',
    phase: 'a',
    phaseEnteredAt: 10,
    observedAt: 10,
    validUntil: null,
    bindings: {},
    profile: null,
    ...patch,
});

describe('the trace of a pass', () => {
    test('nothing after, nothing shown', () => {
        expect(traceStateChange(state(), null, 5, '7')).toEqual([]);
        expect(traceStateChange(state(), state(), 5, '7')).toEqual([]);
    });

    test('a rule recorded as fired (new, or fired again), a phase change, a publication, a new notice', () => {
        const before = state({
            fired: { old: { at: 1 }, again: { at: 2 } },
            outbox: [{ id: 'n1', at: 1, message: 'seen' }],
        });
        const after = state({
            phase: 'b',
            fired: { old: { at: 1 }, again: { at: 7 }, fresh: { at: 7 } },
            published: publication({ revision: 2, phase: 'b', validUntil: 99 }),
            outbox: [
                { id: 'n1', at: 1, message: 'seen' },
                { id: 'n2', at: 7, message: 'new' },
            ],
        });
        expect(traceStateChange(before, after, 7, '7')).toEqual([
            { type: 'rule', at: 7, subject: '7', phase: 'a', ruleId: 'again', applied: true },
            { type: 'rule', at: 7, subject: '7', phase: 'a', ruleId: 'fresh', applied: true },
            { type: 'phase', at: 7, subject: '7', from: 'a', to: 'b', applied: true },
            { type: 'published', at: 7, subject: '7', phase: 'b', validUntil: 99, applied: true },
            { type: 'notice', at: 7, subject: '7', message: 'new', applied: true },
        ]);
    });

    test('from nothing: the first record shows its rules, its publication and its notices, and no phase change', () => {
        const after = state({
            fired: { r: { at: 3 } },
            published: publication(),
            outbox: [{ id: 'n', at: 3, message: 'hello' }],
        });
        expect(traceStateChange(null, after, 3, 'installation').map((event) => event.type)).toEqual([
            'rule',
            'published',
            'notice',
        ]);
    });

    test('records with no outbox have no notices to show', () => {
        const bare = (patch: Partial<ScenarioState> = {}) => ({ ...state(patch), outbox: undefined });
        expect(traceStateChange(bare(), bare({ fired: { r: { at: 3 } } }), 3, '7').map((event) => event.type)).toEqual([
            'rule',
        ]);
    });

    test('the same publication revision is not shown twice', () => {
        const published = publication();
        expect(traceStateChange(state({ published }), state({ published }), 9, '7')).toEqual([]);
    });
});

describe('the deadlines', () => {
    test('a publication whose phase has no schedule has only its own validity', () => {
        expect(deadlinesOf(state({ published: publication({ validUntil: 7 }) }))).toEqual([
            { kind: 'publication', validUntil: 7 },
        ]);
        const submitOnly = publication({
            schedules: { submit: { alignment: 'end', rows: [{ count: 2, state: 'known', at: 5 }] } },
        });
        expect(deadlinesOf(state({ published: submitOnly }))).toEqual([
            { kind: 'submit', count: 2, at: 5 },
            { kind: 'publication', validUntil: null },
        ]);
    });

    test('none without a publication', () => {
        expect(deadlinesOf(null)).toEqual([]);
        expect(deadlinesOf(state())).toEqual([]);
    });

    test('resolved rows as they were published, unknown ones as null, and the publication’s own validity', () => {
        const published = publication({
            validUntil: 500,
            schedules: {
                submit: {
                    alignment: 'end',
                    rows: [
                        { count: 2, state: 'known', at: 100 },
                        { count: 3, state: 'unknown', reason: 'a timer is malformed' },
                    ],
                },
                vote: { rows: [{ state: 'known', start: 10, end: 20 }] },
                pause: { rows: [{ state: 'absent', reason: 'no such row' }] },
            },
        });
        expect(deadlinesOf(state({ published }))).toEqual([
            { kind: 'submit', count: 2, at: 100 },
            { kind: 'submit', count: 3, at: null },
            { kind: 'vote', start: 10, end: 20 },
            { kind: 'pause', start: null, end: null },
            { kind: 'publication', validUntil: 500 },
        ]);
    });
});
