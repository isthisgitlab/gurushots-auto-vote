/**
 * Every shipped scenario template must pass the same validation a user's
 * scenario does, and the vocabulary reference must name every piece the
 * validator accepts.
 */

const { SCENARIO_TEMPLATES } = require('../../src/ts/core/scenarios/templates') as typeof templatesModule;
import vocabulary = require('../../src/ts/core/scenarios/vocabulary');
import { invalid } from '../helpers/invalid';
import type * as expressionsModule from '../../src/ts/core/scenarios/expressions';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import type { ScenarioExpr } from '../../src/ts/core/types/scenario';
import type * as templatesModule from '../../src/ts/core/scenarios/templates';
import type * as scenarioSchemaModule from '../../src/ts/core/settings/scenarioSchema';
import type * as defaultsModule from '../../src/ts/core/settings/defaults';
const { validateScenario } = require('../../src/ts/core/settings/scenarioSchema') as typeof scenarioSchemaModule;
const { schemaDefaults } = require('../../src/ts/core/settings/defaults') as typeof defaultsModule;

const { evaluateExpression } = require('../../src/ts/core/scenarios/expressions') as typeof expressionsModule;

const globalDefaults = schemaDefaults();
const byId = Object.fromEntries(SCENARIO_TEMPLATES.map((t) => [t.id, t.scenario]));

describe('scenario templates', () => {
    test('ids and names are unique', () => {
        const ids = SCENARIO_TEMPLATES.map((t) => t.id);
        const names = SCENARIO_TEMPLATES.map((t) => t.scenario.name);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(names).size).toBe(names.length);
    });

    test.each(SCENARIO_TEMPLATES.map((t) => [t.id, t.scenario]))('%s validates', (id, scenario) => {
        const result = validateScenario(structuredClone(scenario), globalDefaults);
        expect(result).toEqual(expect.objectContaining({ ok: true }));
    });

    // A template is added on top of whatever the user's global defaults are, so
    // its phase overlays must not lean on the schema defaults — e.g. a final
    // window that is on with a trigger above a phase's lowered exposure.
    const customGlobals = {
        ...globalDefaults,
        exposure: 70,
        exposureTarget: 100,
        useFinalWindowExposure: true,
        finalWindowExposure: 51,
        finalWindowExposureTarget: 80,
    };
    test.each(SCENARIO_TEMPLATES.map((t) => [t.id, t.scenario]))(
        '%s validates against customised global defaults',
        (id, scenario) => {
            const result = validateScenario(structuredClone(scenario), customGlobals);
            expect(result).toEqual(expect.objectContaining({ ok: true }));
        },
    );
});

describe('the editable examples', () => {
    test('the four examples of this release ship, and only the installation one is installation scope', () => {
        for (const id of ['dynamicSubmission', 'candidateJoin', 'photoQueue', 'installationPolicy']) {
            expect(SCENARIO_TEMPLATES.map((t) => t.id)).toContain(id);
        }
        expect(byId.installationPolicy).toMatchObject({ scope: 'installation' });
        for (const t of SCENARIO_TEMPLATES.filter((item) => item.id !== 'installationPolicy')) {
            expect(t.scenario).not.toHaveProperty('scope', 'installation');
        }
    });

    // Photo and mission ids belong to one account: an example names a pool and picks entries by what they are.
    test('no example carries an account id: no pinned photo, no id selector, no mission id', () => {
        const text = JSON.stringify(SCENARIO_TEMPLATES);
        expect(text).not.toContain('"missionId"');
        expect(text).not.toContain('"by":"id"');
        expect(text).not.toMatch(/"(boost|turbo)":"/);
    });

    describe('the dynamic submission example (issue 94)', () => {
        const END = 1_800_000_000;
        const HOUR = 3600;
        const rows = () => {
            const phase = byId.dynamicSubmission.phases.push as {
                schedules: { submit: { alignment: string; rows: Array<{ count: number; at: ScenarioExpr }> } };
            };
            return phase.schedules.submit;
        };
        const deadlines = (member: Record<string, unknown>) =>
            rows().rows.map(({ count, at }) => {
                const value = evaluateExpression(at, {
                    challenge: invalid<Challenge>({
                        id: 94,
                        close_time: END,
                        start_time: END - 10 * 24 * HOUR,
                        member,
                    }),
                    state: { phaseEnteredAt: END - 48 * HOUR, memory: {} },
                    now: END - 48 * HOUR,
                    timezone: 'UTC',
                    bankroll: { keys: 3, swaps: 3, fills: 3, coins: 0 },
                });
                return [count, value.state, value.state === 'known' ? (value.value as { value: number }).value : null];
            });

        test('counts 2, 3 and 4 against the end, end-aligned', () => {
            expect(rows().alignment).toBe('end');
            expect(rows().rows.map((row) => row.count)).toEqual([2, 3, 4]);
        });

        test('with no free expiry the deadlines are end minus 10 h, 9 h and 8 h', () => {
            expect(deadlines({ boost: { state: 'AVAILABLE_KEY' } })).toEqual([
                [2, 'known', 1_799_964_000],
                [3, 'known', 1_799_967_600],
                [4, 'known', 1_799_971_200],
            ]);
        });

        test('a free expiry earlier than that moves only the first deadline, to an hour before it', () => {
            expect(deadlines({ boost: { state: 'AVAILABLE', timeout: 1_799_956_800 } })).toEqual([
                [2, 'known', 1_799_953_200],
                [3, 'known', 1_799_967_600],
                [4, 'known', 1_799_971_200],
            ]);
        });

        test('a malformed free expiry leaves the first deadline unknown and the others known', () => {
            expect(deadlines({ boost: { state: 'AVAILABLE', timeout: 'soon' } })).toEqual([
                [2, 'unknown', null],
                [3, 'known', 1_799_967_600],
                [4, 'known', 1_799_971_200],
            ]);
        });
    });
});

describe('vocabulary reference', () => {
    test('lists every condition, selector and action type', () => {
        const listed = new Set(vocabulary.VOCABULARY_REFERENCE.map(([, type]) => type));
        for (const type of [
            ...vocabulary.NUMERIC_CONDITIONS,
            ...vocabulary.STATE_CONDITIONS,
            ...vocabulary.RANGE_TIME_CONDITIONS,
            ...vocabulary.RANKING_SELECTORS,
            ...vocabulary.SPENDING_ACTIONS,
            'dailyWindow',
            'elapsedPercent',
            'balance',
            'memorySet',
            'entry',
            'all',
            'any',
            'not',
            'slot',
            'memory',
            'enterPhoto',
            'vote',
            'remember',
            'forget',
            'goto',
        ]) {
            expect(listed.has(type)).toBe(true);
        }
    });
});
