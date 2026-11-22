/**
 * The builder's form table must agree with the validator: every default
 * condition, action and selector it can create validates, and every
 * vocabulary piece is in the table.
 */

import spec = require('../../src/ts/core/scenarios/builderSpec');
import vocabulary = require('../../src/ts/core/scenarios/vocabulary');
const { validateScenario } = require('../../src/ts/core/settings/scenarioSchema') as typeof scenarioSchemaModule;
const { schemaDefaults } = require('../../src/ts/core/settings/defaults') as typeof defaultsModule;
import { invalid } from '../helpers/invalid';
import english = require('../../src/ts/core/translations/english');
import latvian = require('../../src/ts/core/translations/latvian');
import type * as scenarioSchemaModule from '../../src/ts/core/settings/scenarioSchema';
import type * as defaultsModule from '../../src/ts/core/settings/defaults';
import type * as factsModule from '../../src/ts/core/scenarios/facts';

const globalDefaults = schemaDefaults();

// A scenario around the pieces under test: a writer for the "held" memory
// slot the defaults read, and a phase for goto.
const scenarioWith = (
    {
        conditions = [],
        actions = [{ type: 'fillExposure' }],
    }: {
        conditions?: unknown[];
        actions?: unknown[];
    },
    rule: { scope?: 'challenge' | 'installation'; stages?: string[] } = {},
) => ({
    name: 'Spec',
    version: 1,
    start: 'main',
    ...(rule.scope === 'installation' ? { scope: 'installation' as const } : {}),
    phases: {
        main: {
            rules: [
                // The writer feeds the "held" slot the defaults read; `remember` is a challenge action, so an
                // installation scenario has none (its defaults read no slot).
                ...(rule.scope === 'installation'
                    ? []
                    : [{ id: 'writer', do: [{ type: 'remember', slot: 'held', entry: { by: 'bestRank' } }] }]),
                { id: 'subject', ...(rule.stages ? { stages: rule.stages } : {}), if: conditions, do: actions },
            ],
        },
    },
});

const expectValid = (doc: unknown) => {
    const result: { ok: boolean; issues?: unknown[] } = validateScenario(doc, globalDefaults);
    expect(result.issues ?? []).toEqual([]);
};

test.each(spec.CONDITION_TYPES)('the default %s condition validates', (type) => {
    expectValid(scenarioWith({ conditions: [spec.defaultCondition(type)] }));
});

test.each(spec.SELECTOR_TYPES)('the default %s selector validates', (by) => {
    expectValid(scenarioWith({ actions: [{ type: 'boost', entry: spec.defaultSelector(by) }] }));
});

/** The stages of a challenge scenario an action is available in; empty when only an installation scenario has it. */
const homeStages = (type: string) =>
    vocabulary.SCOPE_STAGES.challenge.filter((stage) =>
        (vocabulary.STAGE_ACTIONS[stage] as readonly string[]).includes(type),
    );

test.each(spec.ACTION_TYPES)('the default %s action validates in the stages that offer it', (type) => {
    // runAutomation's default operation (submit) runs while the challenge is active, though the action itself is
    // offered before joining too (with operation join).
    const stages = type === 'runAutomation' ? ['active'] : homeStages(type);
    if (stages.length === 0) {
        // Installation-only actions (claimMissionReward, startAutovote, stopAutovote) run in the account stage.
        expectValid(
            scenarioWith(
                { actions: [spec.defaultAction(type, { phases: ['main'] })] },
                { scope: 'installation', stages: ['account'] },
            ),
        );
        return;
    }
    expectValid(scenarioWith({ actions: [spec.defaultAction(type, { phases: ['main'] })] }, { stages }));
});

test.each(spec.EXPRESSION_KINDS)('the default %s expression validates on both sides of a comparison', (kind) => {
    const context = { phases: ['main'], stages: ['active' as const], settingKeys: ['exposure' as const] };
    const left = spec.defaultExpression(kind, 'any', context);
    expectValid(
        scenarioWith(
            { conditions: [{ type: 'compare', left, op: '=', right: left }] },
            { stages: ['active' as const] },
        ),
    );
});

test('a typed fact with nothing to read in the stages falls back to the clock', () => {
    expect(spec.defaultExpression('fact', 'string', { stages: ['account'] })).toEqual({
        kind: 'fact',
        name: 'clock.now',
    });
});

test('a setting expression with no keys offered falls back to the default key', () => {
    expect(spec.defaultExpression('setting', 'any', {})).toEqual({
        kind: 'setting',
        key: 'exposure',
        view: 'base',
    });
});

