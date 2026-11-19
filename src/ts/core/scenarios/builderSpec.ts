/**
 * The scenario builder's form description: for every condition, action and
 * entry selector, which fields it has and what kind of input each needs. The
 * GUI builder (react/components/app/scenarioBuilder/) renders any of them
 * from this table, so a new vocabulary piece needs a line here and a
 * translation — no new component. A test (tests/scenarios/builderSpec.test.ts)
 * checks every default below against the real validator, so the table and
 * settings/scenarioSchema.ts cannot drift apart.
 *
 * Field kinds: op, number, percent, duration, time, states, currency, slot,
 * phase, selector, photoSource, entryField, entryValue, boolean, text,
 * slotIndex, conditions (a nested list), condition (one nested condition),
 * expression (a live value), predicates (a list of entry tests), enum (one of
 * a fixed list), settingKey (a key the scope may write), scenarioRef (a stored
 * scenario or none), profileRef (a saved profile or none), photoId, and
 * settingValue (a literal or a live value). `optional` fields can be left
 * empty; they are then left out of the document. An `expression` field may
 * name the `quantity` (or boolean / string / list) its value must give.
 *
 * Dependency-free: renderer-safe.
 */

import * as vocabulary from './vocabulary';
import { FACTS } from './facts';
import { exprTypeOfDescriptor } from './expressions';

import type { Quantity } from '../types/scenario';
import type { ScenarioValueDescriptor } from '../types/settings';

export type FieldSpec = {
    key: string;
    kind: string;
    optional?: boolean;
    options?: string[];
    labels?: string;
    /** For an `expression` field: what its value must give (a quantity, or boolean / string / list). */
    quantity?: string;
};

/** What a form's defaults need to know: the phases a goto may name, the stages the rule runs in, the keys it may write. */
type BuilderFieldContext = {
    phases?: string[];
    stages?: readonly string[];
    settingKeys?: readonly string[];
    /** The expression is worked out before a phase's overlay exists (a binding, a schedule): raw facts and base settings only. */
    baseOnly?: boolean;
};

const BOOST_STATES = ['LOCKED', 'MISSED', 'AVAILABLE', 'AVAILABLE_KEY', 'USED', 'UNAVAILABLE'];
const TURBO_STATES = ['FREE', 'IN_PROGRESS', 'TIMER', 'WON', 'LOCKED', 'USED'];

const range = (kind: string) => [
    { key: 'min', kind, optional: true },
    { key: 'max', kind, optional: true },
];
const compared = [
    { key: 'op', kind: 'op' },
    { key: 'value', kind: 'number' },
];
/** Two live values against each other (the same quantity, or equal kinds with = / !=). */
const comparedLive = [
    { key: 'left', kind: 'expression' },
    { key: 'op', kind: 'op' },
    { key: 'right', kind: 'expression' },
];
/** One expression tested for a value of its own (`present` / `absent`). */
const ofExpression = [{ key: 'value', kind: 'expression' }];
/** A list expression and the string (or list of strings) it is tested for. */
const listAndValue = (valueKind: 'string' | 'list') => [
    { key: 'list', kind: 'expression', quantity: 'list' },
    { key: 'value', kind: 'expression', quantity: valueKind },
];
const predicates = [{ key: 'where', kind: 'predicates' }];
const power = { key: 'power', kind: 'enum', options: [...vocabulary.PINNED_POWERS], labels: 'power' };

const CONDITION_FIELDS: Record<string, FieldSpec[]> = {
    dailyWindow: [
        { key: 'from', kind: 'time' },
        { key: 'to', kind: 'time' },
    ],
    beforeEnd: range('duration'),
    afterStart: range('duration'),
    inPhaseFor: range('duration'),
    elapsedPercent: range('percent'),
    ...Object.fromEntries(vocabulary.NUMERIC_CONDITIONS.map((type) => [type, compared])),
    boostState: [{ key: 'in', kind: 'states', options: BOOST_STATES, labels: 'boost' }],
    turboState: [{ key: 'in', kind: 'states', options: TURBO_STATES, labels: 'turbo' }],
    balance: [{ key: 'currency', kind: 'currency' }, ...compared],
    memorySet: [{ key: 'slot', kind: 'slot' }],
    entry: [
        { key: 'select', kind: 'selector' },
        { key: 'field', kind: 'entryField' },
        { key: 'op', kind: 'op' },
        { key: 'value', kind: 'entryValue' },
        { key: 'window', kind: 'duration', optional: true },
    ],
    compare: comparedLive,
    ...Object.fromEntries(vocabulary.PRESENCE_CONDITIONS.map((type) => [type, ofExpression])),
    ...Object.fromEntries(
        vocabulary.LIST_CONDITIONS.map((type) => [type, listAndValue(type === 'contains' ? 'string' : 'list')]),
    ),
    entriesWhere: [{ key: 'quantifier', kind: 'enum', options: ['any', 'all'], labels: 'quantifier' }, ...predicates],
    entryCount: [...predicates, { key: 'op', kind: 'op' }, { key: 'value', kind: 'number' }],
    all: [{ key: 'of', kind: 'conditions' }],
    any: [{ key: 'of', kind: 'conditions' }],
    not: [{ key: 'condition', kind: 'condition' }],
};

