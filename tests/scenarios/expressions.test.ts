/**
 * The scenario value model: three-state truth (Strong Kleene), the typed expression language, comparison and list
 * semantics, setting-value conversion, and the static checks the document validator runs over an expression.
 */

import type * as expressionsModule from '../../src/ts/core/scenarios/expressions';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import type { ScenarioExpr } from '../../src/ts/core/types/scenario';
import { invalid } from '../helpers/invalid';
import type {
    ExprType,
    ExprValue,
    ExpressionContext,
    Truth,
    ValueState,
} from '../../src/ts/core/scenarios/expressions';

const {
    known,
    absent,
    unknownOf,
    notTruth,
    allTruth,
    anyTruth,
    evaluateExpression,
    compareValues,
    presentTruth,
    absentTruth,
    listTruth,
    settingValue,
    checkExpression,
    compareIssue,
    listIssue,
    exprTypeOfDescriptor,
    exprReferences,
} = require('../../src/ts/core/scenarios/expressions') as typeof expressionsModule;

const NOW = 1_799_900_000;
const END = 1_800_000_000;

const challenge = (member: Record<string, unknown> = { boost: { state: 'AVAILABLE_KEY' } }) =>
    invalid<Challenge>({ id: 7, close_time: END, start_time: END - 864_000, member });

const ctx = (
    member?: Record<string, unknown>,
    extra: Partial<Pick<ExpressionContext, 'readSetting'>> = {},
): ExpressionContext => ({
    challenge: challenge(member),
    state: { phaseEnteredAt: NOW - 600, memory: {} },
    now: NOW,
    timezone: 'UTC',
    bankroll: { keys: 2, swaps: 3, fills: 4, coins: 50 },
    ...extra,
});

const num = (value: number, quantity: string, unit?: string) =>
    invalid<ScenarioExpr>({ kind: 'literal', value, quantity, ...(unit ? { unit } : {}) });
const hours = (value: number) => num(value, 'duration', 'hours');
const instant = (value: number) => num(value, 'instant');
const fact = (name: string, select?: unknown) =>
    invalid<ScenarioExpr>({ kind: 'fact', name, ...(select ? { select } : {}) });
const setting = (key: string, view: 'base' | 'effective' = 'base'): ScenarioExpr => ({ kind: 'setting', key, view });
const text = (value: string): ScenarioExpr => ({ kind: 'literal', value });
const flag = (value: boolean): ScenarioExpr => ({ kind: 'literal', value });
const strings = (value: string[]): ScenarioExpr => ({ kind: 'literal', value });

const numberValue = (value: number, quantity: string): ExprValue =>
    invalid<ExprValue>({ kind: 'number', value, quantity });
const knownNumber = (value: number, quantity: string): ValueState<ExprValue> => known(numberValue(value, quantity));

const T: Truth = known(true);
const F: Truth = known(false);
const U: Truth = unknownOf('read-failed', ['dep']);
const A: Truth = absent('not-present');

type Symbol = 'T' | 'F' | 'U' | 'A';
const TRUTHS: Record<Symbol, Truth> = { T, F, U, A };
const symbolOf = (truth: Truth): Symbol | 'absent' =>
    truth.state === 'known' ? (truth.value ? 'T' : 'F') : truth.state === 'unknown' ? 'U' : 'absent';

describe('truth composition (Strong Kleene)', () => {
    test.each<[Symbol, Symbol]>([
        ['T', 'F'],
        ['F', 'T'],
        ['U', 'U'],
        ['A', 'U'],
    ])('not %s → %s', (input, expected) => {
        expect(symbolOf(notTruth(TRUTHS[input]))).toBe(expected);
    });

    test('not keeps the unknown reason and dependencies, and turns absence into unknown', () => {
        expect(notTruth(U)).toEqual(U);
        expect(notTruth(A)).toEqual({ state: 'unknown', reason: 'absent: not-present', dependencies: [] });
    });

    // every pair of inputs, in both orders
    const ALL_ANY: Array<[Symbol, Symbol, Symbol, Symbol]> = [
        ['T', 'T', 'T', 'T'],
        ['T', 'F', 'F', 'T'],
        ['T', 'U', 'U', 'T'],
        ['T', 'A', 'U', 'T'],
        ['F', 'F', 'F', 'F'],
        ['F', 'U', 'F', 'U'],
        ['F', 'A', 'F', 'U'],
        ['U', 'U', 'U', 'U'],
        ['U', 'A', 'U', 'U'],
        ['A', 'A', 'U', 'U'],
    ];

    test.each(ALL_ANY)('%s, %s → all %s, any %s (either order)', (a, b, allExpected, anyExpected) => {
        for (const pair of [
            [TRUTHS[a], TRUTHS[b]],
            [TRUTHS[b], TRUTHS[a]],
        ]) {
            expect(symbolOf(allTruth(pair))).toBe(allExpected);
            expect(symbolOf(anyTruth(pair))).toBe(anyExpected);
        }
    });

    test('empty lists: all is true, any is false', () => {
        expect(allTruth([])).toEqual(known(true));
        expect(anyTruth([])).toEqual(known(false));
    });

    test('a known branch decides even next to failed evidence', () => {
        expect(allTruth([F, U, T])).toEqual(known(false));
        expect(anyTruth([U, T, F])).toEqual(known(true));
    });

    test('an unknown result merges the dependencies and reasons of its unknown operands', () => {
        const a = unknownOf('first', ['x', 'y']);
        const b = unknownOf('second', ['y', 'z']);
        expect(allTruth([T, a, b])).toEqual({
            state: 'unknown',
            reason: 'first; second',
            dependencies: ['x', 'y', 'z'],
        });
        expect(anyTruth([F, a, a])).toEqual({ state: 'unknown', reason: 'first', dependencies: ['x', 'y'] });
        expect(anyTruth([F, a, A])).toEqual({
            state: 'unknown',
            reason: 'first; absent: not-present',
            dependencies: ['x', 'y'],
        });
    });
});

