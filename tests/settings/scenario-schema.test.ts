/**
 * Scenario document validation — the trust boundary for shared scenario
 * files: strict shapes, bounded names, per-challenge-only phase settings,
 * resolvable references, and readable error paths.
 */

import type * as scenarioSchemaModule from '../../src/ts/core/settings/scenarioSchema';
import type * as defaultsModule from '../../src/ts/core/settings/defaults';

const { validateScenario, parseScenarioJson, formatPath } =
    require('../../src/ts/core/settings/scenarioSchema') as typeof scenarioSchemaModule;
const { schemaDefaults } = require('../../src/ts/core/settings/defaults') as typeof defaultsModule;

const globalDefaults = schemaDefaults();

type Accepted = Extract<ReturnType<typeof validateScenario>, { ok: true }>;
type Refused = Extract<ReturnType<typeof validateScenario>, { ok: false }>;
type ParseRefused = Extract<ReturnType<typeof parseScenarioJson>, { ok: false }>;

const doc = (overrides = {}) => ({
    name: 'Plan',
    version: 1,
    start: 'main',
    phases: { main: { rules: [{ do: [{ type: 'fillExposure' }] }] } },
    ...overrides,
});

/** A scenario whose only rule has these conditions / actions. */
const withRule = (rule: Record<string, unknown>) =>
    doc({ phases: { main: { rules: [{ do: [{ type: 'fillExposure' }], ...rule }] } } });

const validate = (input: unknown, defaults: Record<string, unknown> = globalDefaults) =>
    validateScenario(input, defaults);

const issuesOf = (input: unknown, defaults?: Record<string, unknown>) => {
    const result = validate(input, defaults);
    expect(result.ok).toBe(false);
    return (result as Refused).issues;
};

const expectIssue = (input: unknown, path: string, message: string) => {
    expect(issuesOf(input)).toEqual(
        expect.arrayContaining([expect.objectContaining({ path, message: expect.stringContaining(message) })]),
    );
};

describe('validateScenario — accepted documents', () => {
    test('a minimal scenario validates and gets a generated rule id', () => {
        const result = validate(doc());
        expect(result.ok).toBe(true);
        expect((result as Accepted).scenario.phases.main.rules![0].id).toBe('main-1');
    });

    test('trims the name', () => {
        expect((validate(doc({ name: '  Izstāde (plan)  ' })) as Accepted).scenario.name).toBe('Izstāde (plan)');
    });

    test('every condition type is accepted', () => {
        const conditions = [
            { type: 'dailyWindow', from: '22:00', to: '02:00' },
            { type: 'beforeEnd', min: '1h', max: '5d' },
            { type: 'afterStart', min: 60 },
            { type: 'inPhaseFor', max: '4m' },
            { type: 'elapsedPercent', min: 10, max: 90 },
            { type: 'entries', op: '<', value: 3 },
            { type: 'freeSlots', op: '>=', value: 1 },
            { type: 'exposure', op: '<=', value: 50 },
            { type: 'challengeRank', op: '=', value: 1 },
            { type: 'challengeVotes', op: '!=', value: 0 },
            { type: 'boostState', in: ['AVAILABLE', 'AVAILABLE_KEY'] },
            { type: 'turboState', in: ['WON'] },
            { type: 'balance', currency: 'swaps', op: '>', value: 0 },
            { type: 'entry', select: { by: 'slot', index: 0 }, field: 'votes', op: '>', value: 10 },
            {
                type: 'entry',
                select: { by: 'fastest', window: '6h' },
                field: 'speedRatio',
                op: '>=',
                value: 2,
                window: '6h',
            },
            {
                type: 'entry',
                select: { by: 'fewestVotes', skipProtected: true },
                field: 'boosted',
                op: '=',
                value: true,
            },
            { type: 'not', condition: { type: 'exposure', op: '>', value: 90 } },
            { type: 'any', of: [{ type: 'all', of: [{ type: 'entries', op: '>', value: 0 }] }] },
        ];
        expect(validate(withRule({ if: conditions, repeat: 'oncePerPhase', label: 'x' })).ok).toBe(true);
    });

    test('every action type is accepted', () => {
        const actions = [
            { type: 'enterPhoto', photo: 'best', remember: 'held' },
            { type: 'enterPhoto', photo: { memory: 'held' } },
            { type: 'swap', entry: { by: 'mostVotes' }, with: 'best', rememberRemoved: 'out', rememberAdded: 'in' },
            { type: 'swap', entry: { by: 'memory', slot: 'in' }, with: { memory: 'out' } },
            { type: 'boost', entry: { by: 'bestRank' } },
            { type: 'turbo', entry: { by: 'worstRank' } },
            { type: 'unlockBoost' },
            { type: 'fillExposure' },
            { type: 'vote', toExposure: 100 },
            { type: 'remember', slot: 'top', entry: { by: 'boosted' } },
            { type: 'forget', slot: 'top' },
            { type: 'goto', phase: 'main' },
            { type: 'notify', message: 'Held photo is out' },
        ];
        const input = doc({
            phases: {
                main: {
                    rules: [
                        { do: actions.slice(0, 6) },
                        { do: actions.slice(6), if: [{ type: 'memorySet', slot: 'top' }] },
                    ],
                },
            },
        });
        expect(validate(input).ok).toBe(true);
    });

    test('a rule has at most 10 actions', () => {
        expectIssue(
            withRule({ do: Array.from({ length: 11 }, () => ({ type: 'fillExposure' })) }),
            'phases.main.rules[0].do',
            '',
        );
    });

    test('keeps given rule ids and never generates a duplicate', () => {
        const result = validate(
            doc({
                phases: {
                    main: {
                        rules: [{ do: [{ type: 'fillExposure' }] }, { id: 'main-1', do: [{ type: 'unlockBoost' }] }],
                    },
                },
            }),
        );
        expect((result as Accepted).scenario.phases.main.rules!.map((r) => r.id)).toEqual(['main-1-2', 'main-1']);
    });

    test('a phase with valid paired settings validates', () => {
        const input = doc({ phases: { main: { settings: { exposure: 10, exposureTarget: 12, autoSubmit: false } } } });
        expect(validate(input).ok).toBe(true);
    });
});

