/**
 * Scenario conditions and entry selectors — including the fail-closed rule:
 * data the app cannot read never makes a condition true.
 */

import type * as conditionsModule from '../../src/ts/core/scenarios/conditions';
import type * as selectorsModule from '../../src/ts/core/scenarios/selectors';
import type { LegacySelector } from '../../src/ts/core/scenarios/selectors';
import type * as wallClockModule from '../../src/ts/core/scheduling/wallClock';
import type { Challenge, RankingEntry } from '../../src/ts/core/types/gurushots';
import type {
    ComparisonOp,
    EntryCondition,
    ScenarioCondition,
    ScenarioExpr,
    ScenarioSelector,
} from '../../src/ts/core/types/scenario';
import { invalid } from '../helpers/invalid';
import type { ConditionContext } from '../../src/ts/core/scenarios/conditions';

const { evaluateCondition, conditionsTruth, firstFailing, compare } =
    require('../../src/ts/core/scenarios/conditions') as typeof conditionsModule;
const { selectEntry } = require('../../src/ts/core/scenarios/selectors') as typeof selectorsModule;
const { epochForWallTime } = require('../../src/ts/core/scheduling/wallClock') as typeof wallClockModule;

const TZ = 'Europe/Riga';
const at = (y: number, m: number, d: number, hh: number, mm: number, tz = TZ) => epochForWallTime(y, m, d, hh, mm, tz);
const NOW = at(2026, 9, 25, 7, 0);
const DAY = 86400;

const entries = () => [
    { id: 'a', votes: 10, rank: 30 },
    { id: 'b', votes: 50, rank: 5, boosted: true },
    { id: 'c', votes: 10, rank: 0, turbo: true },
];

const challenge = (overrides: Record<string, unknown> = {}) => ({
    start_time: NOW - 10 * DAY,
    close_time: NOW + 2 * DAY,
    max_photo_submits: 4,
    member: {
        boost: { state: 'AVAILABLE' },
        turbo: { state: 'WON' },
        ranking: { entries: entries(), exposure: { exposure_factor: 40 }, total: { rank: 12, votes: 70 } },
    },
    ...overrides,
});

const ctx = (overrides: Partial<Record<keyof ConditionContext, unknown>> = {}) =>
    invalid<ConditionContext>({
        challenge: challenge(),
        state: { phaseEnteredAt: NOW - 600, memory: { held: 'b' } },
        now: NOW,
        timezone: TZ,
        bankroll: { keys: 1, swaps: 3, fills: 0, coins: 100 },
        ...overrides,
    });

const truthOf = (condition: ScenarioCondition, overrides?: Partial<Record<keyof ConditionContext, unknown>>) =>
    evaluateCondition(condition, ctx(overrides));

/** Whether a rule would act on it: only a known true result counts. */
const holds = (condition: ScenarioCondition, overrides?: Partial<Record<keyof ConditionContext, unknown>>) => {
    const truth = truthOf(condition, overrides);
    return truth.state === 'known' && truth.value;
};

describe('compare', () => {
    test.each<[number | boolean, ComparisonOp, number | boolean, boolean]>([
        [1, '<', 2, true],
        [2, '<=', 2, true],
        [3, '>', 2, true],
        [2, '>=', 3, false],
        [2, '=', 2, true],
        [2, '!=', 2, false],
        [true, '=', true, true],
        [true, '!=', false, true],
    ])('%p %s %p → %p', (a, op, b, expected) => {
        expect(compare(a, op, b)).toBe(expected);
    });
});

