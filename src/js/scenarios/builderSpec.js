// @ts-check
/**
 * The scenario builder's form description: for every condition, action and
 * entry selector, which fields it has and what kind of input each needs. The
 * GUI builder (react/components/app/scenarioBuilder/) renders any of them
 * from this table, so a new vocabulary piece needs a line here and a
 * translation — no new component. A test (tests/scenarios/builderSpec.test.js)
 * checks every default below against the real validator, so the table and
 * settings/scenarioSchema.js cannot drift apart.
 *
 * Field kinds: op, number, percent, duration, time, states, currency, slot,
 * phase, selector, photoSource, entryField, entryValue, boolean, text,
 * slotIndex, conditions (a nested list), condition (one nested condition).
 * `optional` fields can be left empty; they are then left out of the document.
 *
 * Dependency-free: renderer-safe.
 */

const vocabulary = require('./vocabulary');

/** @typedef {{key: string, kind: string, optional?: boolean, options?: string[]}} FieldSpec */

const BOOST_STATES = ['LOCKED', 'AVAILABLE', 'AVAILABLE_KEY', 'USED', 'UNAVAILABLE'];
const TURBO_STATES = ['FREE', 'IN_PROGRESS', 'TIMER', 'WON', 'LOCKED', 'USED'];

const range = (/** @type {string} */ kind) => [
    { key: 'min', kind, optional: true },
    { key: 'max', kind, optional: true },
];
const compared = [
    { key: 'op', kind: 'op' },
    { key: 'value', kind: 'number' },
];

/** @type {Record<string, FieldSpec[]>} */
const CONDITION_FIELDS = {
    dailyWindow: [
        { key: 'from', kind: 'time' },
        { key: 'to', kind: 'time' },
    ],
    beforeEnd: range('duration'),
    afterStart: range('duration'),
    inPhaseFor: range('duration'),
    elapsedPercent: range('percent'),
    ...Object.fromEntries(vocabulary.NUMERIC_CONDITIONS.map((type) => [type, compared])),
    boostState: [{ key: 'in', kind: 'states', options: BOOST_STATES }],
    turboState: [{ key: 'in', kind: 'states', options: TURBO_STATES }],
    balance: [{ key: 'currency', kind: 'currency' }, ...compared],
    memorySet: [{ key: 'slot', kind: 'slot' }],
    entry: [
        { key: 'select', kind: 'selector' },
        { key: 'field', kind: 'entryField' },
        { key: 'op', kind: 'op' },
        { key: 'value', kind: 'entryValue' },
        { key: 'window', kind: 'duration', optional: true },
    ],
    all: [{ key: 'of', kind: 'conditions' }],
    any: [{ key: 'of', kind: 'conditions' }],
    not: [{ key: 'condition', kind: 'condition' }],
};

const target = { key: 'entry', kind: 'selector' };

/** @type {Record<string, FieldSpec[]>} */
const ACTION_FIELDS = {
    enterPhoto: [
        { key: 'photo', kind: 'photoSource' },
        { key: 'remember', kind: 'slot', optional: true },
    ],
    swap: [
        target,
        { key: 'with', kind: 'photoSource' },
        { key: 'rememberRemoved', kind: 'slot', optional: true },
        { key: 'rememberAdded', kind: 'slot', optional: true },
    ],
    boost: [target],
    turbo: [target],
    unlockBoost: [],
    fillExposure: [],
    vote: [{ key: 'toExposure', kind: 'percent' }],
    remember: [{ key: 'slot', kind: 'slot' }, target],
    forget: [{ key: 'slot', kind: 'slot' }],
    goto: [{ key: 'phase', kind: 'phase' }],
    notify: [{ key: 'message', kind: 'text' }],
};

const skipProtected = { key: 'skipProtected', kind: 'boolean', optional: true };

/** @type {Record<string, FieldSpec[]>} */
const SELECTOR_FIELDS = {
    slot: [{ key: 'index', kind: 'slotIndex' }],
    memory: [{ key: 'slot', kind: 'slot' }],
    fastest: [{ key: 'window', kind: 'duration', optional: true }, skipProtected],
    ...Object.fromEntries(vocabulary.RANKING_SELECTORS.map((by) => [by, [skipProtected]])),
};

const ENTRY_FIELDS = [...vocabulary.NUMERIC_ENTRY_FIELDS, ...vocabulary.BOOLEAN_ENTRY_FIELDS];

/**
 * A fresh value for a field kind. `phases` supplies the default goto target.
 *
 * @param {FieldSpec} field
 * @param {{phases?: string[]}} [context]
 * @returns {unknown}
 */
const defaultFieldValue = (field, context = {}) => {
    switch (field.kind) {
        case 'op':
            return '>=';
        case 'percent':
            return 50;
        case 'duration':
            return '1h';
        case 'time':
            return field.key === 'to' ? '08:00' : '06:00';
        case 'states':
            return [/** @type {string[]} */ (field.options)[1]];
        case 'currency':
            return 'swaps';
        case 'slot':
            return 'held';
        case 'phase':
            return context.phases?.[0] ?? 'main';
        case 'selector':
            return { by: 'bestRank' };
        case 'photoSource':
            return 'best';
        case 'entryField':
            return 'votes';
        case 'boolean':
            return false;
        case 'text':
            return 'Check the challenge';
        case 'slotIndex':
            return 1;
        case 'conditions':
            return [{ type: 'exposure', op: '<', value: 50 }];
        case 'condition':
            return { type: 'exposure', op: '<', value: 50 };
        default:
            // number, entryValue
            return 0;
    }
};

/**
 * Bounds a new range condition starts with — a range needs at least one.
 *
 * @type {Record<string, Record<string, unknown>>}
 */
const RANGE_DEFAULTS = {
    beforeEnd: { max: '1d' },
    afterStart: { min: '1d' },
    inPhaseFor: { min: '4m' },
    elapsedPercent: { min: 50 },
};

/**
 * @param {Record<string, FieldSpec[]>} table
 * @param {string} discriminator - 'type' or 'by'
 * @param {string} name
 * @param {{phases?: string[]}} [context]
 */
const defaultOf = (table, discriminator, name, context) => {
    /** @type {Record<string, unknown>} */
    const item = { [discriminator]: name };
    for (const field of table[name]) {
        if (!field.optional) item[field.key] = defaultFieldValue(field, context);
    }
    return { ...item, ...RANGE_DEFAULTS[name] };
};

/** @param {string} type @param {{phases?: string[]}} [context] */
const defaultCondition = (type, context) => defaultOf(CONDITION_FIELDS, 'type', type, context);
/** @param {string} type @param {{phases?: string[]}} [context] */
const defaultAction = (type, context) => defaultOf(ACTION_FIELDS, 'type', type, context);
/** @param {string} by */
const defaultSelector = (by) => defaultOf(SELECTOR_FIELDS, 'by', by);

module.exports = {
    CONDITION_FIELDS,
    ACTION_FIELDS,
    SELECTOR_FIELDS,
    ENTRY_FIELDS,
    BOOST_STATES,
    TURBO_STATES,
    CONDITION_TYPES: Object.keys(CONDITION_FIELDS),
    ACTION_TYPES: Object.keys(ACTION_FIELDS),
    SELECTOR_TYPES: Object.keys(SELECTOR_FIELDS),
    defaultFieldValue,
    defaultCondition,
    defaultAction,
    defaultSelector,
};
