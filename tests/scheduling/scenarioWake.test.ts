/**
 * The scenario boundary in the shared cadence math: soonestScenarioWake and
 * computeNextCycleDelayMs's 'scenario' mode.
 */

import type * as thresholdWindowModule from '../../src/ts/core/scheduling/thresholdWindow';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import type { ScenarioDocument } from '../../src/ts/core/settings/scenarioSchema';
import type { ScenarioCondition } from '../../src/ts/core/types/scenario';
import type { ScenarioEngineState } from '../../src/ts/core/types/scenario';
import { invalid } from '../helpers/invalid';

const { soonestScenarioWake, computeNextCycleDelayMs } =
    require('../../src/ts/core/scheduling/thresholdWindow') as typeof thresholdWindowModule;

const NOW = 1_800_000_000;

const scenario: ScenarioDocument = {
    name: 'Plan',
    version: 1,
    start: 'main',
    phases: {
        main: { rules: [{ id: 'r1', if: [{ type: 'inPhaseFor', min: '10m' }], do: [{ type: 'fillExposure' }] }] },
        later: { rules: [{ id: 'r2', if: [{ type: 'inPhaseFor', min: '2m' }], do: [{ type: 'fillExposure' }] }] },
    },
};

const startedMain = invalid<ScenarioEngineState>({ phase: 'main', phaseEnteredAt: NOW, fired: {}, memory: {} });

const challenge = (id: number, overrides = {}): Challenge =>
    invalid<Challenge>({
        id,
        title: `C${id}`,
        start_time: NOW - 3600,
        close_time: NOW + 86400,
        ...overrides,
    });

describe('soonestScenarioWake', () => {
    test('the soonest wake across challenges, each from the phase it is in', async () => {
        const resolve = jest.fn(async (id: string) =>
            id === '1'
                ? { scenario, state: startedMain, timezone: 'UTC' }
                : {
                      scenario,
                      state: invalid<ScenarioEngineState>({
                          phase: 'later',
                          phaseEnteredAt: NOW - 60,
                          fired: {},
                          memory: {},
                      }),
                      timezone: 'UTC',
                  },
        );
        await expect(soonestScenarioWake([challenge(1), challenge(2)], NOW, resolve)).resolves.toEqual({
            challengeId: 2,
            challengeTitle: 'C2',
            startTime: NOW + 60,
            phase: 'later',
        });
        await expect(soonestScenarioWake([challenge(1)], NOW, resolve)).resolves.toEqual(
            expect.objectContaining({ challengeId: 1, startTime: NOW + 600, phase: 'main' }),
        );
    });

    describe('a plan that has not started has no phase clock', () => {
        const timed = (condition: ScenarioCondition): ScenarioDocument => ({
            name: 'Timed',
            version: 1,
            start: 'main',
            phases: { main: { rules: [{ id: 'r', if: [condition], do: [{ type: 'fillExposure' }] }] } },
        });
        const inPhase: ScenarioCondition = { type: 'inPhaseFor', min: '10m' };
        const beforeEnd: ScenarioCondition = { type: 'beforeEnd', max: '2h' };
        const wakeOf = (doc: ScenarioDocument, state: ScenarioEngineState | null) =>
            soonestScenarioWake([challenge(1)], NOW, () => ({ scenario: doc, state, timezone: 'UTC' }));

        test.each([
            ['bare', inPhase],
            ['inside all', { type: 'all', of: [inPhase] } as ScenarioCondition],
            ['inside any', { type: 'any', of: [inPhase] } as ScenarioCondition],
            ['inside not', { type: 'not', condition: inPhase } as ScenarioCondition],
        ])('an in-phase bound (%s) is no wake', async (_label, condition) => {
            await expect(wakeOf(timed(condition), null)).resolves.toBeNull();
        });

        test('the same bound wakes a plan that has started', async () => {
            await expect(wakeOf(timed(inPhase), startedMain)).resolves.toEqual(
                expect.objectContaining({ startTime: NOW + 600 }),
            );
        });

        test('its other bounds still produce a wake', async () => {
            const doc = timed({ type: 'all', of: [inPhase, beforeEnd] });
            await expect(wakeOf(doc, null)).resolves.toEqual(
                expect.objectContaining({ startTime: NOW + 86400 - 7200, phase: 'main' }),
            );
        });
    });

    test('skips closed challenges, no-scenario challenges, throwing resolvers and nothing-pending plans', async () => {
        const resolve = jest.fn((id: string) => {
            if (id === '2') return null;
            if (id === '3') throw new Error('boom');
            return { scenario: { ...scenario, phases: { main: {} } }, state: null, timezone: 'UTC' };
        });
        const list = [challenge(1), challenge(2), challenge(3), challenge(4, { close_time: NOW - 1 })];
        await expect(soonestScenarioWake(list, NOW, resolve)).resolves.toBeNull();
        expect(resolve).not.toHaveBeenCalledWith('4');
        await expect(soonestScenarioWake(invalid(null), NOW, resolve)).resolves.toBeNull();
    });
});