test('typed composites keep their own quantity', () => {
    expect(spec.defaultExpression('min', 'votes', {})).toEqual({
        kind: 'min',
        of: [
            { kind: 'literal', value: 0, quantity: 'votes' },
            { kind: 'literal', value: 0, quantity: 'votes' },
        ],
    });
    expect(spec.defaultExpression('add', 'duration', {})).toEqual({
        kind: 'add',
        left: { kind: 'literal', value: 0, quantity: 'duration', unit: 'hours' },
        right: { kind: 'literal', value: 0, quantity: 'duration', unit: 'hours' },
    });
});

test('the default expression of each typed field matches what the field needs', () => {
    // A submit row's instant, a window row's duration and a join's coin limit.
    const instant = spec.defaultExpression('fact', 'instant', { stages: ['active' as const] });
    expectValid(scenarioWith({ conditions: [{ type: 'compare', left: instant, op: '=', right: instant }] }));
    const duration = spec.defaultExpression('literal', 'duration', {});
    expectValid(scenarioWith({ conditions: [{ type: 'compare', left: duration, op: '=', right: duration }] }));
    expect(spec.defaultExpression('literal', 'coins', {})).toEqual({ kind: 'literal', value: 0, quantity: 'coins' });
    expect(spec.defaultExpression('literal', 'list', {})).toEqual({ kind: 'literal', value: [] });
});

test('a fact for a value worked out before the phase applies is a raw one; a rule may use any', () => {
    // A policy fact that gives a count in the active stage exists, and is what a rule could be handed first.
    const { FACTS } = require('../../src/ts/core/scenarios/facts') as typeof factsModule;
    const raw = (name: string) => FACTS[name as keyof typeof FACTS].classification === 'raw';
    const base = spec.defaultExpression('fact', 'count', { stages: ['active'], baseOnly: true }) as { name: string };
    expect(raw(base.name)).toBe(true);
    // A binding's default fact in a stage nothing raw reads in falls back to the clock, which reads everywhere.
    expect(spec.defaultExpression('fact', 'string', { stages: ['account'], baseOnly: true })).toEqual({
        kind: 'fact',
        name: 'clock.now',
    });
    const policyNames = vocabulary.FACT_NAMES.filter(
        (name) => FACTS[name].classification === 'policy' && FACTS[name].stages.includes('active'),
    );
    expect(policyNames.length).toBeGreaterThan(0);
    for (const name of policyNames) expect(spec.factGives(name, 'any')).toBe(true);
});

test.each([
    [{ kind: 'number', quantity: 'percent' }, 'percent'],
    [{ kind: 'number', quantity: 'duration', unit: 'minutes' }, 'duration'],
    [{ kind: 'number', quantity: 'count' }, 'count'],
    [{ kind: 'boolean' }, 'boolean'],
    [{ kind: 'list' }, 'list'],
    [{ kind: 'string' }, 'string'],
    [{ kind: 'enum', values: ['a', 'b'] }, 'string'],
    [{ kind: 'other' }, null],
    [undefined, null],
])('a setting of %j must be given %s by an expression', (descriptor, expected) => {
    expect(spec.expectedOfDescriptor(descriptor as never)).toBe(expected);
});

test('an automation step starts on, and may name, only the operations its stages allow', () => {
    expect(spec.automationOperationsFor(['active'])).toEqual(
        vocabulary.AUTOMATION_OPERATIONS.filter((operation) => operation !== 'join'),
    );
    expect(spec.automationOperationsFor(['preJoin'])).toEqual(['join']);
    expect(spec.automationOperationsFor(['preJoin', 'active'])).toEqual([]);
    expect(spec.defaultAction('runAutomation', { stages: ['preJoin'] })).toEqual({
        type: 'runAutomation',
        operation: 'join',
    });
    expect(spec.defaultAction('runAutomation', { stages: ['active'] })).toEqual({
        type: 'runAutomation',
        operation: 'submit',
    });
    // A rule in two stages has no operation both allow: the step starts on the table's first, which the validator then refuses.
    expect(spec.defaultAction('runAutomation', { stages: ['preJoin', 'active'] })).toEqual({
        type: 'runAutomation',
        operation: 'submit',
    });
    expect(spec.defaultAction('runAutomation', {})).toEqual({ type: 'runAutomation', operation: 'submit' });
});

test('the keys a photo pool replaces are the ones the validator refuses next to it', () => {
    expect([...spec.POOL_REPLACED_KEYS]).toEqual(['chosenPhotos', 'chosenPhotosOnly', 'chosenPhotosInOrder']);
    for (const key of spec.POOL_REPLACED_KEYS) {
        const result = validateScenario(
            {
                version: 1,
                name: 'Plan',
                start: 'main',
                phases: {
                    main: { photoPool: { name: 'Wall' }, settings: { [key]: key === 'chosenPhotos' ? [] : true } },
                },
            },
            globalDefaults,
        );
        expect(JSON.stringify(result)).toContain(`A photo pool replaces ${key}`);
    }
});