const target = { key: 'entry', kind: 'selector' };

const ACTION_FIELDS: Record<string, FieldSpec[]> = {
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
    join: [{ key: 'maxCoins', kind: 'expression', optional: true, quantity: 'coins' }],
    claimChallengeReward: [],
    claimMissionReward: [{ key: 'missionId', kind: 'entryId' }],
    earnTurbo: [],
    runAutomation: [
        { key: 'operation', kind: 'enum', options: [...vocabulary.AUTOMATION_OPERATIONS], labels: 'automation' },
    ],
    setSetting: [
        { key: 'key', kind: 'settingKey' },
        { key: 'value', kind: 'settingValue' },
    ],
    clearSetting: [{ key: 'key', kind: 'settingKey' }],
    useProfile: [{ key: 'name', kind: 'profileRef' }],
    setPin: [power, target],
    clearPin: [power],
    pauseScenario: [{ key: 'reason', kind: 'text', optional: true }],
    handoffScenario: [{ key: 'to', kind: 'scenarioRef' }],
    startAutovote: [],
    stopAutovote: [],
};

const skipProtected = { key: 'skipProtected', kind: 'boolean', optional: true };

const SELECTOR_FIELDS: Record<string, FieldSpec[]> = {
    slot: [{ key: 'index', kind: 'slotIndex' }],
    memory: [{ key: 'slot', kind: 'slot' }],
    fastest: [{ key: 'window', kind: 'duration', optional: true }, skipProtected],
    slowest: [{ key: 'window', kind: 'duration', optional: true }, skipProtected],
    ...Object.fromEntries(vocabulary.RANKING_SELECTORS.map((by) => [by, [skipProtected]])),
    id: [{ key: 'id', kind: 'photoId' }],
    pinned: [power],
    pendingBoostTarget: [],
    newest: [{ key: 'time', kind: 'enum', options: [...vocabulary.ENTRY_TIME_MODES], labels: 'entryTime' }],
    oldest: [{ key: 'time', kind: 'enum', options: [...vocabulary.ENTRY_TIME_MODES], labels: 'entryTime' }],
    matching: [
        ...predicates,
        { key: 'order', kind: 'enum', options: [...vocabulary.MATCH_ORDERS], labels: 'matchOrder' },
        { key: 'direction', kind: 'enum', options: [...vocabulary.ORDER_DIRECTIONS], labels: 'orderDirection' },
    ],
};

const ENTRY_FIELDS = [...vocabulary.NUMERIC_ENTRY_FIELDS, ...vocabulary.BOOLEAN_ENTRY_FIELDS];

/** Every kind a live value (an expression) can be built from. */
const EXPRESSION_KINDS = [
    'literal',
    'fact',
    'setting',
    'offset',
    'difference',
    'add',
    'subtract',
    'earlier',
    'later',
    'min',
    'max',
] as const;

/** The kinds that hold other expressions. */
const COMPOSITE_KINDS = new Set(['offset', 'difference', 'add', 'subtract', 'earlier', 'later', 'min', 'max']);

/** The settings each dynamic schedule replaces (scenarioSchema/semantics.ts SCHEDULE_REPLACED_KEYS). */
const SCHEDULE_REPLACED_KEYS = {
    submit: ['autoSubmitSchedule'],
    vote: ['scheduledFillTime', 'scheduledFillBeforeEnd', 'scheduledFillWindowMinutes'],
    pause: ['votingPauseTime', 'votingPauseBeforeEnd', 'votingPauseDurationMinutes'],
} as const;

/** The Chosen Photos settings a phase's photo pool replaces (scenarioSchema/semantics.ts POOL_REPLACED_KEYS). */
const POOL_REPLACED_KEYS = ['chosenPhotos', 'chosenPhotosOnly', 'chosenPhotosInOrder'] as const;

/**
 * The normal operations a runAutomation step may name in a rule that runs in `stages`: join before joining only, the rest
 * while active (scenarioSchema/semantics.ts automationIssues).
 */
const automationOperationsFor = (stages: readonly string[]): string[] =>
    vocabulary.AUTOMATION_OPERATIONS.filter((operation) =>
        stages.every((stage) => stage === (operation === 'join' ? 'preJoin' : 'active')),
    );