describe('computeNextCycleDelayMs — scenario boundary', () => {
    const base = {
        resolveThreshold: () => 10,
        normalDelayMs: 30 * 60_000,
        lastMinuteCheckMinutes: 1,
        minGapMs: 5000,
    };

    test('caps the wait to the scenario wake and reports it', async () => {
        const result = await computeNextCycleDelayMs([challenge(1)], NOW, {
            ...base,
            resolveScenarioWake: () => ({ scenario, state: startedMain, timezone: 'UTC' }),
        });
        expect(result.mode).toBe('scenario');
        expect(result.delayMs).toBe(600_000);
        expect(result.nextScenarioWake).toEqual(expect.objectContaining({ challengeId: 1 }));
    });

    test('without the resolver there is no scenario boundary', async () => {
        const result = await computeNextCycleDelayMs([challenge(1)], NOW, base);
        expect(result.mode).toBe('normal');
        expect(result.nextScenarioWake).toBeNull();
    });

    test('an active Auto-Submit clock window still wakes for an earlier scenario boundary', async () => {
        const activeTime = new Date(NOW * 1000).toISOString().slice(11, 16);
        const result = await computeNextCycleDelayMs(
            [
                challenge(1, {
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                }),
            ],
            NOW,
            {
                ...base,
                lastMinuteCheckMinutes: 5,
                resolveAutoSubmitClock: () => ({
                    enabled: true,
                    manualPhotosOnly: false,
                    times: [activeTime],
                    windowMinutes: 60,
                }),
                resolveScenarioWake: () => ({
                    scenario,
                    state: invalid<ScenarioEngineState>({
                        phase: 'later',
                        phaseEnteredAt: NOW - 60,
                        fired: {},
                        memory: {},
                    }),
                    timezone: 'UTC',
                }),
                timezone: 'UTC',
            },
        );
        expect(result).toMatchObject({ mode: 'scenario', delayMs: 60_000 });
        expect(result.nextAutoSubmitClock).toMatchObject({ anyActive: true });
    });

    test('the last-minute early return reports no scenario wake', async () => {
        const result = await computeNextCycleDelayMs([challenge(1, { close_time: NOW + 60 })], NOW, {
            ...base,
            resolveScenarioWake: () => ({ scenario, state: null, timezone: 'UTC' }),
        });
        expect(result.mode).toBe('last-minute');
        expect(result.nextScenarioWake).toBeNull();
    });
});

// --- expressions, publications and the account's own boundaries ---------------------------------------------------------

import type { ScenarioExpr } from '../../src/ts/core/types/scenario';
import type * as wallClockModule from '../../src/ts/core/scheduling/wallClock';
import type * as nextWakeModule from '../../src/ts/core/scenarios/nextWake';

const { soonestAccountWake } = require('../../src/ts/core/scheduling/thresholdWindow') as typeof thresholdWindowModule;
const { occurrencesOf } = require('../../src/ts/core/scheduling/wallClock') as typeof wallClockModule;
const { nextWakeAt } = require('../../src/ts/core/scenarios/nextWake') as typeof nextWakeModule;