test('the kinds of live value for what is expected match what the validator types them as', () => {
    expect(spec.expressionKindsFor('any')).toEqual(spec.EXPRESSION_KINDS);
    for (const plain of ['boolean', 'string', 'list'] as const) {
        expect(spec.expressionKindsFor(plain)).toEqual(['literal', 'fact', 'setting']);
    }
    expect(spec.expressionKindsFor('instant')).toEqual(['literal', 'fact', 'setting', 'offset', 'earlier', 'later']);
    expect(spec.expressionKindsFor('duration')).toEqual([
        'literal',
        'fact',
        'setting',
        'difference',
        'add',
        'subtract',
        'min',
        'max',
    ]);
    expect(spec.expressionKindsFor('percent')).toEqual(['literal', 'fact', 'setting', 'add', 'subtract', 'min', 'max']);
});

test('every composite the table offers for a quantity is one the validator accepts at that quantity', () => {
    const cases = [
        ['instant', 'offset'],
        ['instant', 'earlier'],
        ['instant', 'later'],
        ['duration', 'difference'],
        ['duration', 'add'],
        ['duration', 'subtract'],
        ['duration', 'min'],
        ['duration', 'max'],
        ['percent', 'add'],
        ['percent', 'min'],
    ] as const;
    for (const [quantity, kind] of cases) {
        expect(spec.expressionKindsFor(quantity)).toContain(kind);
        const expression = spec.defaultExpression(kind, quantity, { stages: ['active'] });
        // A condition comparing the expression with itself is valid only when its type is the same on both sides and sound.
        expectValid(
            scenarioWith(
                { conditions: [{ type: 'compare', left: expression, op: '=', right: expression }] },
                { stages: ['active' as const] },
            ),
        );
    }
});

test('a fact expression carries only what its fact takes', () => {
    expect(spec.factExpression('clock.now')).toEqual({ kind: 'fact', name: 'clock.now' });
    expect(spec.factExpression('entry.votes')).toEqual({
        kind: 'fact',
        name: 'entry.votes',
        select: { by: 'slot', index: 1 },
    });
    const chosen = { by: 'memory', slot: 'held' };
    expect(spec.factExpression('entry.votes', { select: chosen, window: '1h' })).toEqual({
        kind: 'fact',
        name: 'entry.votes',
        select: chosen,
    });
    expect(spec.factExpression('entry.votesPerHour', { select: chosen, window: '1h' })).toEqual({
        kind: 'fact',
        name: 'entry.votesPerHour',
        select: chosen,
        window: '1h',
    });
    // No window was there to keep; a name that is no fact (the empty pick) takes nothing.
    expect(spec.factExpression('entry.votesPerHour')).toEqual({
        kind: 'fact',
        name: 'entry.votesPerHour',
        select: { by: 'slot', index: 1 },
    });
    expect(spec.factExpression('', { select: chosen, window: '1h' })).toEqual({ kind: 'fact', name: '' });
});

test('a default fact for a fact over entries is sound on its own', () => {
    const expression = spec.defaultExpression('fact', 'votes', { stages: ['active'] });
    expectValid(
        scenarioWith(
            { conditions: [{ type: 'compare', left: expression, op: '=', right: expression }] },
            { stages: ['active' as const] },
        ),
    );
});

test('every vocabulary piece has a form', () => {
    for (const type of [
        ...vocabulary.NUMERIC_CONDITIONS,
        ...vocabulary.STATE_CONDITIONS,
        ...vocabulary.RANGE_TIME_CONDITIONS,
        ...vocabulary.PRESENCE_CONDITIONS,
        ...vocabulary.LIST_CONDITIONS,
        'compare',
        'entriesWhere',
        'entryCount',
    ]) {
        expect(spec.CONDITION_TYPES).toContain(type);
    }
    for (const by of [
        ...vocabulary.RANKING_SELECTORS,
        'slowest',
        'id',
        'pinned',
        'pendingBoostTarget',
        'newest',
        'oldest',
        'matching',
    ]) {
        expect(spec.SELECTOR_TYPES).toContain(by);
    }
    // Every action any stage offers has a form, and the coin cap joins the currency limits.
    expect([...spec.ACTION_TYPES].sort()).toEqual([...new Set(Object.values(vocabulary.STAGE_ACTIONS).flat())].sort());
    expect(vocabulary.LIMIT_KEYS).toContain('coins');
    expect(spec.ENTRY_FIELDS).toEqual([...vocabulary.NUMERIC_ENTRY_FIELDS, ...vocabulary.BOOLEAN_ENTRY_FIELDS]);
});

