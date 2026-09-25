/**
 * Scenario conditions and entry selectors — including the fail-closed rule:
 * data the app cannot read never makes a condition true.
 */

const { evaluateCondition, allHold, firstFailing, compare } = require('../../src/js/scenarios/conditions');
const { selectEntry } = require('../../src/js/scenarios/selectors');
const { epochForWallTime } = require('../../src/js/scheduling/wallClock');

const TZ = 'Europe/Riga';
const at = (y, m, d, hh, mm, tz = TZ) => epochForWallTime(y, m, d, hh, mm, tz);
const NOW = at(2026, 9, 25, 7, 0);
const DAY = 86400;

const entries = () => [
    { id: 'a', votes: 10, rank: 30 },
    { id: 'b', votes: 50, rank: 5, boosted: true },
    { id: 'c', votes: 10, rank: 0, turbo: true },
];

const challenge = (overrides = {}) => ({
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

const ctx = (overrides = {}) => ({
    challenge: challenge(),
    state: { phaseEnteredAt: NOW - 600, memory: { held: 'b' } },
    now: NOW,
    timezone: TZ,
    bankroll: { keys: 1, swaps: 3, fills: 0, coins: 100 },
    ...overrides,
});

const holds = (condition, overrides) => evaluateCondition(condition, ctx(overrides));

describe('compare', () => {
    test.each([
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
        const window = { type: 'dailyWindow', from: '06:00', to: '08:00' };
        expect(holds(window, { now: at(2026, 9, 25, 6, 0) })).toBe(true);
        expect(holds(window, { now: at(2026, 9, 25, 7, 59) })).toBe(true);
        expect(holds(window, { now: at(2026, 9, 25, 8, 0) })).toBe(false);
        expect(holds(window, { now: at(2026, 9, 25, 5, 59) })).toBe(false);
        // Same instant, different zone: 07:00 Riga is 04:00 UTC.
        expect(holds(window, { timezone: 'UTC' })).toBe(false);
    });

    test('dailyWindow wraps past midnight', () => {
        const night = { type: 'dailyWindow', from: '22:00', to: '02:00' };
        expect(holds(night, { now: at(2026, 9, 25, 23, 30) })).toBe(true);
        expect(holds(night, { now: at(2026, 9, 26, 1, 0) })).toBe(true);
        expect(holds(night, { now: at(2026, 9, 26, 2, 0) })).toBe(false);
        expect(holds(night, { now: at(2026, 9, 25, 12, 0) })).toBe(false);
    });

    test('dailyWindow holds across a DST switch (Riga, 29 March 2026, 03:00 → 04:00)', () => {
        const window = { type: 'dailyWindow', from: '02:00', to: '05:00' };
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
    test.each([
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

    test('unknown data fails closed', () => {
        const bare = challenge({ max_photo_submits: undefined, member: { ranking: { total: { rank: 0 } } } });
        for (const condition of [
            { type: 'freeSlots', op: '>=', value: 0 },
            { type: 'exposure', op: '>=', value: 0 },
            { type: 'challengeRank', op: '>=', value: 0 },
            { type: 'challengeVotes', op: '>=', value: 0 },
            { type: 'boostState', in: ['AVAILABLE'] },
        ]) {
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
    const entry = (select, field, op, value) => ({ type: 'entry', select, field, op, value });

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
    const yes = { type: 'entries', op: '=', value: 3 };
    const no = { type: 'entries', op: '=', value: 9 };

    test('all / any / not', () => {
        expect(holds({ type: 'all', of: [yes, yes] })).toBe(true);
        expect(holds({ type: 'all', of: [yes, no] })).toBe(false);
        expect(holds({ type: 'any', of: [no, yes] })).toBe(true);
        expect(holds({ type: 'not', condition: no })).toBe(true);
    });

    test('allHold and firstFailing over a rule list', () => {
        expect(allHold(undefined, ctx())).toBe(true);
        expect(allHold([yes, no], ctx())).toBe(false);
        expect(firstFailing([yes, no], ctx())).toBe(1);
        expect(firstFailing(undefined, ctx())).toBe(-1);
    });
});

describe('selectEntry', () => {
    const c = challenge();
    const select = (selector, memory = {}) => selectEntry(selector, c, memory)?.id ?? null;

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
    ])('%p → %p', (selector, id) => {
        expect(select(selector)).toBe(id);
    });

    test('memory matches ids as strings', () => {
        const numeric = challenge();
        numeric.member.ranking.entries[0].id = 42;
        expect(selectEntry({ by: 'memory', slot: 'x' }, numeric, { x: '42' }).votes).toBe(10);
        expect(select({ by: 'memory', slot: 'x' }, {})).toBeNull();
        expect(select({ by: 'memory', slot: 'x' }, { x: 'not-entered' })).toBeNull();
    });

    test('a boosting entry counts as boosted; none found → null', () => {
        const boosting = challenge();
        boosting.member.ranking.entries = [{ id: 'z', boosting: true }];
        expect(selectEntry({ by: 'boosted' }, boosting, {}).id).toBe('z');
        expect(selectEntry({ by: 'turbo' }, boosting, {})).toBeNull();
    });

    test('no boosted entry, or no memory at all → null', () => {
        const plain = { member: { ranking: { entries: [{ id: 'p' }] } } };
        expect(selectEntry({ by: 'boosted' }, plain, {})).toBeNull();
        expect(selectEntry({ by: 'memory', slot: 'x' }, plain, undefined)).toBeNull();
    });

    test('no entries → nothing selected', () => {
        expect(selectEntry({ by: 'slot', index: 1 }, {}, {})).toBeNull();
        expect(selectEntry({ by: 'mostVotes' }, { member: { ranking: { entries: [null] } } }, {})).toBeNull();
    });

    test('missing votes count as zero; all unranked → no rank winner', () => {
        const unranked = { member: { ranking: { entries: [{ id: 'u', votes: 'x' }] } } };
        expect(selectEntry({ by: 'mostVotes' }, unranked, {}).id).toBe('u');
        expect(selectEntry({ by: 'bestRank' }, unranked, {})).toBeNull();
    });
});