describe('validateScenario — expressions and expression conditions', () => {
    const hours = (value: number) => ({ kind: 'literal', value, quantity: 'duration', unit: 'hours' });
    const instant = (value: number) => ({ kind: 'literal', value, quantity: 'instant' });
    const count = (value: number, quantity = 'keys') => ({ kind: 'literal', value, quantity });
    const fact = (name: string, extra: Record<string, unknown> = {}) => ({ kind: 'fact', name, ...extra });
    const setting = (key: string, view = 'base') => ({ kind: 'setting', key, view });
    const compare = (left: unknown, right: unknown, op = '<') => ({ type: 'compare', left, op, right });
    const ruleWith = (condition: unknown) => withRule({ if: [condition] });
    const IF = 'phases.main.rules[0].if[0]';

    const issue94 = {
        kind: 'earlier',
        of: [
            { kind: 'offset', from: fact('challenge.end'), by: hours(10), direction: 'before' },
            { kind: 'offset', from: fact('boost.freeExpiry'), by: hours(1), direction: 'before' },
        ],
    };

    test('every new condition form and expression kind is accepted', () => {
        const conditions = [
            compare(issue94, fact('clock.now')),
            compare(fact('challenge.timeLeft'), hours(2), '<='),
            compare(setting('boostTime', 'effective'), hours(1), '>'),
            compare(fact('boost.state'), { kind: 'literal', value: 'AVAILABLE' }, '='),
            compare(fact('challenge.tags'), { kind: 'literal', value: ['a'] }, '!='),
            compare({ kind: 'literal', value: true }, setting('autoBoost'), '='),
            compare({ kind: 'difference', from: fact('clock.now'), to: fact('challenge.end') }, hours(1)),
            compare({ kind: 'add', left: count(1), right: count(2) }, { kind: 'max', of: [count(1), count(2)] }),
            compare(
                { kind: 'subtract', left: fact('challenge.end'), right: hours(1) },
                { kind: 'later', of: [instant(1), instant(2)] },
            ),
            compare({ kind: 'min', of: [fact('balance.keys'), count(5)] }, count(3)),
            compare(
                fact('entry.votesPerHour', { select: { by: 'fastest', window: '2h' }, window: '2h' }),
                { kind: 'literal', value: 3, quantity: 'votesPerHour' },
                '>=',
            ),
            { type: 'present', value: fact('boost.freeExpiry') },
            { type: 'absent', value: fact('boost.freeExpiry') },
            { type: 'contains', list: fact('challenge.tags'), value: { kind: 'literal', value: 'sea' } },
            { type: 'containsAny', list: fact('challenge.tags'), value: { kind: 'literal', value: ['sea'] } },
            { type: 'containsAll', list: setting('mustIncludeTags'), value: { kind: 'literal', value: ['sea'] } },
            {
                type: 'entriesWhere',
                quantifier: 'any',
                where: [{ field: 'rank', op: '<=', value: 3 }],
            },
            {
                type: 'entryCount',
                where: [
                    { field: 'votes', op: '>=', value: 10 },
                    { field: 'boosted', op: '=', value: true },
                ],
                op: '>=',
                value: 1,
            },
            { type: 'not', condition: { type: 'present', value: fact('boost.freeExpiry') } },
        ];
        for (const condition of conditions)
            expect(validate(ruleWith(condition))).toEqual(expect.objectContaining({ ok: true }));
    });

    test('a document with a new condition keeps the condition as written', () => {
        const result = validate(ruleWith(compare(issue94, fact('clock.now')))) as Accepted;
        expect(result.scenario.phases.main.rules![0].if).toEqual([compare(issue94, fact('clock.now'))]);
    });

    test('a duration literal needs a unit, and a unit belongs to a duration only', () => {
        expectIssue(
            ruleWith(compare(fact('challenge.timeLeft'), { kind: 'literal', value: 1, quantity: 'duration' })),
            `${IF}.right`,
            'A duration needs a unit',
        );
        expectIssue(
            ruleWith(
                compare(fact('challenge.timeLeft'), { kind: 'literal', value: 1, quantity: 'keys', unit: 'hours' }),
            ),
            `${IF}.right`,
            'Only a duration has a unit',
        );
        expectIssue(
            ruleWith(
                compare(fact('challenge.timeLeft'), { kind: 'literal', value: 1, quantity: 'duration', unit: 'weeks' }),
            ),
            `${IF}.right`,
            'Not a valid expression',
        );
    });

    test('only a literal number has a quantity', () => {
        expectIssue(
            ruleWith(compare(fact('challenge.timeLeft'), { kind: 'literal', value: 'x', quantity: 'keys' })),
            `${IF}.right`,
            'Unrecognized key',
        );
        expectIssue(
            ruleWith(compare(fact('challenge.timeLeft'), { kind: 'literal', value: 5 })),
            `${IF}.right`,
            'Not a valid expression',
        );
    });

    test('unknown fact names and unknown expression kinds are refused', () => {
        expectIssue(ruleWith(compare(fact('challenge.nonsense'), hours(1))), `${IF}.left`, 'Not a valid expression');
        expectIssue(
            ruleWith(compare({ kind: 'script', code: '1+1' }, hours(1))),
            `${IF}.left`,
            'Not a valid expression',
        );
        expectIssue(ruleWith(compare({ kind: 'fact', name: 'clock.now', extra: 1 }, hours(1))), `${IF}.left`, '');
    });

    test('a select belongs to entry facts only, and entry facts need one', () => {
        expectIssue(
            ruleWith(compare(fact('entry.votes'), count(1, 'votes'))),
            `${IF}.left`,
            'entry.votes needs a select',
        );
        expectIssue(
            ruleWith(compare(fact('challenge.end', { select: { by: 'mostVotes' } }), instant(1))),
            `${IF}.left`,
            'challenge.end does not take a select',
        );
        expectIssue(
            ruleWith(compare(fact('challenge.end', { window: '1h' }), instant(1))),
            `${IF}.left`,
            'challenge.end does not take a window',
        );
    });

    test('a fact whose stage list holds the active stage is accepted; the reward facts are refused until a rule can run in their stage', () => {
        const count0 = count(0, 'count');
        for (const name of [
            'missions.voteNeed',
            'photos.eligibleAtLeast',
            'challenge.players',
            'challenge.maxPlayers',
        ]) {
            expect(validate(ruleWith(compare(fact(name), count0, '>'))).ok).toBe(true);
        }
        expect(validate(ruleWith(compare(fact('challenge.joinPrice'), count(1, 'coins'), '<='))).ok).toBe(true);
        expect(validate(ruleWith(compare(fact('boost.open'), { kind: 'literal', value: true }, '='))).ok).toBe(true);
        expect(
            validate(ruleWith(compare(fact('entry.minAge', { select: { by: 'mostVotes' } }), hours(1), '>'))).ok,
        ).toBe(true);
        expectIssue(
            ruleWith(compare(fact('rewards.claimable'), { kind: 'literal', value: true }, '=')),
            `${IF}.left`,
            'rewards.claimable is not available while a challenge is active',
        );
        expectIssue(
            ruleWith(compare(fact('rewards.claimableCount'), count0, '>')),
            `${IF}.left`,
            'rewards.claimableCount is not available while a challenge is active',
        );
    });

    test('a setting must be readable by value and usable in an expression', () => {
        expectIssue(
            ruleWith(compare(setting('windowBounds'), hours(1))),
            `${IF}.left`,
            'cannot be read in an expression',
        );
        expectIssue(
            ruleWith(compare(setting('autovoteRunning'), { kind: 'literal', value: true }, '=')),
            `${IF}.left`,
            'cannot be read in an expression',
        );
        expectIssue(ruleWith(compare(setting('nonsense'), hours(1))), `${IF}.left`, 'is not a configuration setting');
        expectIssue(
            ruleWith(compare(setting('autoSubmitSchedule'), hours(1))),
            `${IF}.left`,
            'has no value an expression can use',
        );
        expectIssue(ruleWith(compare(setting('boostTime', 'later'), hours(1))), `${IF}.left`, 'Not a valid expression');
    });

    test('incompatible quantities are refused for ordered operators, equality and arithmetic', () => {
        expectIssue(
            ruleWith(compare(fact('challenge.timeLeft'), fact('challenge.end'))),
            IF,
            'Cannot compare duration with instant',
        );
        expectIssue(
            ruleWith(compare(fact('boost.state'), { kind: 'literal', value: 'a' }, '<')),
            IF,
            '< compares numbers only',
        );
        expectIssue(ruleWith(compare(fact('boost.state'), hours(1), '=')), IF, 'Cannot compare a string with a number');
        expectIssue(
            ruleWith(compare({ kind: 'add', left: count(1), right: count(1, 'swaps') }, count(1))),
            `${IF}.left`,
            'add needs two values of one quantity',
        );
        expectIssue(
            ruleWith(compare({ kind: 'offset', from: hours(1), by: hours(1), direction: 'before' }, instant(1))),
            `${IF}.left`,
            'offset moves an instant by a duration',
        );
        expectIssue(
            ruleWith(compare({ kind: 'earlier', of: [instant(1), hours(1)] }, instant(1))),
            `${IF}.left`,
            'earlier needs instants',
        );
        expectIssue(
            ruleWith(compare({ kind: 'min', of: [count(1), count(1, 'swaps')] }, count(1))),
            `${IF}.left`,
            'min needs numbers of one quantity',
        );
    });

    test('list conditions need the right kinds', () => {
        expectIssue(
            ruleWith({ type: 'contains', list: fact('boost.state'), value: { kind: 'literal', value: 'a' } }),
            IF,
            'contains needs a list',
        );
        expectIssue(
            ruleWith({ type: 'containsAny', list: fact('challenge.tags'), value: { kind: 'literal', value: 'a' } }),
            IF,
            'containsAny needs a list to look for',
        );
        expectIssue(
            ruleWith({ type: 'contains', list: fact('challenge.tags'), value: { kind: 'literal', value: ['a'] } }),
            IF,
            'contains needs a string to look for',
        );
    });

    test('a list condition reports an expression of its own that is wrong, and does not also relate it', () => {
        const lookup = { type: 'contains', list: setting('nonsense'), value: { kind: 'literal', value: 'a' } };
        expect(issuesOf(ruleWith(lookup))).toEqual([
            { path: `${IF}.list`, message: '"nonsense" is not a configuration setting' },
        ]);
    });

    test('the quantity of an expression inside a nested condition is checked too', () => {
        const nested = {
            type: 'any',
            of: [{ type: 'not', condition: compare(fact('challenge.timeLeft'), fact('challenge.end')) }],
        };
        expectIssue(ruleWith(nested), `${IF}.of[0].condition`, 'Cannot compare');
    });

    test('expressions nest at most 8 levels deep', () => {
        const nest = (levels: number): unknown => {
            let expr: unknown = instant(1);
            for (let level = 1; level < levels; level++)
                expr = { kind: 'offset', from: expr, by: hours(1), direction: 'before' };
            return expr;
        };
        expect(validate(ruleWith(compare(nest(8), instant(2)))).ok).toBe(true);
        expectIssue(ruleWith(compare(nest(9), instant(2))), `${IF}.left`, 'nests deeper than 8 levels');
    });

    test('an aggregate has 2 to 8 operands', () => {
        const of = (n: number) => Array.from({ length: n }, () => instant(1));
        expect(validate(ruleWith(compare({ kind: 'later', of: of(8) }, instant(2)))).ok).toBe(true);
        expectIssue(ruleWith(compare({ kind: 'later', of: of(9) }, instant(2))), `${IF}.left.of`, '');
        expectIssue(ruleWith(compare({ kind: 'earlier', of: of(1) }, instant(2))), `${IF}.left.of`, '');
        expectIssue(
            ruleWith(compare({ kind: 'min', of: Array.from({ length: 9 }, () => count(1)) }, count(2))),
            `${IF}.left.of`,
            '',
        );
    });

    test('entriesWhere has 1 to 8 predicates, a quantifier, and entry-typed values', () => {
        const predicate = { field: 'votes', op: '>=', value: 1 };
        const make = (where: unknown[], quantifier: unknown = 'all') =>
            ruleWith({ type: 'entriesWhere', quantifier, where });
        expect(validate(make(Array.from({ length: 8 }, () => predicate))).ok).toBe(true);
        expectIssue(
            make(Array.from({ length: 9 }, () => predicate)),
            `${IF}.where`,
            'entriesWhere takes 1 to 8 predicates',
        );
        expectIssue(make([]), `${IF}.where`, 'entriesWhere takes 1 to 8 predicates');
        expectIssue(make([predicate], 'some'), `${IF}.quantifier`, 'Invalid option');
        expectIssue(
            make([{ field: 'boosted', op: '=', value: 3 }]),
            `${IF}.where[0].value`,
            'boosted compares with true or false',
        );
        expectIssue(make([{ field: 'nonsense', op: '=', value: 1 }]), `${IF}.where[0].field`, 'Invalid option');
    });

    test('an entry count has 1 to 8 predicates, each with a value of the right kind', () => {
        const predicate = { field: 'votes', op: '>=', value: 1 };
        expect(
            validate(
                ruleWith({ type: 'entryCount', where: Array.from({ length: 8 }, () => predicate), op: '>=', value: 1 }),
            ).ok,
        ).toBe(true);
        expectIssue(
            ruleWith({ type: 'entryCount', where: Array.from({ length: 9 }, () => predicate), op: '>=', value: 1 }),
            `${IF}.where`,
            '',
        );
        expectIssue(ruleWith({ type: 'entryCount', where: [], op: '>=', value: 1 }), `${IF}.where`, '');
        expectIssue(
            ruleWith({ type: 'entryCount', where: [{ field: 'boosted', op: '=', value: 3 }], op: '>=', value: 1 }),
            `${IF}.where[0].value`,
            'boosted compares with true or false',
        );
        expectIssue(
            ruleWith({ type: 'entryCount', where: [{ field: 'boosted', op: '>', value: true }], op: '>=', value: 1 }),
            `${IF}.where[0].op`,
            'boosted only supports = and !=',
        );
        expectIssue(
            ruleWith({ type: 'entryCount', where: [{ field: 'votes', op: '>', value: true }], op: '>=', value: 1 }),
            `${IF}.where[0].value`,
            'votes compares with a number',
        );
        expectIssue(
            ruleWith({ type: 'entryCount', where: [{ field: 'nonsense', op: '>', value: 1 }], op: '>=', value: 1 }),
            `${IF}.where[0].field`,
            'Invalid option',
        );
        expectIssue(ruleWith({ type: 'entryCount', where: [predicate], op: '>=', value: 'x' }), `${IF}.value`, '');
    });

    test('a memory slot an expression reads must be remembered by some action', () => {
        const reads = compare(fact('entry.votes', { select: { by: 'memory', slot: 'held' } }), count(1, 'votes'));
        expectIssue(ruleWith(reads), 'phases.main.rules[0].if', 'Memory slot "held" is never remembered');
        const remembered = withRule({
            if: [reads],
            do: [{ type: 'remember', slot: 'held', entry: { by: 'mostVotes' } }],
        });
        expect(validate(remembered).ok).toBe(true);
    });

    test('a scenario that validated before still validates: the old conditions are unchanged', () => {
        const old = [
            { type: 'entries', op: '<', value: 3 },
            { type: 'entry', select: { by: 'slot', index: 0 }, field: 'votes', op: '>', value: 10 },
            { type: 'not', condition: { type: 'exposure', op: '>', value: 90 } },
        ];
        expect(validate(withRule({ if: old })).ok).toBe(true);
    });
});