const fact = (name: string): ScenarioExpr => invalid<ScenarioExpr>({ kind: 'fact', name });
const seconds = (value: number): ScenarioExpr => ({ kind: 'literal', value, quantity: 'duration' });
const before = (from: ScenarioExpr, by: ScenarioExpr): ScenarioExpr => ({
    kind: 'offset',
    from,
    by,
    direction: 'before',
});
const withRule = (condition: ScenarioCondition, scope?: 'installation'): ScenarioDocument => ({
    name: 'Expr',
    version: 1,
    ...(scope ? { scope } : {}),
    start: 'main',
    phases: { main: { rules: [{ id: 'r', if: [condition], do: [{ type: 'notify', message: 'x' }] }] } },
});
const CLOSE = NOW + 86400;
const boostedTurbo = (extra = {}) =>
    challenge(1, {
        close_time: CLOSE,
        member: {
            boost: { state: 'AVAILABLE', timeout: NOW + 5000 },
            turbo: { state: 'AVAILABLE', time_to_open: NOW + 7000 },
        },
        ...extra,
    });
const wake = (
    doc: ScenarioDocument,
    subject: Challenge = boostedTurbo(),
    state: ScenarioEngineState | null = startedMain,
) => soonestScenarioWake([subject], NOW, () => ({ scenario: doc, state, timezone: 'UTC' }));