describe('time conditions', () => {
    test('dailyWindow is [from, to) in the app timezone', () => {
        const window: ScenarioCondition = { type: 'dailyWindow', from: '06:00', to: '08:00' };
        expect(holds(window, { now: at(2026, 9, 25, 6, 0) })).toBe(true);
        expect(holds(window, { now: at(2026, 9, 25, 7, 59) })).toBe(true);
        expect(holds(window, { now: at(2026, 9, 25, 8, 0) })).toBe(false);
        expect(holds(window, { now: at(2026, 9, 25, 5, 59) })).toBe(false);
        // Same instant, different zone: 07:00 Riga is 04:00 UTC.
        expect(holds(window, { timezone: 'UTC' })).toBe(false);
    });

    test('dailyWindow wraps past midnight', () => {
        const night: ScenarioCondition = { type: 'dailyWindow', from: '22:00', to: '02:00' };
        expect(holds(night, { now: at(2026, 9, 25, 23, 30) })).toBe(true);
        expect(holds(night, { now: at(2026, 9, 26, 1, 0) })).toBe(true);
        expect(holds(night, { now: at(2026, 9, 26, 2, 0) })).toBe(false);
        expect(holds(night, { now: at(2026, 9, 25, 12, 0) })).toBe(false);
    });

    test('dailyWindow holds across a DST switch (Riga, 29 March 2026, 03:00 → 04:00)', () => {
        const window: ScenarioCondition = { type: 'dailyWindow', from: '02:00', to: '05:00' };
        expect(holds(window, { now: at(2026, 3, 29, 4, 30) })).toBe(true);
        expect(holds(window, { now: at(2026, 3, 29, 5, 0) })).toBe(false);
    });

    test('beforeEnd bounds the time left, inclusive', () => {
        expect(holds({ type: 'beforeEnd', max: '2d' })).toBe(true);
        expect(holds({ type: 'beforeEnd', max: '1d' })).toBe(false);
        expect(holds({ type: 'beforeEnd', min: '2d' })).toBe(true);
        expect(holds({ type: 'beforeEnd', min: '1d', max: '3d' })).toBe(true);
    });

    test('beforeEnd fails closed without a close time, or once closed', () => {
        expect(holds({ type: 'beforeEnd', max: '5d' }, { challenge: challenge({ close_time: undefined }) })).toBe(
            false,
        );
        expect(holds({ type: 'beforeEnd', max: '5d' }, { now: NOW + 3 * DAY })).toBe(false);
    });

    test('afterStart bounds the time since start', () => {
        expect(holds({ type: 'afterStart', min: '3d' })).toBe(true);
        expect(holds({ type: 'afterStart', max: '3d' })).toBe(false);
        expect(holds({ type: 'afterStart', min: 0 }, { challenge: challenge({ start_time: NOW + 1 }) })).toBe(false);
        expect(holds({ type: 'afterStart', min: 0 }, { challenge: challenge({ start_time: null }) })).toBe(false);
    });

    test('inPhaseFor bounds the time since the phase was entered', () => {
        expect(holds({ type: 'inPhaseFor', min: '4m' })).toBe(true);
        expect(holds({ type: 'inPhaseFor', min: '15m' })).toBe(false);
    });

    test('elapsedPercent needs a readable start and close', () => {
        expect(holds({ type: 'elapsedPercent', min: 80 })).toBe(true);
        expect(holds({ type: 'elapsedPercent', max: 50 })).toBe(false);
        expect(
            holds({ type: 'elapsedPercent', min: 0 }, { challenge: challenge({ close_time: NOW - 20 * DAY }) }),
        ).toBe(false);
        expect(holds({ type: 'elapsedPercent', min: 0 }, { now: NOW - 11 * DAY })).toBe(false);
    });
});

describe('challenge conditions', () => {
    test.each<[ScenarioCondition, boolean]>([
        [{ type: 'entries', op: '=', value: 3 }, true],
        [{ type: 'freeSlots', op: '=', value: 1 }, true],
        [{ type: 'exposure', op: '<', value: 50 }, true],
        [{ type: 'challengeRank', op: '<=', value: 12 }, true],
        [{ type: 'challengeVotes', op: '>', value: 100 }, false],
        [{ type: 'boostState', in: ['AVAILABLE', 'AVAILABLE_KEY'] }, true],
        [{ type: 'turboState', in: ['FREE'] }, false],
        [{ type: 'balance', currency: 'swaps', op: '>', value: 0 }, true],
        [{ type: 'memorySet', slot: 'held' }, true],
        [{ type: 'memorySet', slot: 'other' }, false],
    ])('%p → %p', (condition, expected) => {
        expect(holds(condition)).toBe(expected);
    });

    test('a missed free boost matches MISSED, not LOCKED', () => {
        const missed = challenge({ member: { boost: { state: 'MISSED' } } });
        expect(holds({ type: 'boostState', in: ['MISSED'] }, { challenge: missed })).toBe(true);
        expect(holds({ type: 'boostState', in: ['LOCKED'] }, { challenge: missed })).toBe(false);
    });

    test('unknown data fails closed', () => {
        const bare = challenge({ max_photo_submits: undefined, member: { ranking: { total: { rank: 0 } } } });
        for (const condition of [
            { type: 'freeSlots', op: '>=', value: 0 },
            { type: 'exposure', op: '>=', value: 0 },
            { type: 'challengeRank', op: '>=', value: 0 },
            { type: 'challengeVotes', op: '>=', value: 0 },
            { type: 'boostState', in: ['AVAILABLE'] },
        ] satisfies ScenarioCondition[]) {
            expect(holds(condition, { challenge: bare })).toBe(false);
        }
        expect(holds({ type: 'balance', currency: 'keys', op: '>=', value: 0 }, { bankroll: null })).toBe(false);
        expect(holds({ type: 'entries', op: '=', value: 0 }, { challenge: {} })).toBe(true);
    });

    test('freeSlots never goes negative', () => {
        expect(
            holds({ type: 'freeSlots', op: '=', value: 0 }, { challenge: challenge({ max_photo_submits: 2 }) }),
        ).toBe(true);
    });
});