describe('validateScenario — shape errors carry readable paths', () => {
    test('unknown keys are rejected at every level', () => {
        expectIssue(doc({ extra: 1 }), '', 'Unrecognized key');
        expectIssue(withRule({ when: [] }), 'phases.main.rules[0]', 'Unrecognized key');
    });

    test('unknown condition and action types', () => {
        expectIssue(withRule({ if: [{ type: 'nope' }] }), 'phases.main.rules[0].if[0].type', 'Invalid discriminator');
        expectIssue(withRule({ do: [{ type: 'nope' }] }), 'phases.main.rules[0].do[0].type', 'Invalid discriminator');
    });

    test('a bad photo source says what is allowed', () => {
        expectIssue(
            withRule({ do: [{ type: 'swap', entry: { by: 'mostVotes' }, with: 'worst' }] }),
            'phases.main.rules[0].do[0].with',
            'Use "best"',
        );
    });

    test.each([
        [{ type: 'dailyWindow', from: '06:00', to: '06:00' }, 'if[0].to', 'the same time'],
        [{ type: 'dailyWindow', from: '6:00', to: '08:00' }, 'if[0].from', 'HH:MM'],
        [{ type: 'beforeEnd' }, 'if[0]', 'Set min, max or both'],
        [{ type: 'beforeEnd', min: '2d', max: '1d' }, 'if[0].min', 'larger than max'],
        [{ type: 'beforeEnd', max: '5 days' }, 'if[0].max', 'Not a duration'],
        [{ type: 'elapsedPercent', min: 80, max: 20 }, 'if[0].min', 'larger than max'],
        [{ type: 'elapsedPercent' }, 'if[0]', 'Set min, max or both'],
        [{ type: 'boostState', in: ['available'] }, 'if[0].in[0]', 'upper-case'],
        [
            { type: 'entry', select: { by: 'mostVotes' }, field: 'boosted', op: '>', value: 1 },
            'if[0].value',
            'true or false',
        ],
        [
            { type: 'entry', select: { by: 'mostVotes' }, field: 'boosted', op: '>', value: true },
            'if[0].op',
            'only supports',
        ],
        [
            { type: 'entry', select: { by: 'mostVotes' }, field: 'rank', op: '<', value: false },
            'if[0].value',
            'a number',
        ],
        [
            { type: 'entry', select: { by: 'fastest' }, field: 'votes', op: '>', value: 1, window: '1h' },
            'if[0].window',
            'only applies',
        ],
        [
            { type: 'entry', select: { by: 'fastest', window: 'soon' }, field: 'votesPerHour', op: '>', value: 1 },
            'if[0].select.window',
            'Not a duration',
        ],
    ])('condition %p', (condition, path, message) => {
        expectIssue(withRule({ if: [condition] }), `phases.main.rules[0].${path}`, message);
    });

    test('a notify message is required and plain', () => {
        expectIssue(
            withRule({ do: [{ type: 'notify', message: '' }] }),
            'phases.main.rules[0].do[0].message',
            'Write the message',
        );
        expectIssue(
            withRule({ do: [{ type: 'notify', message: 'a\u0007b' }] }),
            'phases.main.rules[0].do[0].message',
            'control',
        );
    });

    test('labels and descriptions refuse control characters', () => {
        expectIssue(withRule({ label: 'two\nlines' }), 'phases.main.rules[0].label', 'control characters');
        expectIssue(doc({ description: 'colour \u001b[31mred' }), 'description', 'control characters');
        expect(validate(doc({ description: 'Ieliec pa vienai bildei — Izstāde' })).ok).toBe(true);
    });

    test('names must be bounded, well-formed and not reserved', () => {
        expectIssue(doc({ name: '' }), 'name', 'required');
        expectIssue(doc({ name: 'x'.repeat(61) }), 'name', 'longer than');
        expectIssue(doc({ name: '-plan' }), 'name', 'Use letters');
        expectIssue(doc({ name: 'Constructor' }), 'name', 'reserved');
        expectIssue(doc({ start: 'prototype', phases: { prototype: {} } }), 'start', 'reserved');
        expectIssue(doc({ start: '__proto__' }), 'start', 'Use letters');
    });

    test('phase count bounds', () => {
        expectIssue(doc({ phases: {} }), 'phases', 'at least one phase');
        const phases = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, {}]));
        expectIssue(doc({ start: 'p0', phases }), 'phases', 'at most 20 phases');
    });

    test('a rule needs an action', () => {
        expectIssue(withRule({ do: [] }), 'phases.main.rules[0].do', 'at least one action');
    });
});

