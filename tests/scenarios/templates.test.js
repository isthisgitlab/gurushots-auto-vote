/**
 * Every shipped scenario template must pass the same validation a user's
 * scenario does, and the vocabulary reference must name every piece the
 * validator accepts.
 */

const { SCENARIO_TEMPLATES } = require('../../src/js/scenarios/templates');
const vocabulary = require('../../src/js/scenarios/vocabulary');
const { validateScenario } = require('../../src/js/settings/scenarioSchema');
const { getDefaultSettings } = require('../../src/js/settings/defaults');

const globalDefaults = getDefaultSettings().challengeSettings.globalDefaults;

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
