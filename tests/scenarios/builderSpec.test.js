/**
 * The builder's form table must agree with the validator: every default
 * condition, action and selector it can create validates, and every
 * vocabulary piece is in the table.
 */

const spec = require('../../src/js/scenarios/builderSpec');
const vocabulary = require('../../src/js/scenarios/vocabulary');
const { validateScenario } = require('../../src/js/settings/scenarioSchema');
const { getDefaultSettings } = require('../../src/js/settings/defaults');
const english = require('../../src/js/translations/english');
const latvian = require('../../src/js/translations/latvian');

const globalDefaults = getDefaultSettings().challengeSettings.globalDefaults;

// A scenario around the pieces under test: a writer for the "held" memory
// slot the defaults read, and a phase for goto.
const scenarioWith = ({ conditions = [], actions = [{ type: 'fillExposure' }] }) => ({
    name: 'Spec',
    version: 1,
    start: 'main',
    phases: {
        main: {
            rules: [
                { id: 'writer', do: [{ type: 'remember', slot: 'held', entry: { by: 'bestRank' } }] },
                { id: 'subject', if: conditions, do: actions },
            ],
        },
    },
});

const expectValid = (doc) => {
    const result = validateScenario(doc, globalDefaults);
    expect(result.issues ?? []).toEqual([]);
};

test.each(spec.CONDITION_TYPES)('the default %s condition validates', (type) => {
    expectValid(scenarioWith({ conditions: [spec.defaultCondition(type)] }));
});

test.each(spec.ACTION_TYPES)('the default %s action validates', (type) => {
    expectValid(scenarioWith({ actions: [spec.defaultAction(type, { phases: ['main'] })] }));
});

test.each(spec.SELECTOR_TYPES)('the default %s selector validates', (by) => {
    expectValid(scenarioWith({ actions: [{ type: 'boost', entry: spec.defaultSelector(by) }] }));
});

test('every vocabulary piece has a form', () => {
    for (const type of [
        ...vocabulary.NUMERIC_CONDITIONS,
        ...vocabulary.STATE_CONDITIONS,
        ...vocabulary.RANGE_TIME_CONDITIONS,
    ]) {
        expect(spec.CONDITION_TYPES).toContain(type);
    }
    for (const by of vocabulary.RANKING_SELECTORS) expect(spec.SELECTOR_TYPES).toContain(by);
    expect(spec.ENTRY_FIELDS).toEqual([...vocabulary.NUMERIC_ENTRY_FIELDS, ...vocabulary.BOOLEAN_ENTRY_FIELDS]);
});

test('default field values cover every kind', () => {
    expect(spec.defaultFieldValue({ key: 'goto', kind: 'phase' })).toBe('main');
    expect(spec.defaultFieldValue({ key: 'x', kind: 'number' })).toBe(0);
    expect(spec.defaultFieldValue({ key: 'x', kind: 'entryValue' })).toBe(0);
    expect(spec.defaultFieldValue({ key: 'x', kind: 'boolean' })).toBe(false);
    expect(spec.defaultFieldValue({ key: 'window', kind: 'duration' })).toBe('1h');
});

describe('translations', () => {
    const keys = [
        ...spec.CONDITION_TYPES.map((type) => `sbCond_${type}`),
        ...spec.ACTION_TYPES.map((type) => `sbAct_${type}`),
        ...spec.SELECTOR_TYPES.map((by) => `sbSel_${by}`),
        ...spec.ENTRY_FIELDS.map((field) => `sbEntryField_${field}`),
        ...vocabulary.REPEAT_MODES.map((mode) => `sbRepeat_${mode}`),
        ...vocabulary.CURRENCIES.map((currency) => `sbCurrency_${currency}`),
        ...[
            ...new Set(
                [
                    ...Object.values(spec.CONDITION_FIELDS),
                    ...Object.values(spec.ACTION_FIELDS),
                    ...Object.values(spec.SELECTOR_FIELDS),
                ]
                    .flat()
                    .map((field) => field.key),
            ),
        ].map((key) => `sbField_${key}`),
    ];

    test.each([
        ['english', english],
        ['latvian', latvian],
    ])('%s names every builder piece', (language, table) => {
        const missing = keys.filter((key) => typeof table.app[key] !== 'string');
        expect(missing).toEqual([]);
    });
});