describe('validateScenario — semantic checks', () => {
    test('start and goto must name existing phases', () => {
        expectIssue(doc({ start: 'nowhere' }), 'start', 'No phase named "nowhere"');
        expectIssue(withRule({ do: [{ type: 'goto', phase: 'later' }] }), 'phases.main.rules[0].do[0].phase', 'later');
    });

    test('duplicate rule ids are rejected', () => {
        const input = doc({
            phases: {
                main: { rules: [{ id: 'a', do: [{ type: 'fillExposure' }] }] },
                other: { rules: [{ id: 'a', do: [{ type: 'fillExposure' }] }] },
            },
        });
        expectIssue(input, 'phases.other.rules[0].id', 'Duplicate rule id');
    });

    test('memory slots read anywhere must be written by some action', () => {
        expectIssue(withRule({ if: [{ type: 'memorySet', slot: 'held' }] }), 'phases.main.rules[0].if', '"held"');
        expectIssue(
            withRule({
                if: [
                    {
                        type: 'not',
                        condition: {
                            type: 'entry',
                            select: { by: 'memory', slot: 'x' },
                            field: 'rank',
                            op: '<',
                            value: 5,
                        },
                    },
                ],
            }),
            'phases.main.rules[0].if',
            '"x"',
        );
        expectIssue(
            withRule({ do: [{ type: 'enterPhoto', photo: { memory: 'gone' } }] }),
            'phases.main.rules[0].do[0]',
            '"gone"',
        );
    });

    test('conditions deeper than the cap are rejected', () => {
        const deep = {
            type: 'not',
            condition: {
                type: 'not',
                condition: {
                    type: 'not',
                    condition: { type: 'not', condition: { type: 'entries', op: '>', value: 0 } },
                },
            },
        };
        expectIssue(withRule({ if: [deep] }), 'phases.main.rules[0].if', 'nest deeper');
    });

    describe('phase settings', () => {
        const withSettings = (settings: Record<string, unknown>, defaults?: Record<string, unknown>) =>
            issuesOf(doc({ phases: { main: { settings } } }), defaults);

        test('only per-challenge keys are allowed', () => {
            expect(withSettings({ token: 'x', currencyReserveSwaps: 1 })).toEqual([
                { path: 'phases.main.settings.token', message: 'Not a per-challenge setting' },
                { path: 'phases.main.settings.currencyReserveSwaps', message: 'Not a per-challenge setting' },
            ]);
        });

        test('the scenario assignment itself cannot be overlaid', () => {
            expect(withSettings({ scenario: 'Other' })[0]).toEqual({
                path: 'phases.main.settings.scenario',
                message: expect.stringContaining('scenario assignment'),
            });
        });

        test('Manual Only cannot be overlaid either, and says so in its own words', () => {
            expect(withSettings({ manualPhotosOnly: false })).toEqual([
                { path: 'phases.main.settings.manualPhotosOnly', message: 'A phase cannot change Manual Only' },
            ]);
            expect(withSettings({ manualPhotosOnly: true })[0].message).not.toContain('scenario assignment');
        });

        test('each value is validated like a setting', () => {
            expect(withSettings({ autoSubmit: 'yes' })[0].path).toBe('phases.main.settings.autoSubmit');
        });

        test('cross-field pairs are set together', () => {
            expect(withSettings({ exposure: 10 })).toEqual([
                { path: 'phases.main.settings.exposureTarget', message: 'Set exposure and exposureTarget together' },
            ]);
            expect(withSettings({ finalWindowExposureTarget: 100 })[0].path).toBe(
                'phases.main.settings.finalWindowExposure',
            );
        });

        test('values that conflict with inherited defaults are rejected', () => {
            const defaults = {
                ...globalDefaults,
                useFinalWindowExposure: true,
                finalWindowExposure: 100,
                finalWindowExposureTarget: 100,
            };
            expect(withSettings({ exposure: 10, exposureTarget: 12 }, defaults)).toEqual([
                { path: 'phases.main.settings', message: expect.stringContaining('conflict') },
            ]);
        });
    });
});