describe('literals', () => {
    test.each<[string, number, string]>([
        ['seconds', 5, 'seconds'],
        ['minutes', 2, 'minutes'],
        ['hours', 1, 'hours'],
        ['days', 1, 'days'],
    ])('a %s duration normalizes to seconds', (name, value, unit) => {
        const seconds = { seconds: 5, minutes: 120, hours: 3600, days: 86400 }[name] as number;
        expect(evaluateExpression(num(value, 'duration', unit), ctx())).toEqual(knownNumber(seconds, 'duration'));
    });

    test('other quantities pass through unchanged', () => {
        expect(evaluateExpression(num(3, 'keys'), ctx())).toEqual(knownNumber(3, 'keys'));
        expect(evaluateExpression(instant(END), ctx())).toEqual(knownNumber(END, 'instant'));
    });

    test('boolean, string and list literals', () => {
        expect(evaluateExpression(flag(true), ctx())).toEqual(known({ kind: 'boolean', value: true }));
        expect(evaluateExpression(text('a'), ctx())).toEqual(known({ kind: 'string', value: 'a' }));
        expect(evaluateExpression(strings(['a', 'b']), ctx())).toEqual(known({ kind: 'list', value: ['a', 'b'] }));
    });
});

describe('fact references', () => {
    test('wrap the registry value with its declared quantity', () => {
        expect(evaluateExpression(fact('challenge.end'), ctx())).toEqual(knownNumber(END, 'instant'));
        expect(evaluateExpression(fact('challenge.title'), ctx())).toEqual(
            unknownOf('title-unreadable', ['challenge.title']),
        );
        expect(evaluateExpression(fact('challenge.id'), ctx())).toEqual(known({ kind: 'string', value: '7' }));
        expect(evaluateExpression(fact('challenge.tags'), ctx())).toEqual(absent('not-present'));
        expect(evaluateExpression(fact('boost.state'), ctx())).toEqual(
            known({ kind: 'string', value: 'AVAILABLE_KEY' }),
        );
    });

    test('a list fact becomes a list value, a boolean fact a boolean value', () => {
        const withTags = ctx();
        withTags.challenge = invalid<Challenge>({ ...withTags.challenge, tags: ['x', 'y'] });
        expect(evaluateExpression(fact('challenge.tags'), withTags)).toEqual(
            known({ kind: 'list', value: ['x', 'y'] }),
        );
        const member = { ranking: { entries: [{ id: 'a', boosted: true }] } };
        expect(evaluateExpression(fact('entry.boosted', { by: 'slot', index: 1 }), ctx(member))).toEqual(
            known({ kind: 'boolean', value: true }),
        );
    });

    test('absent and unknown facts keep their state', () => {
        expect(evaluateExpression(fact('boost.freeExpiry'), ctx())).toEqual(absent('not-applicable'));
        expect(evaluateExpression(fact('boost.freeExpiry'), ctx({}))).toMatchObject({ state: 'unknown' });
    });
});

describe('setting references', () => {
    test('without a reader every setting is unknown, settings-unavailable', () => {
        expect(evaluateExpression(setting('boostFreshEntryWait'), ctx())).toEqual({
            state: 'unknown',
            reason: 'settings-unavailable',
            dependencies: ['setting:boostFreshEntryWait'],
        });
    });

    test('with a reader, the value and view it answers are used', () => {
        const readSetting = jest.fn((key: string, view: string) =>
            view === 'effective' ? knownNumber(60, 'duration') : absent('not-present'),
        );
        const reading = ctx(undefined, { readSetting: invalid(readSetting) });
        expect(evaluateExpression(setting('boostTime', 'effective'), reading)).toEqual(knownNumber(60, 'duration'));
        expect(evaluateExpression(setting('boostTime', 'base'), reading)).toEqual(absent('not-present'));
        expect(readSetting).toHaveBeenNthCalledWith(1, 'boostTime', 'effective');
        expect(readSetting).toHaveBeenNthCalledWith(2, 'boostTime', 'base');
    });
});