describe('a rule condition that compares or tests an expression wakes the scheduler at the instants it stands for', () => {
    const now = fact('clock.now');

    test('an instant offset from the close, whichever way it is nested or negated', async () => {
        const at = CLOSE - 7200;
        const compare = invalid<ScenarioCondition>({
            type: 'compare',
            left: now,
            op: '>=',
            right: before(fact('challenge.end'), seconds(7200)),
        });
        for (const condition of [
            compare,
            invalid<ScenarioCondition>({ type: 'not', condition: compare }),
            invalid<ScenarioCondition>({
                type: 'all',
                of: [{ type: 'any', of: [{ type: 'not', condition: { type: 'not', condition: compare } }] }],
            }),
        ]) {
            await expect(wake(withRule(condition))).resolves.toMatchObject({ startTime: at });
        }
    });

    test('the free Boost expiry, the Turbo opening and the second after each', async () => {
        const boost = invalid<ScenarioCondition>({
            type: 'compare',
            left: now,
            op: '<',
            right: fact('boost.freeExpiry'),
        });
        await expect(wake(withRule(boost))).resolves.toMatchObject({ startTime: NOW + 5000 });
        const turbo = invalid<ScenarioCondition>({ type: 'present', value: fact('turbo.opensAt') });
        await expect(wake(withRule(turbo))).resolves.toMatchObject({ startTime: NOW + 7000 });
        const absent = invalid<ScenarioCondition>({ type: 'absent', value: fact('turbo.opensAt') });
        await expect(wake(withRule(absent))).resolves.toMatchObject({ startTime: NOW + 7000 });
        // Only the second after it: the Boost's expiry is behind the clock.
        const gone = invalid<ScenarioCondition>({
            type: 'compare',
            left: now,
            op: '<',
            right: fact('boost.freeExpiry'),
        });
        await expect(
            wake(withRule(gone), boostedTurbo({ member: { boost: { state: 'AVAILABLE', timeout: NOW - 5 } } })),
        ).resolves.toBeNull();
    });

    test('a changed anchor changes the wake at the next decision: nothing is remembered', async () => {
        const boost = invalid<ScenarioCondition>({
            type: 'compare',
            left: now,
            op: '<',
            right: fact('boost.freeExpiry'),
        });
        await expect(wake(withRule(boost))).resolves.toMatchObject({ startTime: NOW + 5000 });
        const moved = boostedTurbo({ member: { boost: { state: 'AVAILABLE', timeout: NOW + 1200 } } });
        await expect(wake(withRule(boost), moved)).resolves.toMatchObject({ startTime: NOW + 1200 });
        // The anchor is gone (the Boost was spent): no wake.
        const spent = boostedTurbo({ member: { boost: { state: 'USED' } } });
        await expect(wake(withRule(boost), spent)).resolves.toBeNull();
    });

    test('a clock-driven duration reaches the number it is compared with', async () => {
        const left = invalid<ScenarioCondition>({
            type: 'compare',
            left: fact('challenge.timeLeft'),
            op: '<=',
            right: seconds(3600),
        });
        await expect(wake(withRule(left))).resolves.toMatchObject({ startTime: CLOSE - 3600 });
        const right = invalid<ScenarioCondition>({
            type: 'compare',
            left: seconds(3600),
            op: '>=',
            right: fact('challenge.timeLeft'),
        });
        await expect(wake(withRule(right))).resolves.toMatchObject({ startTime: CLOSE - 3600 });
        const growing = invalid<ScenarioCondition>({
            type: 'compare',
            left: fact('phase.elapsed'),
            op: '>=',
            right: seconds(900),
        });
        await expect(wake(withRule(growing))).resolves.toMatchObject({ startTime: NOW + 900 });
        const free = invalid<ScenarioCondition>({
            type: 'compare',
            left: fact('boost.freeRemaining'),
            op: '<',
            right: seconds(60),
        });
        await expect(wake(withRule(free))).resolves.toMatchObject({ startTime: NOW + 5000 - 60 });
    });

    test('unknown, absent and non-numeric evidence supplies no instant', async () => {
        const unknownBoost = boostedTurbo({ member: {} });
        // current value unknown
        await expect(
            wake(
                withRule(
                    invalid<ScenarioCondition>({
                        type: 'compare',
                        left: fact('boost.freeRemaining'),
                        op: '<',
                        right: seconds(60),
                    }),
                ),
                unknownBoost,
            ),
        ).resolves.toBeNull();
        // the other side unknown
        await expect(
            wake(
                withRule(
                    invalid<ScenarioCondition>({
                        type: 'compare',
                        left: fact('challenge.timeLeft'),
                        op: '<',
                        right: fact('boost.freeRemaining'),
                    }),
                ),
                unknownBoost,
            ),
        ).resolves.toBeNull();
        // the other side is not a number
        await expect(
            wake(
                withRule(
                    invalid<ScenarioCondition>({
                        type: 'compare',
                        left: fact('challenge.timeLeft'),
                        op: '=',
                        right: fact('challenge.title'),
                    }),
                ),
            ),
        ).resolves.toBeNull();
        // a fact that does not move with the clock, and a side that is not a fact
        await expect(
            wake(
                withRule(
                    invalid<ScenarioCondition>({
                        type: 'compare',
                        left: fact('challenge.entries'),
                        op: '>',
                        right: { kind: 'literal', value: 2, quantity: 'count' },
                    }),
                ),
            ),
        ).resolves.toBeNull();
        // a list condition reads two expressions and none of them is an instant
        await expect(
            wake(
                withRule(
                    invalid<ScenarioCondition>({
                        type: 'contains',
                        list: fact('challenge.tags'),
                        value: { kind: 'literal', value: 'x' },
                    }),
                ),
            ),
        ).resolves.toBeNull();
        await expect(
            wake(
                withRule(
                    invalid<ScenarioCondition>({
                        type: 'containsAll',
                        list: fact('challenge.tags'),
                        value: fact('boost.freeExpiry'),
                    }),
                ),
            ),
        ).resolves.toMatchObject({ startTime: NOW + 5000 });
    });

    test('without facts (a caller that has none) the expressions supply nothing', () => {
        const doc = withRule(invalid<ScenarioCondition>({ type: 'present', value: fact('turbo.opensAt') }));
        expect(
            nextWakeAt({ scenario: doc, state: startedMain, challenge: boostedTurbo(), now: NOW, timezone: 'UTC' }),
        ).toBeNull();
        const compare = withRule(
            invalid<ScenarioCondition>({
                type: 'compare',
                left: fact('challenge.timeLeft'),
                op: '<',
                right: seconds(5),
            }),
        );
        expect(
            nextWakeAt({ scenario: compare, state: startedMain, challenge: boostedTurbo(), now: NOW, timezone: 'UTC' }),
        ).toBeNull();
    });
});