describe('validateScenario — phase bindings and profile', () => {
    const percent = (value: number) => ({ kind: 'literal', value, quantity: 'percent' });
    const seconds = (value: number) => ({ kind: 'literal', value, quantity: 'duration', unit: 'seconds' });
    const baseSetting = (key: string) => ({ kind: 'setting', key, view: 'base' });
    const phaseDoc = (phase: Record<string, unknown>) => doc({ phases: { main: phase } });
    const accepted = (phase: Record<string, unknown>) => {
        const result = validate(phaseDoc(phase));
        expect(result).toEqual(expect.objectContaining({ ok: true }));
        return (result as Accepted).scenario.phases.main;
    };

    test('a binding is kept beside the literals, with a profile name', () => {
        const phase = accepted({
            settings: { autoBoost: true },
            bindings: { boostFreshEntryWait: baseSetting('boostFreshEntryWait') },
            profile: '  Tactic ',
        });
        expect(phase.bindings).toEqual({ boostFreshEntryWait: baseSetting('boostFreshEntryWait') });
        expect(phase.profile).toBe('Tactic');
    });

    test('a binding may read raw facts and base settings in an expression', () => {
        accepted({
            bindings: {
                boostTime: {
                    kind: 'difference',
                    from: { kind: 'fact', name: 'clock.now' },
                    to: { kind: 'fact', name: 'challenge.end' },
                },
            },
        });
    });

    test('a key set literally and bound is refused', () => {
        expectIssue(
            phaseDoc({ settings: { boostTime: 60 }, bindings: { boostTime: seconds(30) } }),
            'phases.main.bindings.boostTime',
            'set in settings and bound',
        );
    });

    test.each([
        ['a key no phase may write', 'manualPhotosOnly', { kind: 'literal', value: true }, 'Manual Only'],
        ['the assignment', 'scenario', { kind: 'literal', value: 'x' }, 'scenario assignment'],
        ['a key that is not a setting', 'bogus', { kind: 'literal', value: true }, 'Not a per-challenge setting'],
        ['an installation setting', 'language', { kind: 'literal', value: 'en' }, 'Not a per-challenge setting'],
    ])('%s cannot be bound', (label, key, expression, message) => {
        expectIssue(phaseDoc({ bindings: { [key]: expression } }), `phases.main.bindings.${key}`, message);
    });

    test('a setting whose value has no expression form cannot be bound', () => {
        expectIssue(
            phaseDoc({ bindings: { chosenPhotos: baseSetting('chosenPhotos') } }),
            'phases.main.bindings.chosenPhotos',
            'no value an expression can set',
        );
    });

    test.each([
        ['another quantity', 'exposure', seconds(30), 'This gives a duration, but exposure takes a percent'],
        ['another kind', 'autoBoost', percent(5), 'This gives a percent, but autoBoost takes a boolean'],
        [
            'a list for a boolean',
            'autoBoost',
            { kind: 'literal', value: ['a'] },
            'a list, but autoBoost takes a boolean',
        ],
    ])('a binding of %s is refused', (label, key, expression, message) => {
        expectIssue(phaseDoc({ bindings: { [key]: expression } }), `phases.main.bindings.${key}`, message);
    });

    test('an expression with a mistake reports it once, at the binding', () => {
        expectIssue(
            phaseDoc({
                bindings: { boostTime: { kind: 'offset', from: percent(1), by: percent(2), direction: 'after' } },
            }),
            'phases.main.bindings.boostTime',
            'offset moves an instant by a duration',
        );
    });

    test('a binding cannot read a setting with the phase applied', () => {
        expectIssue(
            phaseDoc({ bindings: { boostTime: { kind: 'setting', key: 'boostTime', view: 'effective' } } }),
            'phases.main.bindings.boostTime',
            'a binding reads base settings only',
        );
    });

    test('a binding cannot read a fact that depends on the effective settings', () => {
        expectIssue(
            phaseDoc({ bindings: { exposure: { kind: 'fact', name: 'photos.eligibleCount' } } }),
            'phases.main.bindings.exposure',
            'depends on the effective settings',
        );
    });

    test('a binding reads only facts available while a challenge is active', () => {
        expectIssue(
            phaseDoc({ bindings: { autoBoost: { kind: 'fact', name: 'rewards.claimable' } } }),
            'phases.main.bindings.autoBoost',
            'is not available',
        );
    });

    test('a memory slot a binding reads must be remembered by some action', () => {
        const binding = {
            boostTime: { kind: 'fact', name: 'entry.votes', select: { by: 'memory', slot: 'pick' } },
        };
        expect(issuesOf(phaseDoc({ bindings: binding }))).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ path: 'phases.main.bindings', message: expect.stringContaining('pick') }),
            ]),
        );
    });

    test('a pair must be supplied together across the literals and the bindings', () => {
        accepted({ settings: { exposureTarget: 100 }, bindings: { exposure: baseSetting('exposure') } });
        accepted({ settings: { exposure: 50 }, bindings: { exposureTarget: baseSetting('exposureTarget') } });
        expectIssue(
            phaseDoc({ bindings: { exposure: baseSetting('exposure') } }),
            'phases.main.settings.exposureTarget',
            'Set exposure and exposureTarget together',
        );
        expectIssue(
            phaseDoc({ bindings: { finalWindowExposureTarget: baseSetting('finalWindowExposureTarget') } }),
            'phases.main.settings.finalWindowExposure',
            'together',
        );
    });

    test('a bad profile name or a non-string profile is a shape error', () => {
        expectIssue(phaseDoc({ profile: '' }), 'phases.main.profile', 'Name a profile');
        expectIssue(phaseDoc({ profile: 'x'.repeat(61) }), 'phases.main.profile', '<=60 characters');
        expect(validate(phaseDoc({ profile: 7 })).ok).toBe(false);
    });

    describe('the stored profile it names', () => {
        const stored = (values: unknown) => ({ Tactic: values });
        const check = (profiles: Record<string, unknown> | null, name = 'tactic') =>
            validateScenario(phaseDoc({ profile: name }), globalDefaults, profiles);

        test.each([
            [
                'the scenario assignment',
                { scenario: 'Other' },
                'sets scenario. A phase cannot change the scenario assignment itself',
            ],
            ['Manual Only', { manualPhotosOnly: true }, 'sets manualPhotosOnly. A phase cannot change Manual Only'],
        ])('is refused when it sets %s, not left out silently', (label, values, message) => {
            const result = check(stored(values));
            expect(result.ok).toBe(false);
            expect((result as Refused).issues).toEqual([
                { path: 'phases.main.profile', message: `Profile "tactic" ${message}` },
            ]);
        });

        test('is accepted when it sets only keys a phase may write', () => {
            expect(check(stored({ autoBoost: true, boostTime: 60 })).ok).toBe(true);
        });

        test('may be saved after the scenario, and is not looked at when a stored scenario is read back', () => {
            expect(check({}).ok).toBe(true);
            expect(check(stored('not an object')).ok).toBe(true);
            expect(check(null).ok).toBe(true);
            expect(validate(phaseDoc({ profile: 'Tactic' })).ok).toBe(true);
        });

        test('a stale key outside the schema in it is not a refusal here', () => {
            expect(check(stored({ retired: 1 })).ok).toBe(true);
        });
    });
});

describe('parseScenarioJson', () => {
    test('parses JSON text', () => {
        expect(parseScenarioJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    });

    test.each([[''], ['   '], [null], [42]])('%p is refused', (text) => {
        expect((parseScenarioJson(text) as ParseRefused).issues[0].message).toContain('No scenario JSON');
    });

    test('refuses oversized input before parsing', () => {
        expect((parseScenarioJson(`"${'x'.repeat(256 * 1024)}"`) as ParseRefused).issues[0].message).toContain(
            'larger than 256 KB',
        );
    });

    test('reports malformed JSON', () => {
        expect((parseScenarioJson('{nope') as ParseRefused).issues[0].message).toContain('Not valid JSON');
    });
});

test('formatPath joins keys and indexes', () => {
    expect(formatPath(['phases', 'a', 'rules', 1, 'do', 0, 'with'])).toBe('phases.a.rules[1].do[0].with');
    expect(formatPath([])).toBe('');
});