describe('arithmetic', () => {
    test('offset moves an instant before or after by a duration', () => {
        expect(
            evaluateExpression({ kind: 'offset', from: instant(1000), by: hours(1), direction: 'before' }, ctx()),
        ).toEqual(knownNumber(1000 - 3600, 'instant'));
        expect(
            evaluateExpression({ kind: 'offset', from: instant(1000), by: hours(1), direction: 'after' }, ctx()),
        ).toEqual(knownNumber(1000 + 3600, 'instant'));
    });

    test('difference is to - from, a duration', () => {
        expect(evaluateExpression({ kind: 'difference', from: instant(100), to: instant(400) }, ctx())).toEqual(
            knownNumber(300, 'duration'),
        );
        expect(evaluateExpression({ kind: 'difference', from: instant(400), to: instant(100) }, ctx())).toEqual(
            knownNumber(-300, 'duration'),
        );
    });

    test('add and subtract: same quantity, or an instant with a duration', () => {
        expect(evaluateExpression({ kind: 'add', left: num(2, 'keys'), right: num(3, 'keys') }, ctx())).toEqual(
            knownNumber(5, 'keys'),
        );
        expect(evaluateExpression({ kind: 'subtract', left: num(2, 'keys'), right: num(5, 'keys') }, ctx())).toEqual(
            knownNumber(-3, 'keys'),
        );
        expect(evaluateExpression({ kind: 'add', left: instant(10), right: hours(1) }, ctx())).toEqual(
            knownNumber(3610, 'instant'),
        );
        expect(evaluateExpression({ kind: 'subtract', left: instant(10_000), right: hours(1) }, ctx())).toEqual(
            knownNumber(6400, 'instant'),
        );
    });

    test('arithmetic with an absent operand is absent: the result is not there either', () => {
        const free = fact('boost.freeExpiry');
        expect(evaluateExpression({ kind: 'offset', from: free, by: hours(1), direction: 'before' }, ctx())).toEqual(
            absent('not-applicable'),
        );
        expect(evaluateExpression({ kind: 'add', left: hours(1), right: free }, ctx())).toEqual(
            absent('not-applicable'),
        );
        expect(evaluateExpression({ kind: 'difference', from: instant(1), to: free }, ctx())).toEqual(
            absent('not-applicable'),
        );
    });

    test('unknown takes precedence over absent, in either operand order', () => {
        for (const [left, right] of [
            ['boost.freeRemaining', 'boost.freeExpiry'],
            ['boost.freeExpiry', 'boost.freeRemaining'],
        ]) {
            expect(evaluateExpression({ kind: 'add', left: fact(left), right: fact(right) }, ctx({})).state).toBe(
                'unknown',
            );
        }
        // one operand unknown (no boost), one absent (no turbo timer)
        const mixed = ctx({ turbo: { state: 'FREE' } });
        expect(
            evaluateExpression({ kind: 'add', left: fact('boost.freeRemaining'), right: fact('turbo.opensAt') }, mixed)
                .state,
        ).toBe('unknown');
    });

    test('a comparison with an absent result is unknown', () => {
        const free = evaluateExpression(
            { kind: 'offset', from: fact('boost.freeExpiry'), by: hours(1), direction: 'before' },
            ctx(),
        );
        expect(compareValues(free, '<', knownNumber(1, 'instant'))).toEqual({
            state: 'unknown',
            reason: 'absent: not-applicable',
            dependencies: [],
        });
    });

    test('arithmetic with an unknown operand is unknown and keeps its dependencies', () => {
        const result = evaluateExpression({ kind: 'add', left: fact('boost.freeRemaining'), right: hours(1) }, ctx({}));
        expect(result).toMatchObject({
            state: 'unknown',
            dependencies: expect.arrayContaining(['member.boost.state']),
        });
    });

    test('operands of the wrong kind or quantity are unknown, never coerced', () => {
        const mismatch = { state: 'unknown', reason: 'type-mismatch', dependencies: [] };
        expect(evaluateExpression({ kind: 'add', left: num(1, 'keys'), right: num(1, 'swaps') }, ctx())).toEqual(
            mismatch,
        );
        expect(evaluateExpression({ kind: 'add', left: text('a'), right: text('b') }, ctx())).toEqual(mismatch);
        expect(evaluateExpression({ kind: 'add', left: instant(1), right: instant(1) }, ctx())).toEqual(mismatch);
        expect(evaluateExpression({ kind: 'subtract', left: instant(1), right: instant(1) }, ctx())).toEqual(mismatch);
        expect(
            evaluateExpression({ kind: 'offset', from: hours(1), by: hours(1), direction: 'before' }, ctx()),
        ).toEqual(mismatch);
        expect(evaluateExpression({ kind: 'difference', from: instant(1), to: hours(1) }, ctx())).toEqual(mismatch);
    });

    test('a result that is not finite is unknown, never clamped', () => {
        const huge = num(1e308, 'keys');
        expect(evaluateExpression({ kind: 'add', left: huge, right: huge }, ctx())).toEqual({
            state: 'unknown',
            reason: 'not-finite',
            dependencies: [],
        });
    });
});