describe('a publication is made again at its own boundary', () => {
    const published = (patch: Record<string, unknown>) =>
        invalid<ScenarioEngineState>({
            ...startedMain,
            published: {
                phase: 'main',
                revision: 1,
                documentFingerprint: 'f',
                phaseEnteredAt: NOW,
                observedAt: NOW,
                bindings: {},
                profile: null,
                validUntil: NOW + 500,
                ...patch,
            },
        });
    const empty = withRule(invalid<ScenarioCondition>({ type: 'dailyWindow', from: '00:00', to: '00:00' }));

    test('validUntil wakes; none, another phase, or one already past do not', async () => {
        const instants = (state: ScenarioEngineState) =>
            nextWakeAt({
                scenario: { ...empty, phases: { main: { rules: [] } } },
                state,
                challenge: boostedTurbo(),
                now: NOW,
                timezone: 'UTC',
            });
        expect(instants(published({}))).toBe(NOW + 500);
        expect(instants(published({ validUntil: null }))).toBeNull();
        expect(instants(published({ phase: 'later' }))).toBeNull();
        expect(instants(published({ validUntil: NOW - 1 }))).toBeNull();
    });

    test('inclusive window ends wake at the first second after them', () => {
        const state = published({
            validUntil: null,
            schedules: {
                vote: { rows: [{ state: 'known', start: NOW + 100, end: NOW + 400 }] },
                pause: { rows: [{ state: 'unknown' }] },
            },
        });
        const doc = { ...empty, phases: { main: { rules: [] } } };
        expect(nextWakeAt({ scenario: doc, state, challenge: boostedTurbo(), now: NOW, timezone: 'UTC' })).toBe(
            NOW + 100,
        );
        expect(nextWakeAt({ scenario: doc, state, challenge: boostedTurbo(), now: NOW + 100, timezone: 'UTC' })).toBe(
            NOW + 401,
        );
    });
});

describe('soonestAccountWake — boundaries that no challenge close time bounds', () => {
    const installationDoc = withRule(
        invalid<ScenarioCondition>({ type: 'dailyWindow', from: '03:30', to: '04:30' }),
        'installation',
    );
    const sources = (patch: Record<string, unknown> = {}) => ({
        installation: {
            scenario: installationDoc,
            state: startedMain,
            timezone: 'Europe/Riga',
            horizon: NOW + 3 * 86400,
        },
        candidates: [],
        claimAt: null,
        missionExpiry: null,
        ...patch,
    });

    test('the installation wakes at its next window edge in its own zone, across a daylight-saving change', async () => {
        // The night Riga skips 03:00-04:00 (2027-03-28): an edge that does not exist that day still wakes no later than the real one.
        const eve = Date.UTC(2027, 2, 27, 20, 0, 0) / 1000;
        const found = await soonestAccountWake(eve, () =>
            sources({ installation: { ...sources().installation, horizon: eve + 3 * 86400 } }),
        );
        const expected = Math.min(
            occurrencesOf('03:30', 'Europe/Riga', eve)!.next,
            occurrencesOf('04:30', 'Europe/Riga', eve)!.next,
        );
        expect(found).toEqual({ kind: 'installation', startTime: expected, label: 'the installation scenario' });
        expect(found!.startTime).toBeGreaterThan(eve);
    });

    test('the horizon bounds it, a plan that has not started has no phase clock, and no challenge is needed', async () => {
        await expect(
            soonestAccountWake(NOW, () => sources({ installation: { ...sources().installation, horizon: NOW + 60 } })),
        ).resolves.toBeNull();
        const phaseBound = withRule(invalid<ScenarioCondition>({ type: 'inPhaseFor', min: '10m' }), 'installation');
        const fresh = { ...sources().installation, scenario: phaseBound, state: null };
        await expect(soonestAccountWake(NOW, () => sources({ installation: fresh }))).resolves.toBeNull();
        await expect(
            soonestAccountWake(NOW, () => sources({ installation: { ...fresh, state: startedMain } })),
        ).resolves.toMatchObject({ kind: 'installation', startTime: NOW + 600 });
    });

    test('the installation reads the evidence it is given: a mission expiry in a condition', async () => {
        const condition = invalid<ScenarioCondition>({ type: 'present', value: fact('missions.nextExpiry') });
        const doc = withRule(condition, 'installation');
        const evidence = {
            missions: {
                readable: true as const,
                needs: { join: 0, fill: 0, turbo: 0, boost: 0, vote: 1 },
                unreadable: [],
                nextExpiry: NOW + 900,
                expiryUnreadable: false,
            },
        };
        await expect(
            soonestAccountWake(NOW, () =>
                sources({ installation: { ...sources().installation, scenario: doc, evidence } }),
            ),
        ).resolves.toMatchObject({ startTime: NOW + 900 });
        await expect(
            soonestAccountWake(NOW, () => sources({ installation: { ...sources().installation, scenario: doc } })),
        ).resolves.toBeNull();
    });

    test('a candidate wakes when it opens and at its own pre-join conditions', async () => {
        const doc = withRule(invalid<ScenarioCondition>({ type: 'beforeEnd', max: '2h' }));
        const candidate = (patch = {}) => ({
            challenge: challenge(5, { start_time: NOW + 1000, close_time: NOW + 20000, ...patch }),
            scenario: doc,
            timezone: 'UTC',
        });
        await expect(
            soonestAccountWake(NOW, () => sources({ installation: null, candidates: [candidate()] })),
        ).resolves.toEqual({ kind: 'pre-join', startTime: NOW + 1000, label: 'C5' });
        // Already open: only its condition.
        await expect(
            soonestAccountWake(NOW, () =>
                sources({ installation: null, candidates: [candidate({ start_time: NOW - 5 })] }),
            ),
        ).resolves.toMatchObject({ kind: 'pre-join', startTime: NOW + 20000 - 7200 });
    });

    test('the claim throttle and a mission expiry; the soonest wins; unknown and bad values supply none', async () => {
        await expect(
            soonestAccountWake(NOW, () => sources({ installation: null, claimAt: NOW + 3600 })),
        ).resolves.toEqual({ kind: 'claim', startTime: NOW + 3600, label: 'the prize claim' });
        await expect(
            soonestAccountWake(NOW, () =>
                sources({ installation: null, claimAt: NOW + 3600, missionExpiry: NOW + 90 }),
            ),
        ).resolves.toEqual({ kind: 'mission', startTime: NOW + 90, label: 'a mission expiry' });
        await expect(
            soonestAccountWake(NOW, () => sources({ installation: null, claimAt: Number.NaN, missionExpiry: NOW - 1 })),
        ).resolves.toBeNull();
        await expect(soonestAccountWake(NOW, () => null)).resolves.toBeNull();
        await expect(
            soonestAccountWake(NOW, () => {
                throw new Error('boom');
            }),
        ).resolves.toBeNull();
    });
});