/** Most rows a submit schedule holds (scenarioSchema/shapes.ts SUBMIT_SCHEDULE_ROWS). */
const SUBMIT_MAX_ROWS = 4;

/** The fallback key a setSetting or a setting expression starts on. */
const DEFAULT_SETTING_KEY = 'exposure';

/**
 * A fresh value for a field kind. `context` supplies the default goto target,
 * the rule's stages and the keys its scope may write.
 */
const defaultFieldValue = (field: FieldSpec, context: BuilderFieldContext = {}): unknown => {
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
            return [(field.options as string[])[1]];
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
        case 'enum':
            // An automation step starts on an operation its rule's stages allow.
            return field.labels === 'automation' && context.stages !== undefined
                ? (automationOperationsFor(context.stages)[0] ?? (field.options as string[])[0])
                : (field.options as string[])[0];
        case 'settingKey':
            return context.settingKeys?.[0] ?? DEFAULT_SETTING_KEY;
        case 'scenarioRef':
        case 'profileRef':
            return null;
        case 'photoId':
        case 'entryId':
            // A plain id shape (letters, digits, ".", ":", "-", "_") the validator accepts as-is.
            return field.kind === 'photoId' ? 'photo-1' : 'mission-1';
        case 'predicates':
            return [{ field: 'votes', op: '>=', value: 0 }];
        case 'settingValue':
            // A number the fallback key takes; the editor re-makes it when the user picks a key.
            return 10;
        case 'expression':
            return defaultExpression('literal', (field.quantity as ExprExpected) ?? 'any', context);
        default:
            // number, entryValue
            return 0;
    }
};

/**
 * Bounds a new range condition starts with — a range needs at least one.
 */
const RANGE_DEFAULTS: Record<string, Record<string, unknown>> = {
    beforeEnd: { max: '1d' },
    afterStart: { min: '1d' },
    inPhaseFor: { min: '4m' },
    elapsedPercent: { min: 50 },
};

/**
 * @param discriminator - 'type' or 'by'
 */
const defaultOf = (
    table: Record<string, FieldSpec[]>,
    discriminator: string,
    name: string,
    context?: BuilderFieldContext,
) => {
    const item: Record<string, unknown> = { [discriminator]: name };
    for (const field of table[name]) {
        if (!field.optional) item[field.key] = defaultFieldValue(field, context);
    }
    return { ...item, ...RANGE_DEFAULTS[name] };
};

const defaultCondition = (type: string, context?: BuilderFieldContext) =>
    defaultOf(CONDITION_FIELDS, 'type', type, context);
const defaultAction = (type: string, context?: BuilderFieldContext) => defaultOf(ACTION_FIELDS, 'type', type, context);
const defaultSelector = (by: string) => defaultOf(SELECTOR_FIELDS, 'by', by);

/** What an expression's default must give: a quantity, one of the plain kinds, or anything. */
type ExprExpected = 'any' | 'boolean' | 'string' | 'list' | Quantity;

/** The quantity a plain `expected` leaves the literal in; a number wants a real quantity. */
const literalQuantity = (expected: ExprExpected): Quantity =>
    expected === 'any' || expected === 'boolean' || expected === 'string' || expected === 'list' ? 'count' : expected;

/**
 * A fresh expression of `kind` that gives what `expected` names. The stages and
 * setting keys come from the builder's context; a fact or setting the context
 * has nothing for falls back to the first of its kind, and the validator is
 * still the judge on save.
 */
const defaultExpression = (
    kind: (typeof EXPRESSION_KINDS)[number],
    expected: ExprExpected,
    context: BuilderFieldContext,
): unknown => {
    const stages = context.stages ?? vocabulary.DEFAULT_STAGES.challenge;
    switch (kind) {
        case 'literal':
            if (expected === 'boolean') return { kind: 'literal', value: false };
            if (expected === 'string') return { kind: 'literal', value: '' };
            if (expected === 'list') return { kind: 'literal', value: [] };
            return {
                kind: 'literal',
                value: 0,
                quantity: literalQuantity(expected),
                ...(expected === 'duration' ? { unit: 'hours' as const } : {}),
            };
        case 'fact':
            return factExpression(defaultFactName(expected, stages, context.baseOnly === true));
        case 'setting':
            return { kind: 'setting', key: context.settingKeys?.[0] ?? DEFAULT_SETTING_KEY, view: 'base' };
        case 'offset':
            return {
                kind: 'offset',
                from: defaultExpression('fact', 'instant', context),
                by: defaultExpression('literal', 'duration', context),
                direction: 'before',
            };
        case 'difference':
            return {
                kind: 'difference',
                from: defaultExpression('fact', 'instant', context),
                to: defaultExpression('fact', 'instant', context),
            };
        case 'add':
        case 'subtract':
            return {
                kind,
                left: defaultExpression('literal', expected === 'any' ? 'duration' : expected, context),
                right: defaultExpression('literal', expected === 'any' ? 'duration' : expected, context),
            };
        case 'earlier':
        case 'later':
            return {
                kind,
                of: [defaultExpression('fact', 'instant', context), defaultExpression('fact', 'instant', context)],
            };
        case 'min':
        case 'max':
            return {
                kind,
                of: [defaultExpression('literal', expected, context), defaultExpression('literal', expected, context)],
            };
    }
};