describe('earlier, later, min, max', () => {
    test('earlier and later pick over instants', () => {
        expect(evaluateExpression({ kind: 'earlier', of: [instant(5), instant(3), instant(9)] }, ctx())).toEqual(
            knownNumber(3, 'instant'),
        );
        expect(evaluateExpression({ kind: 'later', of: [instant(5), instant(3), instant(9)] }, ctx())).toEqual(
            knownNumber(9, 'instant'),
        );
    });

    test('min and max pick over numbers of one quantity', () => {
        expect(evaluateExpression({ kind: 'min', of: [num(5, 'keys'), num(3, 'keys')] }, ctx())).toEqual(
            knownNumber(3, 'keys'),
        );
        expect(evaluateExpression({ kind: 'max', of: [num(5, 'keys'), num(3, 'keys')] }, ctx())).toEqual(
            knownNumber(5, 'keys'),
        );
    });

    test('absent operands are left out; all absent is absent', () => {
        const free = fact('boost.freeExpiry');
        expect(evaluateExpression({ kind: 'earlier', of: [instant(5), free] }, ctx())).toEqual(
            knownNumber(5, 'instant'),
        );
        expect(evaluateExpression({ kind: 'later', of: [free, instant(5)] }, ctx())).toEqual(knownNumber(5, 'instant'));
        expect(evaluateExpression({ kind: 'earlier', of: [free, free] }, ctx())).toEqual(absent('not-applicable'));
        expect(evaluateExpression({ kind: 'max', of: [free, free] }, ctx())).toEqual(absent('not-applicable'));
    });

    test('an unknown operand makes the whole result unknown, even beside an absent or known one', () => {
        const broken = fact('boost.freeExpiry');
        const result = evaluateExpression(
            { kind: 'earlier', of: [instant(5), broken, fact('challenge.title')] },
            ctx({}),
        );
        expect(result.state).toBe('unknown');
        expect(evaluateExpression({ kind: 'min', of: [num(1, 'keys'), broken] }, ctx({})).state).toBe('unknown');
    });

    test('an aggregate with no operands has nothing to pick from (validation keeps 2 to 8)', () => {
        expect(evaluateExpression({ kind: 'earlier', of: [] }, ctx())).toEqual(unknownOf('no-operands', []));
    });

    test('mixed kinds or quantities are unknown', () => {
        const mismatch = { state: 'unknown', reason: 'type-mismatch', dependencies: [] };
        expect(evaluateExpression({ kind: 'earlier', of: [instant(5), hours(1)] }, ctx())).toEqual(mismatch);
        expect(evaluateExpression({ kind: 'min', of: [num(5, 'keys'), num(3, 'swaps')] }, ctx())).toEqual(mismatch);
        expect(evaluateExpression({ kind: 'min', of: [num(5, 'keys'), text('x')] }, ctx())).toEqual(mismatch);
        expect(evaluateExpression({ kind: 'max', of: [text('x'), text('y')] }, ctx())).toEqual(mismatch);
    });
});

describe('issue 94: the first submission deadline', () => {
    const deadline: ScenarioExpr = {
        kind: 'earlier',
        of: [
            { kind: 'offset', from: fact('challenge.end'), by: hours(10), direction: 'before' },
            { kind: 'offset', from: fact('boost.freeExpiry'), by: hours(1), direction: 'before' },
        ],
    };

    test('free expiry absent: only the challenge end counts', () => {
        expect(evaluateExpression(deadline, ctx({ boost: { state: 'AVAILABLE_KEY' } }))).toEqual(
            knownNumber(1_799_964_000, 'instant'),
        );
    });

    test('free expiry 1799956800: the earlier of the two', () => {
        expect(evaluateExpression(deadline, ctx({ boost: { state: 'AVAILABLE', timeout: 1_799_956_800 } }))).toEqual(
            knownNumber(1_799_953_200, 'instant'),
        );
    });

    test('a malformed timer leaves the deadline unknown', () => {
        expect(evaluateExpression(deadline, ctx({ boost: { state: 'AVAILABLE', timeout: 'soon' } })).state).toBe(
            'unknown',
        );
    });

    test('the challenge end minus 9h and 8h', () => {
        for (const [hoursBefore, expected] of [
            [9, 1_799_967_600],
            [8, 1_799_971_200],
        ]) {
            expect(
                evaluateExpression(
                    { kind: 'offset', from: fact('challenge.end'), by: hours(hoursBefore), direction: 'before' },
                    ctx(),
                ),
            ).toEqual(knownNumber(expected, 'instant'));
        }
    });
});

