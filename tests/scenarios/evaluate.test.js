/**
 * The scenario decision (which rule fires, from which action) and the
 * scheduler wake-up it reports.
 */

const { evaluateScenario, firedRecord, localDayOf } = require('../../src/js/scenarios/evaluate');
const { nextWakeAt } = require('../../src/js/scenarios/nextWake');
const { initialState } = require('../../src/js/scenarioStateStore');
const { epochForWallTime } = require('../../src/js/scheduling/wallClock');

jest.mock('../../src/js/logger', () => ({ withCategory: jest.fn(() => ({ error: jest.fn() })) }));

const TZ = 'Europe/Riga';
const at = (y, m, d, hh, mm) => epochForWallTime(y, m, d, hh, mm, TZ);
const NOW = at(2026, 9, 25, 7, 0);
const DAY = 86400;

const challenge = (overrides = {}) => ({
    start_time: NOW - 10 * DAY,
    close_time: NOW + 2 * DAY,
    max_photo_submits: 4,
    member: { ranking: { entries: [{ id: 'a', votes: 5, rank: 40 }], exposure: { exposure_factor: 30 } } },
    ...overrides,
});

const scenario = (rules, extraPhases = {}) => ({
    name: 'Plan',
    version: 1,
    start: 'main',
    phases: { main: { rules }, ...extraPhases },
});

const rule = (id, conditions, extra = {}) => ({ id, if: conditions, do: [{ type: 'fillExposure' }], ...extra });

const yes = { type: 'entries', op: '=', value: 1 };
const no = { type: 'entries', op: '=', value: 3 };

const run = (doc, state = initialState('Plan', 'main', NOW - 60), overrides = {}) =>
    evaluateScenario({ scenario: doc, state, challenge: challenge(), now: NOW, timezone: TZ, ...overrides });