/**
 * A fact expression made from what its fact supports: the select a fact over entries needs, and the window one that takes
 * it may keep (`previous`: the expression it replaces). A field the new fact does not take is never carried over.
 */
const factExpression = (name: string, previous: Record<string, unknown> = {}): Record<string, unknown> => {
    // The empty pick ("choose") names no fact: it asks for nothing a fact takes.
    const definition = Object.hasOwn(FACTS, name) ? FACTS[name as keyof typeof FACTS] : undefined;
    return {
        kind: 'fact',
        name,
        ...(definition?.takesSelect ? { select: previous.select ?? defaultSelector('slot') } : {}),
        ...(definition?.takesWindow && previous.window !== undefined ? { window: previous.window } : {}),
    };
};

/**
 * The kinds of live value that can give what `expected` names (the validator's typing: an offset gives an instant, a difference a
 * duration, earlier / later an instant, the arithmetic and min / max a quantity as they were given). A boolean, a text or a list
 * is a literal, a fact or a setting only.
 */
const expressionKindsFor = (expected: ExprExpected): readonly (typeof EXPRESSION_KINDS)[number][] => {
    switch (expected) {
        case 'any':
            return EXPRESSION_KINDS;
        case 'boolean':
        case 'string':
        case 'list':
            return ['literal', 'fact', 'setting'];
        case 'instant':
            return ['literal', 'fact', 'setting', 'offset', 'earlier', 'later'];
        case 'duration':
            return ['literal', 'fact', 'setting', 'difference', 'add', 'subtract', 'min', 'max'];
        default:
            return ['literal', 'fact', 'setting', 'add', 'subtract', 'min', 'max'];
    }
};

/** The first fact of `expected`'s type that runs in every stage given; `clock.now` when none is (it runs everywhere). */
const defaultFactName = (expected: ExprExpected, stages: readonly string[], baseOnly: boolean): string => {
    for (const name of vocabulary.FACT_NAMES) {
        if (
            factGives(name, expected) &&
            (!baseOnly || FACTS[name].classification === 'raw') &&
            stages.every((stage) => FACTS[name].stages.includes(stage as never))
        ) {
            return name;
        }
    }
    return 'clock.now';
};

/** Whether a fact gives what `expected` names: a number its quantity, any other value its kind. */
const factGives = (name: (typeof vocabulary.FACT_NAMES)[number], expected: ExprExpected): boolean => {
    if (expected === 'any') return true;
    const definition = FACTS[name];
    return definition.kind === 'number' ? definition.quantity === expected : definition.kind === expected;
};

/**
 * What an expression for a setting must give, from the setting's value descriptor (the validator's own reading of it):
 * a number its quantity, a boolean / list its kind, a string or an enum a string. Null for a setting with no
 * expression form.
 */
const expectedOfDescriptor = (descriptor: ScenarioValueDescriptor | undefined): ExprExpected | null => {
    const type = descriptor === undefined ? null : exprTypeOfDescriptor(descriptor);
    if (type === null) return null;
    return type.kind === 'number' ? type.quantity : type.kind;
};

const CONDITION_TYPES = Object.keys(CONDITION_FIELDS);
const ACTION_TYPES = Object.keys(ACTION_FIELDS);
const SELECTOR_TYPES = Object.keys(SELECTOR_FIELDS);
export {
    CONDITION_TYPES,
    ACTION_TYPES,
    SELECTOR_TYPES,
    CONDITION_FIELDS,
    ACTION_FIELDS,
    SELECTOR_FIELDS,
    ENTRY_FIELDS,
    EXPRESSION_KINDS,
    COMPOSITE_KINDS,
    SCHEDULE_REPLACED_KEYS,
    POOL_REPLACED_KEYS,
    automationOperationsFor,
    SUBMIT_MAX_ROWS,
    DEFAULT_SETTING_KEY,
    defaultFieldValue,
    defaultCondition,
    defaultAction,
    defaultSelector,
    defaultExpression,
    expectedOfDescriptor,
    factGives,
    factExpression,
    expressionKindsFor,
};
export type { ExprExpected };