test('default field values cover every kind', () => {
    expect(spec.defaultFieldValue({ key: 'goto', kind: 'phase' })).toBe('main');
    expect(spec.defaultFieldValue({ key: 'x', kind: 'number' })).toBe(0);
    expect(spec.defaultFieldValue({ key: 'x', kind: 'entryValue' })).toBe(0);
    expect(spec.defaultFieldValue({ key: 'x', kind: 'boolean' })).toBe(false);
    expect(spec.defaultFieldValue({ key: 'missionId', kind: 'entryId' })).toBe('mission-1');
    expect(spec.defaultFieldValue({ key: 'id', kind: 'photoId' })).toBe('photo-1');
    expect(spec.defaultFieldValue({ key: 'window', kind: 'duration' })).toBe('1h');
    expect(spec.defaultFieldValue({ key: 'power', kind: 'enum', options: ['boost', 'turbo'] })).toBe('boost');
    expect(spec.defaultFieldValue({ key: 'to', kind: 'scenarioRef' })).toBeNull();
    expect(spec.defaultFieldValue({ key: 'name', kind: 'profileRef' })).toBeNull();
    expect(spec.defaultFieldValue({ key: 'where', kind: 'predicates' })).toEqual([
        { field: 'votes', op: '>=', value: 0 },
    ]);
});

test('the boost state condition offers MISSED', () => {
    expect(spec.CONDITION_FIELDS.boostState[0].options).toContain('MISSED');
    expect(english.app.sbState_boost_MISSED).toBe('Missed');
    expect(latvian.app.sbState_boost_MISSED).toBeTruthy();
    expectValid(scenarioWith({ conditions: [{ type: 'boostState', in: ['MISSED'] }] }));
});

describe('translations', () => {
    const keys = [
        ...spec.CONDITION_TYPES.map((type) => `sbCond_${type}`),
        ...spec.ACTION_TYPES.map((type) => `sbAct_${type}`),
        ...spec.SELECTOR_TYPES.map((by) => `sbSel_${by}`),
        ...spec.ENTRY_FIELDS.map((field) => `sbEntryField_${field}`),
        ...spec.EXPRESSION_KINDS.map((kind) => `sbExpr_${kind}`),
        ...vocabulary.QUANTITIES.map((quantity) => `sbQuantity_${quantity}`),
        ...vocabulary.DURATION_UNITS.map((unit) => `sbUnit_${unit}`),
        ...vocabulary.SCENARIO_STAGES.map((stage) => `sbStage_${stage}`),
        ...vocabulary.SETTING_VIEWS.map((view) => `sbView_${view}`),
        // Every 'enum' field's options, named by the field's label prefix.
        ...[
            ...new Set(
                [
                    ...Object.values(spec.CONDITION_FIELDS),
                    ...Object.values(spec.ACTION_FIELDS),
                    ...Object.values(spec.SELECTOR_FIELDS),
                ]
                    .flat()
                    .flatMap((field) =>
                        field.kind === 'enum'
                            ? (field.options as string[]).map((option) => `sbOpt_${field.labels}_${option}`)
                            : [],
                    ),
            ),
        ],
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
        const missing = keys.filter((key) => typeof (table.app as Record<string, string>)[key] !== 'string');
        expect(missing).toEqual([]);
    });
});

// The memory slots each action reads and writes, as the runner's queue progress sees them.
describe('actionMemory', () => {
    test.each([
        [
            'enterPhoto',
            invalid({ type: 'enterPhoto', photo: { memory: 'held' }, remember: 'kept' }),
            { reads: ['held'], writes: ['kept'] },
        ],
        [
            'swap',
            invalid({
                type: 'swap',
                entry: { by: 'memory', slot: 'held' },
                with: { memory: 'fresh' },
                rememberRemoved: 'old',
                rememberAdded: 'new',
            }),
            { reads: ['held', 'fresh'], writes: ['old', 'new'] },
        ],
        [
            'remember',
            invalid({ type: 'remember', slot: 'kept', entry: { by: 'memory', slot: 'held' } }),
            { reads: ['held'], writes: ['kept'] },
        ],
        ['boost', invalid({ type: 'boost', entry: { by: 'memory', slot: 'held' } }), { reads: ['held'], writes: [] }],
        ['vote', invalid({ type: 'vote', toExposure: 50 }), { reads: [], writes: [] }],
    ])('%s reads and writes its slots', (_name, action, expected) => {
        expect(vocabulary.actionMemory(invalid<Parameters<typeof vocabulary.actionMemory>[0]>(action))).toEqual(
            expected,
        );
    });
});