describe('computeNextCycleDelayMs — the account boundary', () => {
    const options = { resolveThreshold: () => 1, normalDelayMs: 600_000, lastMinuteCheckMinutes: 1, minGapMs: 5_000 };
    const account = (startTime: number) => () => ({
        installation: null,
        candidates: [],
        claimAt: startTime,
        missionExpiry: null,
    });

    test('caps the wait to the boundary once, in milliseconds, and reports it; a far one does not shorten the wait', async () => {
        const near = await computeNextCycleDelayMs([], NOW, { ...options, resolveAccountWake: account(NOW + 120) });
        expect(near).toMatchObject({
            mode: 'account',
            delayMs: 120_000,
            nextAccountWake: { kind: 'claim', startTime: NOW + 120 },
        });
        expect(near.delayMs).toBeLessThanOrEqual((near.nextAccountWake!.startTime - NOW) * 1000);
        const far = await computeNextCycleDelayMs([], NOW, { ...options, resolveAccountWake: account(NOW + 86400) });
        expect(far).toMatchObject({ mode: 'normal', delayMs: 600_000, nextAccountWake: { startTime: NOW + 86400 } });
        // Due work is never a zero-delay loop: a boundary already behind is not one.
        const due = await computeNextCycleDelayMs([], NOW, { ...options, resolveAccountWake: account(NOW) });
        expect(due).toMatchObject({ mode: 'normal', nextAccountWake: null });
    });

    test('inside a last-minute window the fast cadence is capped to it as well', async () => {
        const inWindow = [challenge(1, { close_time: NOW + 600 })];
        const decision = await computeNextCycleDelayMs(inWindow, NOW, {
            ...options,
            resolveThreshold: () => 30,
            resolveAccountWake: account(NOW + 20),
        });
        expect(decision).toMatchObject({ mode: 'account', delayMs: 20_000 });
        expect(await computeNextCycleDelayMs([], NOW, options)).toMatchObject({ nextAccountWake: null });
    });
});