describe('comparison', () => {
    test.each<[number, string, number, boolean]>([
        [1, '<', 2, true],
        [2, '<=', 2, true],
        [3, '>', 2, true],
        [2, '>=', 3, false],
        [2, '=', 2, true],
        [2, '!=', 2, false],
    ])('%p %s %p → %p over one quantity', (a, op, b, expected) => {
        expect(compareValues(knownNumber(a, 'keys'), invalid(op), knownNumber(b, 'keys'))).toEqual(known(expected));
    });

    test('a quantity mismatch or an ordered op over non-numbers is unknown', () => {
        const mismatch = { state: 'unknown', reason: 'type-mismatch', dependencies: [] };
        expect(compareValues(knownNumber(1, 'keys'), '<', knownNumber(1, 'swaps'))).toEqual(mismatch);
        expect(
            compareValues(known({ kind: 'string', value: 'a' }), '<', known({ kind: 'string', value: 'b' })),
        ).toEqual(mismatch);
        expect(
            compareValues(known({ kind: 'boolean', value: true }), '>', known({ kind: 'boolean', value: false })),
        ).toEqual(mismatch);
        expect(compareValues(known({ kind: 'string', value: 'a' }), '=', knownNumber(1, 'keys'))).toEqual(mismatch);
    });

    test('booleans, strings and lists compare with = and !=; lists ignore order', () => {
        const b = (value: boolean) => known<ExprValue>({ kind: 'boolean', value });
        const s = (value: string) => known<ExprValue>({ kind: 'string', value });
        const l = (value: string[]) => known<ExprValue>({ kind: 'list', value });
        expect(compareValues(b(true), '=', b(true))).toEqual(known(true));
        expect(compareValues(b(true), '!=', b(true))).toEqual(known(false));
        expect(compareValues(s('a'), '=', s('b'))).toEqual(known(false));
        expect(compareValues(s('a'), '!=', s('b'))).toEqual(known(true));
        expect(compareValues(l(['a', 'b']), '=', l(['b', 'a']))).toEqual(known(true));
        expect(compareValues(l(['a']), '=', l(['a', 'b']))).toEqual(known(false));
        expect(compareValues(l(['a', 'a']), '=', l(['a', 'b']))).toEqual(known(false));
        expect(compareValues(l(['a']), '!=', l(['b']))).toEqual(known(true));
    });

    test('an absent or unknown side makes the comparison unknown', () => {
        expect(compareValues(absent('not-present'), '=', knownNumber(1, 'keys'))).toEqual({
            state: 'unknown',
            reason: 'absent: not-present',
            dependencies: [],
        });
        expect(compareValues(knownNumber(1, 'keys'), '=', unknownOf('gone', ['d']))).toEqual(unknownOf('gone', ['d']));
    });
});

describe('presence and lists', () => {
    test('present and absent turn absence into a known answer, and leave unknown unknown', () => {
        const value = knownNumber(1, 'keys');
        expect(presentTruth(value)).toEqual(known(true));
        expect(presentTruth(absent('not-present'))).toEqual(known(false));
        expect(presentTruth(unknownOf('r', ['d']))).toEqual(unknownOf('r', ['d']));
        expect(absentTruth(value)).toEqual(known(false));
        expect(absentTruth(absent('not-applicable'))).toEqual(known(true));
        expect(absentTruth(unknownOf('r', ['d']))).toEqual(unknownOf('r', ['d']));
    });

    const list = (value: string[]) => known<ExprValue>({ kind: 'list', value });
    const item = (value: string) => known<ExprValue>({ kind: 'string', value });

    test('contains, containsAny and containsAll', () => {
        expect(listTruth('contains', list(['a', 'b']), item('b'))).toEqual(known(true));
        expect(listTruth('contains', list(['a', 'b']), item('c'))).toEqual(known(false));
        expect(listTruth('containsAny', list(['a', 'b']), list(['c', 'b']))).toEqual(known(true));
        expect(listTruth('containsAny', list(['a']), list(['c']))).toEqual(known(false));
        expect(listTruth('containsAny', list(['a']), list([]))).toEqual(known(false));
        expect(listTruth('containsAll', list(['a', 'b']), list(['b', 'a']))).toEqual(known(true));
        expect(listTruth('containsAll', list(['a']), list(['a', 'c']))).toEqual(known(false));
        expect(listTruth('containsAll', list(['a']), list([]))).toEqual(known(true));
    });

    test('an absent or unknown side is unknown; the wrong value kind is a type mismatch', () => {
        expect(listTruth('contains', absent('not-present'), item('a')).state).toBe('unknown');
        expect(listTruth('containsAll', list([]), unknownOf('r', ['d']))).toEqual(unknownOf('r', ['d']));
        const mismatch = { state: 'unknown', reason: 'type-mismatch', dependencies: [] };
        expect(listTruth('contains', item('a'), item('a'))).toEqual(mismatch);
        expect(listTruth('contains', list(['a']), list(['a']))).toEqual(mismatch);
        expect(listTruth('containsAny', list(['a']), item('a'))).toEqual(mismatch);
    });
});

