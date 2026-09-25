/**
 * Scenario document validation — the trust boundary for shared scenario
 * files: strict shapes, bounded names, per-challenge-only phase settings,
 * resolvable references, and readable error paths.
 */

const { validateScenario, parseScenarioJson, formatPath } = require('../../src/js/settings/scenarioSchema');
const { getDefaultSettings } = require('../../src/js/settings/defaults');

const globalDefaults = getDefaultSettings().challengeSettings.globalDefaults;

const doc = (overrides = {}) => ({
    name: 'Plan',
    version: 1,
    start: 'main',
    phases: { main: { rules: [{ do: [{ type: 'fillExposure' }] }] } },
    ...overrides,
});

/** A scenario whose only rule has these conditions / actions. */
const withRule = (rule) => doc({ phases: { main: { rules: [{ do: [{ type: 'fillExposure' }], ...rule }] } } });

const validate = (input, defaults = globalDefaults) => validateScenario(input, defaults);

const issuesOf = (input, defaults) => {
    const result = validate(input, defaults);
    expect(result.ok).toBe(false);
    return result.issues;
};

const expectIssue = (input, path, message) => {
    expect(issuesOf(input)).toEqual(
        expect.arrayContaining([expect.objectContaining({ path, message: expect.stringContaining(message) })]),
    );
};

describe('validateScenario — accepted documents', () => {
    test('a minimal scenario validates and gets a generated rule id', () => {
        const result = validate(doc());
        expect(result.ok).toBe(true);
        expect(result.scenario.phases.main.rules[0].id).toBe('main-1');
    });

    test('trims the name', () => {
        expect(validate(doc({ name: '  Izstāde (plan)  ' })).scenario.name).toBe('Izstāde (plan)');
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
        expect(result.scenario.phases.main.rules.map((r) => r.id)).toEqual(['main-1-2', 'main-1']);
    });

    test('a phase with valid paired settings validates', () => {
        const input = doc({ phases: { main: { settings: { exposure: 10, exposureTarget: 12, autoFill: false } } } });
        expect(validate(input).ok).toBe(true);
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
        const withSettings = (settings, defaults) => issuesOf(doc({ phases: { main: { settings } } }), defaults);

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

        test('each value is validated like a setting', () => {
            expect(withSettings({ autoFill: 'yes' })[0].path).toBe('phases.main.settings.autoFill');
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

describe('parseScenarioJson', () => {
    test('parses JSON text', () => {
        expect(parseScenarioJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    });

    test.each([[''], ['   '], [null], [42]])('%p is refused', (text) => {
        expect(parseScenarioJson(text).issues[0].message).toContain('No scenario JSON');
    });

    test('refuses oversized input before parsing', () => {
        expect(parseScenarioJson(`"${'x'.repeat(256 * 1024)}"`).issues[0].message).toContain('larger than 256 KB');
    });

    test('reports malformed JSON', () => {
        expect(parseScenarioJson('{nope').issues[0].message).toContain('Not valid JSON');
    });
});

test('formatPath joins keys and indexes', () => {
    expect(formatPath(['phases', 'a', 'rules', 1, 'do', 0, 'with'])).toBe('phases.a.rules[1].do[0].with');
    expect(formatPath([])).toBe('');
});