describe('entry conditions', () => {
    const entry = (
        select: ScenarioSelector,
        field: EntryCondition['field'],
        op: ComparisonOp,
        value: number | boolean,
    ): ScenarioCondition => ({ type: 'entry', select, field, op, value });

    test('compare votes, rank and flags of the selected entry', () => {
        expect(holds(entry({ by: 'mostVotes' }, 'votes', '=', 50))).toBe(true);
        expect(holds(entry({ by: 'bestRank' }, 'rank', '<=', 5))).toBe(true);
        expect(holds(entry({ by: 'memory', slot: 'held' }, 'boosted', '=', true))).toBe(true);
        expect(holds(entry({ by: 'slot', index: 1 }, 'turbo', '!=', true))).toBe(true);
    });

    test('an unranked entry never satisfies a rank comparison', () => {
        expect(holds(entry({ by: 'slot', index: 3 }, 'rank', '>=', 0))).toBe(false);
    });

    test('a selector that finds nothing makes the condition false', () => {
        expect(holds(entry({ by: 'memory', slot: 'gone' }, 'votes', '>=', 0))).toBe(false);
    });
});

describe('logical conditions', () => {
    const yes: ScenarioCondition = { type: 'entries', op: '=', value: 3 };
    const no: ScenarioCondition = { type: 'entries', op: '=', value: 9 };

    test('all / any / not', () => {
        expect(holds({ type: 'all', of: [yes, yes] })).toBe(true);
        expect(holds({ type: 'all', of: [yes, no] })).toBe(false);
        expect(holds({ type: 'any', of: [no, yes] })).toBe(true);
        expect(holds({ type: 'not', condition: no })).toBe(true);
    });

    test('conditionsTruth and firstFailing over a rule list', () => {
        expect(conditionsTruth(undefined, ctx())).toEqual({ state: 'known', value: true });
        expect(conditionsTruth([yes, yes], ctx())).toEqual({ state: 'known', value: true });
        expect(conditionsTruth([yes, no], ctx())).toEqual({ state: 'known', value: false });
        expect(firstFailing([yes, yes], ctx())).toBeNull();
        expect(firstFailing(undefined, ctx())).toBeNull();
        expect(firstFailing([yes, no], ctx())).toEqual({ index: 1, truth: { state: 'known', value: false } });
    });
});

describe('selectEntry', () => {
    const c = invalid<Challenge>(challenge());
    const select = (selector: LegacySelector, memory: Record<string, string> = {}) =>
        selectEntry(selector, c, { memory })?.id ?? null;

    test.each([
        [{ by: 'mostVotes' }, 'b'],
        [{ by: 'fewestVotes' }, 'a'],
        [{ by: 'bestRank' }, 'b'],
        [{ by: 'worstRank' }, 'a'],
        [{ by: 'boosted' }, 'b'],
        [{ by: 'turbo' }, 'c'],
        [{ by: 'slot', index: 0 }, 'c'],
        [{ by: 'slot', index: 2 }, 'b'],
        [{ by: 'mostVotes', skipProtected: true }, 'a'],
    ] satisfies [LegacySelector, string][])('%p → %p', (selector, id) => {
        expect(select(selector)).toBe(id);
    });

    test('memory matches ids as strings', () => {
        const numeric = challenge();
        (numeric.member.ranking.entries[0] as { id: unknown }).id = 42;
        expect(selectEntry({ by: 'memory', slot: 'x' }, invalid(numeric), { memory: { x: '42' } })!.votes).toBe(10);
        expect(select({ by: 'memory', slot: 'x' }, {})).toBeNull();
        expect(select({ by: 'memory', slot: 'x' }, { x: 'not-entered' })).toBeNull();
    });

    test('a boosting entry counts as boosted; none found → null', () => {
        const boosting = challenge();
        (boosting.member.ranking as { entries: RankingEntry[] }).entries = [{ id: 'z', boosting: true }];
        expect(selectEntry({ by: 'boosted' }, invalid(boosting), {})!.id).toBe('z');
        expect(selectEntry({ by: 'turbo' }, invalid(boosting), {})).toBeNull();
    });

    test('no boosted entry, or no memory at all → null', () => {
        const plain = invalid<Challenge>({ member: { ranking: { entries: [{ id: 'p' }] } } });
        expect(selectEntry({ by: 'boosted' }, plain, {})).toBeNull();
        expect(selectEntry({ by: 'memory', slot: 'x' }, plain)).toBeNull();
    });

    test('no entries → nothing selected', () => {
        expect(selectEntry({ by: 'slot', index: 1 }, invalid({}), {})).toBeNull();
        expect(selectEntry({ by: 'mostVotes' }, invalid({ member: { ranking: { entries: [null] } } }), {})).toBeNull();
    });

    test('missing votes count as zero; all unranked → no rank winner', () => {
        const unranked = invalid<Challenge>({ member: { ranking: { entries: [{ id: 'u', votes: 'x' }] } } });
        expect(selectEntry({ by: 'mostVotes' }, unranked, {})!.id).toBe('u');
        expect(selectEntry({ by: 'bestRank' }, unranked, {})).toBeNull();
    });
});