describe('settingValue (the setting boundary)', () => {
    test('a time-unit number converts to a duration in seconds', () => {
        expect(settingValue({ kind: 'number', quantity: 'duration', unit: 'seconds' }, 3600)).toEqual(
            knownNumber(3600, 'duration'),
        );
        expect(settingValue({ kind: 'number', quantity: 'duration', unit: 'minutes' }, 15)).toEqual(
            knownNumber(900, 'duration'),
        );
        expect(settingValue({ kind: 'number', quantity: 'duration', unit: 'hours' }, 1.5)).toEqual(
            knownNumber(5400, 'duration'),
        );
    });

    test("a setting's zero sentinel passes as stored", () => {
        expect(settingValue({ kind: 'number', quantity: 'duration', unit: 'seconds' }, 0)).toEqual(
            knownNumber(0, 'duration'),
        );
        expect(settingValue({ kind: 'number', quantity: 'percent' }, 0)).toEqual(knownNumber(0, 'percent'));
    });

    test('numbers of another quantity, booleans, strings, enums and lists', () => {
        expect(settingValue({ kind: 'number', quantity: 'coins' }, 40)).toEqual(knownNumber(40, 'coins'));
        expect(settingValue({ kind: 'boolean' }, false)).toEqual(known({ kind: 'boolean', value: false }));
        expect(settingValue({ kind: 'string' }, 'x')).toEqual(known({ kind: 'string', value: 'x' }));
        expect(settingValue({ kind: 'enum', values: ['a', 'b'] }, 'b')).toEqual(known({ kind: 'string', value: 'b' }));
        expect(settingValue({ kind: 'list' }, ['a', 'b'])).toEqual(known({ kind: 'list', value: ['a', 'b'] }));
    });

    test('a stored value of the wrong shape is unknown, never a default', () => {
        const malformed = { state: 'unknown', reason: 'setting-malformed', dependencies: [] };
        expect(settingValue({ kind: 'number', quantity: 'coins' }, '40')).toEqual(malformed);
        expect(settingValue({ kind: 'number', quantity: 'coins' }, Number.NaN)).toEqual(malformed);
        expect(settingValue({ kind: 'boolean' }, 1)).toEqual(malformed);
        expect(settingValue({ kind: 'string' }, 1)).toEqual(malformed);
        expect(settingValue({ kind: 'enum', values: ['a'] }, 'z')).toEqual(malformed);
        expect(settingValue({ kind: 'enum', values: ['a'] }, 1)).toEqual(malformed);
        expect(settingValue({ kind: 'list' }, ['a', 1])).toEqual(malformed);
        expect(settingValue({ kind: 'list' }, 'a')).toEqual(malformed);
    });

    test('a value with no expression form is unknown', () => {
        expect(settingValue({ kind: 'other' }, { x: 1 })).toEqual({
            state: 'unknown',
            reason: 'setting-not-expressible',
            dependencies: [],
        });
    });

    test('the static type of a descriptor', () => {
        expect(exprTypeOfDescriptor({ kind: 'number', quantity: 'duration', unit: 'hours' })).toEqual({
            kind: 'number',
            quantity: 'duration',
        });
        expect(exprTypeOfDescriptor({ kind: 'number', quantity: 'votes' })).toEqual({
            kind: 'number',
            quantity: 'votes',
        });
        expect(exprTypeOfDescriptor({ kind: 'boolean' })).toEqual({ kind: 'boolean' });
        expect(exprTypeOfDescriptor({ kind: 'string' })).toEqual({ kind: 'string' });
        expect(exprTypeOfDescriptor({ kind: 'enum', values: ['a'] })).toEqual({ kind: 'string' });
        expect(exprTypeOfDescriptor({ kind: 'list' })).toEqual({ kind: 'list' });
        expect(exprTypeOfDescriptor({ kind: 'other' })).toBeNull();
    });
});