describe('evaluateScenario', () => {
    test('fires the first rule whose conditions hold, and explains every rule', () => {
        const result = run(scenario([rule('r1', [no]), rule('r2', [yes], { label: 'Second' }), rule('r3', [])]));
        expect(result.halted).toBeNull();
        expect(result.fire).toEqual(expect.objectContaining({ ruleId: 'r2', startIndex: 0 }));
        expect(result.explain).toEqual([
            { ruleId: 'r1', label: 'r1', status: 'waiting', reason: 'condition 1 (entries) does not hold' },
            { ruleId: 'r2', label: 'Second', status: 'ready', reason: 'all conditions hold' },
            { ruleId: 'r3', label: 'r3', status: 'ready', reason: 'ready, after an earlier rule' },
        ]);
    });

    test('nothing fires when no rule is ready; a phase without rules is fine', () => {
        expect(run(scenario([rule('r1', [no])])).fire).toBeNull();
        expect(run({ ...scenario([]), phases: { main: {} } }).fire).toBeNull();
    });

    test('rules already fired in this pass are skipped', () => {
        const result = run(scenario([rule('r1', [yes])]), undefined, { skipRuleIds: new Set(['r1']) });
        expect(result.fire).toBeNull();
        expect(result.explain[0]).toEqual(
            expect.objectContaining({ status: 'blocked', reason: 'already fired in this pass' }),
        );
    });

    describe('repeat modes', () => {
        const fired = (state, ruleId, record) => ({ ...state, fired: { [ruleId]: record } });

        test('always fires again on a later pass', () => {
            const state = fired(
                initialState('Plan', 'main', NOW - 60),
                'r1',
                firedRecord({ phaseEnteredAt: 0 }, NOW, TZ),
            );
            expect(run(scenario([rule('r1', [yes])]), state).fire?.ruleId).toBe('r1');
        });

        test('once never fires again', () => {
            const state = fired(initialState('Plan', 'main', NOW - 60), 'r1', { at: NOW - 5 * DAY });
            expect(run(scenario([rule('r1', [yes], { repeat: 'once' })]), state).explain[0].reason).toBe(
                'already fired',
            );
        });

        test('oncePerPhase resets when the phase is entered again', () => {
            const base = initialState('Plan', 'main', NOW - 60);
            const doc = scenario([rule('r1', [yes], { repeat: 'oncePerPhase' })]);
            expect(run(doc, fired(base, 'r1', firedRecord(base, NOW - 30, TZ))).fire).toBeNull();
            expect(run(doc, fired(base, 'r1', { at: NOW - DAY, phaseEnteredAt: NOW - 2 * DAY })).fire?.ruleId).toBe(
                'r1',
            );
        });

        test('oncePerDay follows the local calendar day', () => {
            const base = initialState('Plan', 'main', NOW - 60);
            const doc = scenario([rule('r1', [yes], { repeat: 'oncePerDay' })]);
            // Fired at 00:30 today (Riga) → blocked; fired at 23:30 yesterday → allowed.
            expect(run(doc, fired(base, 'r1', firedRecord(base, at(2026, 9, 25, 0, 30), TZ))).fire).toBeNull();
            expect(run(doc, fired(base, 'r1', firedRecord(base, at(2026, 9, 24, 23, 30), TZ))).fire?.ruleId).toBe('r1');
        });
    });

    describe('interrupted rules', () => {
        const doc = scenario([rule('r1', [no], { do: [{ type: 'fillExposure' }, { type: 'unlockBoost' }] })]);

        test('an in-flight rule resumes from its action before anything else', () => {
            const state = { ...initialState('Plan', 'main', NOW - 60), inFlight: { ruleId: 'r1', actionIndex: 1 } };
            const result = run(doc, state);
            expect(result.fire).toEqual(expect.objectContaining({ ruleId: 'r1', startIndex: 1 }));
            expect(result.explain[0].reason).toBe('resuming an interrupted rule');
        });

        test('it does not resume twice in one pass', () => {
            const state = { ...initialState('Plan', 'main', NOW - 60), inFlight: { ruleId: 'r1', actionIndex: 1 } };
            expect(run(doc, state, { skipRuleIds: new Set(['r1']) }).fire).toBeNull();
        });

        test('an in-flight rule the edited scenario no longer has halts the challenge', () => {
            for (const inFlight of [
                { ruleId: 'gone', actionIndex: 0 },
                { ruleId: 'r1', actionIndex: 5 },
            ]) {
                const result = run(doc, { ...initialState('Plan', 'main', NOW), inFlight });
                expect(result.halted).toContain('no longer matches');
                expect(result.fire).toBeNull();
            }
        });
    });

    test('a phase the edited scenario no longer has halts the challenge', () => {
        const result = run(scenario([]), initialState('Plan', 'removed', NOW));
        expect(result.halted).toBe('Phase "removed" no longer exists in scenario "Plan"');
        expect(result.nextWakeAt).toBeNull();
    });
});

describe('localDayOf / firedRecord', () => {
    test('the day key is the local midnight', () => {
        expect(localDayOf(NOW, TZ)).toBe(at(2026, 9, 25, 0, 0));
        expect(firedRecord({ phaseEnteredAt: 5 }, NOW, TZ)).toEqual({
            at: NOW,
            day: at(2026, 9, 25, 0, 0),
            phaseEnteredAt: 5,
        });
    });
});