const NOT_READABLE = { challenge: challenge({ member: {} }) };

describe('three-state results: unreadable data is unknown, never false', () => {
    const unknownOf = (condition: ScenarioCondition, overrides?: Partial<Record<keyof ConditionContext, unknown>>) => {
        const truth = truthOf(condition, overrides);
        expect(truth.state).toBe('unknown');
        return truth as Extract<typeof truth, { state: 'unknown' }>;
    };

    test.each<[string, ScenarioCondition, Partial<Record<keyof ConditionContext, unknown>>, string, string]>([
        [
            'no close time',
            { type: 'beforeEnd', max: '5d' },
            { challenge: challenge({ close_time: undefined }) },
            'close-time-unreadable',
            'challenge.close_time',
        ],
        [
            'a closed challenge',
            { type: 'beforeEnd', max: '5d' },
            { now: NOW + 3 * DAY },
            'challenge-closed',
            'challenge.close_time',
        ],
        [
            'no start time',
            { type: 'afterStart', min: 0 },
            { challenge: challenge({ start_time: null }) },
            'start-time-unreadable',
            'challenge.start_time',
        ],
        [
            'a challenge that has not started',
            { type: 'afterStart', min: 0 },
            { challenge: challenge({ start_time: NOW + 1 }) },
            'challenge-not-started',
            'challenge.start_time',
        ],
        [
            'no readable span',
            { type: 'elapsedPercent', min: 0 },
            { challenge: challenge({ close_time: NOW - 20 * DAY }) },
            'span-unreadable',
            'challenge.close_time',
        ],
        [
            'no readable free-slot limit',
            { type: 'freeSlots', op: '>=', value: 0 },
            { challenge: challenge({ max_photo_submits: undefined }) },
            'max-photo-submits-unreadable',
            'challenge.max_photo_submits',
        ],
        [
            'no readable exposure',
            { type: 'exposure', op: '>=', value: 0 },
            NOT_READABLE,
            'exposure-unreadable',
            'member.ranking.exposure',
        ],
        [
            'no readable challenge votes',
            { type: 'challengeVotes', op: '>=', value: 0 },
            NOT_READABLE,
            'votes-unreadable',
            'member.ranking.total',
        ],
        [
            'no readable challenge rank',
            { type: 'challengeRank', op: '>=', value: 0 },
            NOT_READABLE,
            'rank-unreadable',
            'member.ranking.total',
        ],
        [
            'no bankroll',
            { type: 'balance', currency: 'keys', op: '>=', value: 0 },
            { bankroll: null },
            'bankroll-unavailable',
            'bankroll',
        ],
        [
            'a malformed balance',
            { type: 'balance', currency: 'keys', op: '>=', value: 0 },
            { bankroll: { keys: 'x' } },
            'balance-malformed',
            'bankroll',
        ],
        [
            'no boost state',
            { type: 'boostState', in: ['AVAILABLE'] },
            { challenge: challenge({ member: {} }) },
            'boost-state-unreadable',
            'member.boost.state',
        ],
        [
            'a boost state that is not a string',
            { type: 'boostState', in: ['AVAILABLE'] },
            { challenge: challenge({ member: { boost: { state: 3 } } }) },
            'boost-state-unreadable',
            'member.boost.state',
        ],
        [
            'no turbo state',
            { type: 'turboState', in: ['FREE'] },
            { challenge: challenge({ member: {} }) },
            'turbo-unreadable',
            'member.turbo',
        ],
        [
            'an unreadable phase start',
            { type: 'inPhaseFor', min: 0 },
            { state: { phaseEnteredAt: 'x', memory: {} } },
            'phase-clock-unreadable',
            'state.phaseEnteredAt',
        ],
    ])('%s is unknown with a reason and a dependency', (_name, condition, overrides, reason, dependency) => {
        const truth = unknownOf(condition, overrides);
        expect(truth.reason).toBe(reason);
        expect(truth.dependencies).toContain(dependency);
        expect(holds(condition, overrides)).toBe(false);
    });

    test('an unranked challenge or entry is not rank zero: the comparison is unknown, not true', () => {
        const unranked = challenge({ member: { ranking: { total: { rank: 0 } } } });
        expect(unknownOf({ type: 'challengeRank', op: '>=', value: 0 }, { challenge: unranked }).reason).toBe(
            'absent: not-present',
        );
        expect(
            unknownOf({ type: 'entry', select: { by: 'slot', index: 3 }, field: 'rank', op: '>=', value: 0 }).reason,
        ).toBe('absent: not-present');
    });

    test('an entry with no entry list to select from is unknown; one the selector cannot find is unknown too', () => {
        const unreadable = unknownOf(
            { type: 'entry', select: { by: 'mostVotes' }, field: 'votes', op: '>=', value: 0 },
            NOT_READABLE,
        );
        expect(unreadable.reason).toBe('entries-unreadable');
        expect(unreadable.dependencies).toEqual(['member.ranking.entries']);
        expect(
            unknownOf({ type: 'entry', select: { by: 'memory', slot: 'gone' }, field: 'votes', op: '>=', value: 0 })
                .reason,
        ).toBe('absent: not-present');
    });

    test('known results stay known: a string boost state, memory, the daily window and the phase clock', () => {
        expect(truthOf({ type: 'boostState', in: ['MISSED'] })).toEqual({ state: 'known', value: false });
        expect(truthOf({ type: 'boostState', in: ['AVAILABLE'] })).toEqual({ state: 'known', value: true });
        expect(
            truthOf(
                { type: 'boostState', in: ['WEIRD'] },
                { challenge: challenge({ member: { boost: { state: 'WEIRD' } } }) },
            ),
        ).toEqual({ state: 'known', value: true });
        expect(truthOf({ type: 'memorySet', slot: 'held' }, { state: { phaseEnteredAt: NOW, memory: {} } })).toEqual({
            state: 'known',
            value: false,
        });
        expect(truthOf({ type: 'memorySet', slot: 'held' }, { challenge: {} })).toEqual({
            state: 'known',
            value: true,
        });
        expect(truthOf({ type: 'dailyWindow', from: '06:00', to: '08:00' }, {})).toEqual({
            state: 'known',
            value: true,
        });
        expect(truthOf({ type: 'inPhaseFor', min: '4m' })).toEqual({ state: 'known', value: true });
        expect(truthOf({ type: 'entries', op: '=', value: 0 }, { challenge: {} })).toEqual({
            state: 'known',
            value: true,
        });
    });

    test('not over unreadable data does not fire (it used to)', () => {
        const unreadable: ScenarioCondition = { type: 'exposure', op: '>', value: 90 };
        const overrides = NOT_READABLE;
        expect(holds({ type: 'not', condition: unreadable }, overrides)).toBe(false);
        expect(unknownOf({ type: 'not', condition: unreadable }, overrides).reason).toBe('exposure-unreadable');
        // and a readable false still flips
        expect(holds({ type: 'not', condition: unreadable })).toBe(true);
    });

    test('any fires on one known true next to an unknown; all stops on one known false next to an unknown', () => {
        const yes: ScenarioCondition = { type: 'entries', op: '=', value: 3 };
        const no: ScenarioCondition = { type: 'entries', op: '=', value: 9 };
        const broken: ScenarioCondition = { type: 'freeSlots', op: '>=', value: 0 };
        const overrides = { challenge: challenge({ max_photo_submits: undefined }) };
        expect(holds({ type: 'any', of: [broken, yes] }, overrides)).toBe(true);
        expect(truthOf({ type: 'any', of: [broken, no] }, overrides).state).toBe('unknown');
        expect(truthOf({ type: 'all', of: [broken, no] }, overrides)).toEqual({ state: 'known', value: false });
        expect(truthOf({ type: 'all', of: [broken, yes] }, overrides).state).toBe('unknown');
        expect(holds({ type: 'all', of: [broken, yes] }, overrides)).toBe(false);
    });

    test('firstFailing tells a false condition from an unknown one', () => {
        const broken: ScenarioCondition = { type: 'freeSlots', op: '>=', value: 0 };
        const overrides = ctx({ challenge: challenge({ max_photo_submits: undefined }) });
        expect(firstFailing([{ type: 'entries', op: '=', value: 3 }, broken], overrides)).toMatchObject({
            index: 1,
            truth: { state: 'unknown', reason: 'max-photo-submits-unreadable' },
        });
        expect(conditionsTruth([broken, { type: 'entries', op: '=', value: 9 }], overrides)).toEqual({
            state: 'known',
            value: false,
        });
        expect(conditionsTruth([broken], overrides).state).toBe('unknown');
    });
});