describe('checkExpression', () => {
    const lookup = (key: string): ExprType | string =>
        ({
            boostTime: { kind: 'number', quantity: 'duration' } as ExprType,
            autoBoost: { kind: 'boolean' } as ExprType,
            windowBounds: 'windowBounds cannot be read in an expression',
        })[key] ?? `"${key}" is not a configuration setting`;
    const check = (expr: unknown) => checkExpression(invalid<ScenarioExpr>(expr), lookup, 'x');
    const messages = (expr: unknown) => check(expr).issues.map((issue) => `${issue.path}: ${issue.message}`);

    test('infers the type of a well-formed expression', () => {
        expect(check(hours(1))).toEqual({ type: { kind: 'number', quantity: 'duration' }, issues: [] });
        expect(check(flag(true)).type).toEqual({ kind: 'boolean' });
        expect(check(text('a')).type).toEqual({ kind: 'string' });
        expect(check(strings(['a'])).type).toEqual({ kind: 'list' });
        expect(check(fact('challenge.end')).type).toEqual({ kind: 'number', quantity: 'instant' });
        expect(check(fact('challenge.tags')).type).toEqual({ kind: 'list' });
        expect(check(fact('challenge.title')).type).toEqual({ kind: 'string' });
        expect(check(fact('boost.state')).type).toEqual({ kind: 'string' });
        expect(check(fact('entry.boosted', { by: 'mostVotes' })).type).toEqual({ kind: 'boolean' });
        expect(check(setting('boostTime')).type).toEqual({ kind: 'number', quantity: 'duration' });
        expect(check(setting('autoBoost', 'effective')).type).toEqual({ kind: 'boolean' });
        expect(check({ kind: 'offset', from: instant(1), by: hours(1), direction: 'before' }).type).toEqual({
            kind: 'number',
            quantity: 'instant',
        });
        expect(check({ kind: 'difference', from: instant(1), to: instant(2) }).type).toEqual({
            kind: 'number',
            quantity: 'duration',
        });
        expect(check({ kind: 'add', left: num(1, 'keys'), right: num(1, 'keys') }).type).toEqual({
            kind: 'number',
            quantity: 'keys',
        });
        expect(check({ kind: 'subtract', left: instant(1), right: hours(1) }).type).toEqual({
            kind: 'number',
            quantity: 'instant',
        });
        expect(check({ kind: 'earlier', of: [instant(1), instant(2)] }).type).toEqual({
            kind: 'number',
            quantity: 'instant',
        });
        expect(check({ kind: 'max', of: [num(1, 'keys'), num(2, 'keys')] }).type).toEqual({
            kind: 'number',
            quantity: 'keys',
        });
        expect(check({ kind: 'later', of: [instant(1), instant(2)] }).issues).toEqual([]);
        expect(check({ kind: 'min', of: [num(1, 'keys'), num(2, 'keys')] }).issues).toEqual([]);
        expect(check({ kind: 'add', left: hours(1), right: hours(1) }).type).toEqual({
            kind: 'number',
            quantity: 'duration',
        });
    });

    test('a duration literal needs a unit, and other quantities refuse one', () => {
        expect(messages(num(1, 'duration'))).toEqual(['x: A duration needs a unit: seconds, minutes, hours or days']);
        expect(messages(num(1, 'keys', 'hours'))).toEqual(['x: Only a duration has a unit']);
        expect(messages(num(1, 'instant', 'hours'))).toEqual(['x: Only a duration has a unit']);
    });

    test('a fact needs a select exactly when it is an entry fact; a window only fits the speed facts', () => {
        expect(messages(fact('entry.votes'))).toEqual(['x: entry.votes needs a select']);
        expect(messages(fact('challenge.end', { by: 'mostVotes' }))).toEqual([
            'x: challenge.end does not take a select',
        ]);
        expect(messages({ kind: 'fact', name: 'challenge.end', window: '1h' })).toEqual([
            'x: challenge.end does not take a window',
        ]);
        expect(messages({ kind: 'fact', name: 'entry.votes', select: { by: 'mostVotes' }, window: '1h' })).toEqual([
            'x: entry.votes does not take a window',
        ]);
        expect(
            check({ kind: 'fact', name: 'entry.votesPerHour', select: { by: 'mostVotes' }, window: '1h' }).issues,
        ).toEqual([]);
    });

    test('a setting must be a readable setting of a usable type', () => {
        expect(messages(setting('windowBounds'))).toEqual(['x: windowBounds cannot be read in an expression']);
        expect(messages(setting('nonsense'))).toEqual(['x: "nonsense" is not a configuration setting']);
    });

    test('incompatible quantities are refused where they meet', () => {
        expect(messages({ kind: 'offset', from: hours(1), by: hours(1), direction: 'before' })).toEqual([
            'x: offset moves an instant by a duration',
        ]);
        expect(messages({ kind: 'offset', from: instant(1), by: instant(1), direction: 'before' })).toEqual([
            'x: offset moves an instant by a duration',
        ]);
        expect(messages({ kind: 'difference', from: instant(1), to: hours(1) })).toEqual([
            'x: difference needs two instants',
        ]);
        expect(messages({ kind: 'add', left: num(1, 'keys'), right: num(1, 'swaps') })).toEqual([
            'x: add needs two values of one quantity, or an instant and a duration',
        ]);
        expect(messages({ kind: 'add', left: text('a'), right: text('b') })).toEqual([
            'x: add needs two values of one quantity, or an instant and a duration',
        ]);
        expect(messages({ kind: 'add', left: instant(1), right: instant(1) })).toEqual([
            'x: add needs two values of one quantity, or an instant and a duration',
        ]);
        expect(messages({ kind: 'subtract', left: instant(1), right: instant(1) })).toEqual([
            'x: subtract needs two values of one quantity, or an instant and a duration; use difference for two instants',
        ]);
        expect(messages({ kind: 'earlier', of: [instant(1), hours(1)] })).toEqual(['x: earlier needs instants']);
        expect(messages({ kind: 'later', of: [instant(1), text('a')] })).toEqual(['x: later needs instants']);
        expect(messages({ kind: 'min', of: [num(1, 'keys'), num(1, 'swaps')] })).toEqual([
            'x: min needs numbers of one quantity',
        ]);
        expect(messages({ kind: 'max', of: [num(1, 'keys'), text('a')] })).toEqual([
            'x: max needs numbers of one quantity',
        ]);
    });

    test('an issue is reported at the path of the operand that caused it', () => {
        const issues = check({
            kind: 'earlier',
            of: [instant(1), { kind: 'offset', from: setting('nonsense'), by: hours(1), direction: 'before' }],
        }).issues;
        expect(issues.map((issue) => issue.path)).toEqual(['x.of[1].from']);
    });

    test('expressions nest at most 8 levels deep', () => {
        const nest = (levels: number): ScenarioExpr => {
            let expr: ScenarioExpr = instant(1);
            for (let level = 1; level < levels; level++) {
                expr = { kind: 'offset', from: expr, by: hours(1), direction: 'before' };
            }
            return expr;
        };
        expect(check(nest(8)).issues).toEqual([]);
        expect(messages(nest(9))).toEqual(['x: Expression nests deeper than 8 levels']);
    });

    test('compare and list conditions check the types they relate', () => {
        const number = (quantity: string): ExprType => invalid<ExprType>({ kind: 'number', quantity });
        expect(compareIssue('<', number('keys'), number('keys'))).toBeNull();
        expect(compareIssue('=', { kind: 'string' }, { kind: 'string' })).toBeNull();
        expect(compareIssue('!=', { kind: 'list' }, { kind: 'list' })).toBeNull();
        expect(compareIssue('=', { kind: 'boolean' }, { kind: 'boolean' })).toBeNull();
        expect(compareIssue('<', number('keys'), number('swaps'))).toBe('Cannot compare keys with swaps');
        expect(compareIssue('=', number('keys'), { kind: 'string' })).toBe('Cannot compare a number with a string');
        expect(compareIssue('<', { kind: 'string' }, { kind: 'string' })).toBe('< compares numbers only');
        expect(listIssue('contains', { kind: 'list' }, { kind: 'string' })).toBeNull();
        expect(listIssue('containsAny', { kind: 'list' }, { kind: 'list' })).toBeNull();
        expect(listIssue('containsAll', { kind: 'string' }, { kind: 'list' })).toBe('containsAll needs a list');
        expect(listIssue('contains', { kind: 'list' }, { kind: 'list' })).toBe('contains needs a string to look for');
        expect(listIssue('containsAny', { kind: 'list' }, { kind: 'string' })).toBe(
            'containsAny needs a list to look for',
        );
    });

    test('lists every fact and setting an expression reads', () => {
        const refs = exprReferences({
            kind: 'earlier',
            of: [
                { kind: 'offset', from: fact('challenge.end'), by: hours(1), direction: 'before' },
                fact('entry.votes', { by: 'memory', slot: 'held' }),
                setting('boostTime', 'effective'),
                {
                    kind: 'add',
                    left: num(1, 'keys'),
                    right: { kind: 'subtract', left: num(2, 'keys'), right: num(1, 'keys') },
                },
                { kind: 'difference', from: instant(1), to: instant(2) },
                { kind: 'min', of: [num(1, 'keys'), num(2, 'keys')] },
            ],
        });
        expect(refs).toEqual({
            facts: [{ name: 'challenge.end' }, { name: 'entry.votes', select: { by: 'memory', slot: 'held' } }],
            settings: [{ key: 'boostTime', view: 'effective' }],
        });
    });
});