describe('nextWakeAt', () => {
    const wake = (conditions, overrides = {}) =>
        nextWakeAt({
            scenario: scenario([rule('r1', conditions, overrides.rule)]),
            state: overrides.state ?? initialState('Plan', 'main', NOW - 60),
            challenge: overrides.challenge ?? challenge(),
            now: overrides.now ?? NOW,
            timezone: TZ,
        });

    test('daily window: the next opening or closing, whichever comes first', () => {
        expect(wake([{ type: 'dailyWindow', from: '06:00', to: '08:00' }])).toBe(at(2026, 9, 25, 8, 0));
        expect(wake([{ type: 'dailyWindow', from: '20:00', to: '21:00' }])).toBe(at(2026, 9, 25, 20, 0));
    });

    test('daily window across a DST switch lands on the real wall-clock time', () => {
        const now = at(2026, 3, 28, 12, 0);
        const c = challenge({ close_time: now + 5 * DAY });
        expect(wake([{ type: 'dailyWindow', from: '06:00', to: '08:00' }], { now, challenge: c })).toBe(
            at(2026, 3, 29, 6, 0),
        );
    });

    test('beforeEnd: when the time left crosses max, then min', () => {
        const close = NOW + 2 * DAY;
        expect(wake([{ type: 'beforeEnd', max: '1d' }])).toBe(close - DAY);
        expect(wake([{ type: 'beforeEnd', min: '1d' }])).toBe(close - DAY + 1);
    });

    test('afterStart and inPhaseFor thresholds', () => {
        const start = NOW - 10 * DAY;
        expect(wake([{ type: 'afterStart', min: '11d' }])).toBe(start + 11 * DAY);
        expect(wake([{ type: 'afterStart', max: '10d 1h' }])).toBe(start + 10 * DAY + 3600 + 1);
        expect(wake([{ type: 'inPhaseFor', min: '4m' }])).toBe(NOW - 60 + 240);
        expect(wake([{ type: 'inPhaseFor', max: '2m' }])).toBe(NOW - 60 + 121);
    });

    test('elapsedPercent thresholds, only with a readable span', () => {
        const start = NOW - 10 * DAY;
        const span = 12 * DAY;
        expect(wake([{ type: 'elapsedPercent', min: 90 }])).toBe(start + Math.ceil(span * 0.9));
        expect(wake([{ type: 'elapsedPercent', max: 90 }])).toBe(start + Math.ceil(span * 0.9) + 1);
        expect(
            wake([{ type: 'elapsedPercent', min: 90 }], { challenge: challenge({ start_time: undefined }) }),
        ).toBeNull();
    });

    test('afterStart without a readable start, and a rule without conditions, add nothing', () => {
        expect(
            wake([{ type: 'afterStart', min: '1d' }], { challenge: challenge({ start_time: undefined }) }),
        ).toBeNull();
        expect(
            nextWakeAt({
                scenario: scenario([{ id: 'bare', do: [{ type: 'fillExposure' }] }]),
                state: initialState('Plan', 'main', NOW),
                challenge: challenge(),
                now: NOW,
                timezone: TZ,
            }),
        ).toBeNull();
    });

    test('nested conditions are searched', () => {
        const nested = [
            {
                type: 'not',
                condition: { type: 'any', of: [{ type: 'all', of: [{ type: 'inPhaseFor', min: '4m' }] }, yes] },
            },
        ];
        expect(wake(nested)).toBe(NOW - 60 + 240);
    });

    test('a once-per-day rule that fired wakes at local midnight', () => {
        const state = { ...initialState('Plan', 'main', NOW - 60), fired: { r1: { at: NOW } } };
        expect(wake([yes], { state, rule: { repeat: 'oncePerDay' } })).toBe(at(2026, 9, 26, 0, 0));
        expect(wake([yes], { rule: { repeat: 'oncePerDay' } })).toBeNull();
    });

    test('only instants before the close count; a closed or clockless challenge has none', () => {
        expect(wake([{ type: 'afterStart', min: '30d' }])).toBeNull();
        expect(wake([yes])).toBeNull();
        expect(wake([{ type: 'inPhaseFor', min: '4m' }], { now: NOW + 3 * DAY })).toBeNull();
        expect(wake([{ type: 'inPhaseFor', min: '4m' }], { challenge: challenge({ close_time: null }) })).toBeNull();
    });

    test('an unknown phase has nothing to wake for', () => {
        expect(
            nextWakeAt({
                scenario: scenario([]),
                state: initialState('Plan', 'x', NOW),
                challenge: challenge(),
                now: NOW,
                timezone: TZ,
            }),
        ).toBeNull();
    });
});