describe('expression conditions', () => {
    const hours = (value: number): ScenarioExpr => ({ kind: 'literal', value, quantity: 'duration', unit: 'hours' });
    const fact = (name: string, select?: ScenarioSelector): ScenarioExpr =>
        invalid<ScenarioExpr>({ kind: 'fact', name, ...(select ? { select } : {}) });

    test('compare orders two quantities through the same readers as the named conditions', () => {
        const left = fact('challenge.timeLeft');
        const compareTo = (op: ComparisonOp, right: ScenarioExpr): ScenarioCondition => ({
            type: 'compare',
            left,
            op,
            right,
        });
        expect(truthOf(compareTo('<', hours(49)))).toEqual({ state: 'known', value: true });
        expect(truthOf(compareTo('<', hours(48)))).toEqual({ state: 'known', value: false });
        expect(truthOf(compareTo('>=', hours(48)))).toEqual({ state: 'known', value: true });
        expect(
            truthOf({
                type: 'compare',
                left: fact('boost.state'),
                op: '=',
                right: { kind: 'literal', value: 'AVAILABLE' },
            }),
        ).toEqual({ state: 'known', value: true });
    });

    test('compare is unknown when a side is absent or unknown, and does not hold', () => {
        const free = fact('boost.freeExpiry');
        const condition: ScenarioCondition = {
            type: 'compare',
            left: free,
            op: '>',
            right: { kind: 'literal', value: 0, quantity: 'instant' },
        };
        expect(
            truthOf(condition, { challenge: challenge({ member: { boost: { state: 'AVAILABLE_KEY' } } }) }),
        ).toMatchObject({ state: 'unknown', reason: 'absent: not-applicable' });
        expect(truthOf(condition, { challenge: challenge({ member: {} }) }).state).toBe('unknown');
        expect(holds(condition, { challenge: challenge({ member: {} }) })).toBe(false);
    });

    test('a setting reference is unknown without a reader, and reads through one when the context has it', () => {
        const condition: ScenarioCondition = {
            type: 'compare',
            left: { kind: 'setting', key: 'boostTime', view: 'base' },
            op: '>',
            right: hours(0),
        };
        expect(truthOf(condition)).toEqual({
            state: 'unknown',
            reason: 'settings-unavailable',
            dependencies: ['setting:boostTime'],
        });
        const readSetting = () => ({ state: 'known', value: { kind: 'number', value: 7200, quantity: 'duration' } });
        expect(truthOf(condition, { readSetting })).toEqual({ state: 'known', value: true });
    });

    test('a list condition with an expression of its own that is wrong has no type to relate', () => {
        const unreadable = { kind: 'setting', key: 'boostTime', view: 'base' } satisfies ScenarioExpr;
        expect(truthOf({ type: 'contains', list: fact('challenge.tags'), value: unreadable }).state).toBe('unknown');
    });

    test('present and absent test a value, and leave a failed read unknown', () => {
        const free = fact('boost.freeExpiry');
        const keyed = { challenge: challenge({ member: { boost: { state: 'AVAILABLE_KEY' } } }) };
        const timed = { challenge: challenge({ member: { boost: { state: 'AVAILABLE', timeout: NOW + 100 } } }) };
        const broken = { challenge: challenge({ member: {} }) };
        expect(truthOf({ type: 'present', value: free }, keyed)).toEqual({ state: 'known', value: false });
        expect(truthOf({ type: 'absent', value: free }, keyed)).toEqual({ state: 'known', value: true });
        expect(truthOf({ type: 'present', value: free }, timed)).toEqual({ state: 'known', value: true });
        expect(truthOf({ type: 'absent', value: free }, timed)).toEqual({ state: 'known', value: false });
        expect(truthOf({ type: 'present', value: free }, broken).state).toBe('unknown');
        expect(truthOf({ type: 'absent', value: free }, broken).state).toBe('unknown');
        expect(holds({ type: 'absent', value: free }, broken)).toBe(false);
    });

    test('contains, containsAny and containsAll over a list of strings', () => {
        const tags = fact('challenge.tags');
        const tagged = { challenge: challenge({ tags: ['light', 'sea'] }) };
        const list = (value: string[]): ScenarioExpr => ({ kind: 'literal', value });
        expect(truthOf({ type: 'contains', list: tags, value: { kind: 'literal', value: 'sea' } }, tagged)).toEqual({
            state: 'known',
            value: true,
        });
        expect(truthOf({ type: 'containsAny', list: tags, value: list(['x', 'light']) }, tagged)).toEqual({
            state: 'known',
            value: true,
        });
        expect(truthOf({ type: 'containsAll', list: tags, value: list(['x', 'light']) }, tagged)).toEqual({
            state: 'known',
            value: false,
        });
        expect(truthOf({ type: 'contains', list: tags, value: { kind: 'literal', value: 'sea' } }).state).toBe(
            'unknown',
        );
    });

    describe('entriesWhere', () => {
        type Predicate = { field: string; op: ComparisonOp; value: number | boolean };
        const where = (quantifier: 'any' | 'all', predicates: Predicate[]): ScenarioCondition =>
            invalid<ScenarioCondition>({ type: 'entriesWhere', quantifier, where: predicates });
        const verdict = (
            condition: ScenarioCondition,
            overrides?: Partial<Record<keyof ConditionContext, unknown>>,
        ) => {
            const truth = truthOf(condition, overrides);
            return truth.state === 'known' ? (truth.value ? 'T' : 'F') : 'U';
        };

        test('any: some entry meets every predicate; all: every entry does', () => {
            expect(verdict(where('any', [{ field: 'votes', op: '>=', value: 50 }]))).toBe('T');
            expect(verdict(where('any', [{ field: 'votes', op: '>', value: 50 }]))).toBe('F');
            expect(verdict(where('all', [{ field: 'votes', op: '>=', value: 10 }]))).toBe('T');
            expect(verdict(where('all', [{ field: 'votes', op: '>=', value: 50 }]))).toBe('F');
            expect(
                verdict(
                    where('any', [
                        { field: 'votes', op: '>=', value: 10 },
                        { field: 'boosted', op: '=', value: true },
                    ]),
                ),
            ).toBe('T');
        });

        test('a known entry decides next to one that cannot be judged; otherwise unknown', () => {
            // a rank 30, b rank 5, c unranked (cannot be judged)
            expect(verdict(where('any', [{ field: 'rank', op: '<=', value: 10 }]))).toBe('T');
            expect(verdict(where('all', [{ field: 'rank', op: '<=', value: 10 }]))).toBe('F');
            expect(verdict(where('any', [{ field: 'rank', op: '<=', value: 1 }]))).toBe('U');
            expect(verdict(where('all', [{ field: 'rank', op: '<=', value: 99 }]))).toBe('U');
        });

        test('a subject with no challenge (an installation, a closed challenge) has no entries to read: unknown', () => {
            const none = { challenge: undefined, subject: { kind: 'installation' } };
            expect(truthOf(where('any', [{ field: 'votes', op: '>=', value: 0 }]), none)).toEqual({
                state: 'unknown',
                reason: 'entries-unreadable',
                dependencies: ['member.ranking.entries'],
            });
        });

        test('an unreadable entry list is unknown; an empty one has no entry (any false, all true)', () => {
            const predicates: Predicate[] = [{ field: 'votes', op: '>=', value: 0 }];
            expect(truthOf(where('any', predicates), NOT_READABLE)).toEqual({
                state: 'unknown',
                reason: 'entries-unreadable',
                dependencies: ['member.ranking.entries'],
            });
            expect(holds(where('all', predicates), NOT_READABLE)).toBe(false);
            const empty = { challenge: challenge({ member: { ranking: { entries: [] } } }) };
            expect(verdict(where('any', predicates), empty)).toBe('F');
            expect(verdict(where('all', predicates), empty)).toBe('T');
        });
    });

    describe('entryCount', () => {
        const count = (
            where: Array<{ field: string; op: ComparisonOp; value: number | boolean }>,
            op: ComparisonOp,
            value: number,
        ): ScenarioCondition => invalid<ScenarioCondition>({ type: 'entryCount', where, op, value });

        test('counts the entries all predicates match', () => {
            expect(truthOf(count([{ field: 'votes', op: '>=', value: 10 }], '=', 3))).toEqual({
                state: 'known',
                value: true,
            });
            expect(truthOf(count([{ field: 'votes', op: '>=', value: 50 }], '=', 1))).toEqual({
                state: 'known',
                value: true,
            });
            expect(
                truthOf(
                    count(
                        [
                            { field: 'votes', op: '>=', value: 10 },
                            { field: 'boosted', op: '=', value: true },
                        ],
                        '>=',
                        1,
                    ),
                ),
            ).toEqual({ state: 'known', value: true });
            expect(
                truthOf(
                    count(
                        [
                            { field: 'votes', op: '>=', value: 10 },
                            { field: 'boosted', op: '=', value: true },
                        ],
                        '>',
                        1,
                    ),
                ),
            ).toEqual({ state: 'known', value: false });
            expect(truthOf(count([{ field: 'turbo', op: '=', value: true }], '!=', 1))).toEqual({
                state: 'known',
                value: false,
            });
            expect(truthOf(count([{ field: 'votes', op: '>', value: 1000 }], '<=', 0))).toEqual({
                state: 'known',
                value: true,
            });
        });

        test('an unreadable entry list is unknown, never zero', () => {
            const truth = truthOf(count([{ field: 'votes', op: '>=', value: 0 }], '=', 0), NOT_READABLE);
            expect(truth).toEqual({
                state: 'unknown',
                reason: 'entries-unreadable',
                dependencies: ['member.ranking.entries'],
            });
            expect(holds(count([{ field: 'votes', op: '>=', value: 0 }], '=', 0), NOT_READABLE)).toBe(false);
        });

        test('an empty readable list counts zero', () => {
            const empty = { challenge: challenge({ member: { ranking: { entries: [] } } }) };
            expect(truthOf(count([{ field: 'votes', op: '>=', value: 0 }], '=', 0), empty)).toEqual({
                state: 'known',
                value: true,
            });
        });

        test('entries that cannot be judged bound the count: the result is known only when every count in range agrees', () => {
            // a: unranked → rank cannot be judged (absent); b rank 5 matches; c rank 0 cannot be judged
            const where = [{ field: 'rank', op: '<=', value: 10 }] satisfies Array<{
                field: string;
                op: ComparisonOp;
                value: number;
            }>;
            // rank <= 10: a has rank 30 (false), b rank 5 (true), c unranked (unknown) → between 1 and 2 entries
            expect(truthOf(count(where, '>=', 1))).toEqual({ state: 'known', value: true });
            expect(truthOf(count(where, '>', 2))).toEqual({ state: 'known', value: false });
            expect(truthOf(count(where, '<=', 2))).toEqual({ state: 'known', value: true });
            expect(truthOf(count(where, '<', 1))).toEqual({ state: 'known', value: false });
            expect(truthOf(count(where, '=', 3))).toEqual({ state: 'known', value: false });
            expect(truthOf(count(where, '=', 0))).toEqual({ state: 'known', value: false });
            expect(truthOf(count(where, '!=', 0))).toEqual({ state: 'known', value: true });
            expect(truthOf(count(where, '!=', 3))).toEqual({ state: 'known', value: true });
            expect(truthOf(count(where, '=', 1))).toMatchObject({ state: 'unknown', reason: 'absent: not-present' });
            expect(truthOf(count(where, '=', 2))).toMatchObject({ state: 'unknown' });
            expect(truthOf(count(where, '!=', 1)).state).toBe('unknown');
            expect(truthOf(count(where, '>', 1)).state).toBe('unknown');
            expect(truthOf(count(where, '<', 2)).state).toBe('unknown');
            expect(truthOf(count(where, '>=', 2)).state).toBe('unknown');
            expect(truthOf(count(where, '<=', 1)).state).toBe('unknown');
        });

        test.each<[ComparisonOp, number, 'T' | 'F' | 'U']>([
            ['<', 3, 'T'],
            ['<', 1, 'F'],
            ['<', 2, 'U'],
            ['<=', 2, 'T'],
            ['<=', 0, 'F'],
            ['<=', 1, 'U'],
            ['>', 0, 'T'],
            ['>', 2, 'F'],
            ['>', 1, 'U'],
            ['>=', 1, 'T'],
            ['>=', 3, 'F'],
            ['>=', 2, 'U'],
            ['=', 3, 'F'],
            ['=', 0, 'F'],
            ['=', 1, 'U'],
            ['!=', 0, 'T'],
            ['!=', 3, 'T'],
            ['!=', 2, 'U'],
        ])('a count known to lie in 1..2: count %s %i is %s', (op, value, expected) => {
            const where = [{ field: 'rank', op: '<=', value: 10 }] satisfies Array<{
                field: string;
                op: ComparisonOp;
                value: number;
            }>;
            const truth = truthOf(count(where, op, value));
            expect(truth.state === 'known' ? (truth.value ? 'T' : 'F') : 'U').toBe(expected);
        });

        test('one false predicate decides an entry even when another is unknown', () => {
            // c: votes 10 ≥ 100 is false, so its unreadable rank cannot make it count
            const where = [
                { field: 'votes', op: '>=', value: 100 },
                { field: 'rank', op: '<=', value: 10 },
            ] satisfies Array<{ field: string; op: ComparisonOp; value: number }>;
            expect(truthOf(count(where, '=', 0))).toEqual({ state: 'known', value: true });
        });
    });
});
