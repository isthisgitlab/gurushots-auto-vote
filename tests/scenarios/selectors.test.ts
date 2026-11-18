/**
 * The entry selectors that read evidence (scenarios/selectors.ts resolveEntry): id, pinned, pendingBoostTarget, newest and
 * oldest, slowest and matching. Each answers known, absent or unknown; a potentially winning entry whose comparison data cannot
 * be read makes the answer unknown, never a guess; ties go to the lowest entry id.
 */

import type * as selectorsModule from '../../src/ts/core/scenarios/selectors';
import type { Challenge, RankingEntry } from '../../src/ts/core/types/gurushots';
import type { EntryPredicate, ScenarioSelector } from '../../src/ts/core/types/scenario';
import type { ValueState } from '../../src/ts/core/scenarios/valueState';
import type { SelectContext, SelectEvidence } from '../../src/ts/core/scenarios/selectors';
import { invalid } from '../helpers/invalid';

const { resolveEntry, compare } = require('../../src/ts/core/scenarios/selectors') as typeof selectorsModule;

const NOW = 1_800_000_000;
const H = 3600;

const known = <T>(value: T): ValueState<T> => ({ state: 'known', value });
const unknown = (reason: string, dependencies: string[]): ValueState<never> => ({
    state: 'unknown',
    reason,
    dependencies,
});

const entry = (id: string, over: Record<string, unknown> = {}): RankingEntry =>
    invalid<RankingEntry>({ id, votes: 10, rank: 5, ...over });

const challengeOf = (entries: RankingEntry[] | undefined): Challenge =>
    invalid<Challenge>(entries ? { member: { ranking: { entries } } } : { member: {} });

/** The fact registry's reader, reduced to what the entries carry: a missing field is unknown, an unranked entry absent. */
const readField = (field: EntryPredicate['field'], item: RankingEntry): ValueState<number | boolean> => {
    const value: unknown = (item as unknown as Record<string, unknown>)[field];
    if (field === 'rank') return value === 0 ? { state: 'absent', reason: 'not-present' } : known(value as number);
    return value === undefined ? unknown('insufficient-history', ['vote-history']) : known(value as number | boolean);
};

const resolve = (
    selector: ScenarioSelector,
    entries: RankingEntry[] | undefined,
    evidence: SelectEvidence = {},
    context: SelectContext = {},
) => resolveEntry(selector, challengeOf(entries), { now: NOW, ...context, evidence }, readField);

const idOf = (state: ValueState<RankingEntry>) => (state.state === 'known' ? String(state.value.id) : state);

describe('compare', () => {
    test.each([
        [1, '<', 2, true],
        [2, '<=', 2, true],
        [2, '=', 2, true],
        [2, '!=', 3, true],
        [3, '>=', 3, true],
        [3, '>', 2, true],
        [3, '<', 2, false],
    ] as const)('%p %s %p is %p', (a, op, b, expected) => {
        expect(compare(a, op, b)).toBe(expected);
    });
});

describe('the original selectors', () => {
    test('answer known, absent, or unknown as the fact registry always read them', () => {
        const entries = [entry('a', { votes: 3 }), entry('b', { votes: 9 })];
        expect(idOf(resolve({ by: 'mostVotes' }, entries))).toBe('b');
        expect(idOf(resolve({ by: 'slot', index: 1 }, entries))).toBe('a');
        expect(resolve({ by: 'mostVotes' }, [])).toEqual({ state: 'absent', reason: 'not-present' });
        expect(resolve({ by: 'memory', slot: 'x' }, entries)).toEqual({ state: 'absent', reason: 'not-present' });
        // fastest with no history to rank by is unknown, not absent
        expect(resolve({ by: 'fastest' }, entries)).toEqual(unknown('insufficient-history', ['vote-history']));
        expect(resolve({ by: 'fastest' }, [])).toEqual({ state: 'absent', reason: 'not-present' });
    });

    test('an unreadable entry list is unknown for every selector', () => {
        for (const selector of [{ by: 'mostVotes' }, { by: 'id', id: 'a' }, { by: 'newest', time: 'exact' }] as const) {
            expect(resolve(selector, undefined)).toEqual(unknown('entries-unreadable', ['member.ranking.entries']));
        }
    });
});

describe('a context without evidence', () => {
    test('reads every evidence-reading selector as not loaded', () => {
        const item = challengeOf([entry('a')]);
        expect(resolveEntry({ by: 'pinned', power: 'turbo' }, item, { now: NOW }, readField)).toEqual(
            unknown('evidence-not-loaded', ['entry-pins']),
        );
    });
});

describe('id', () => {
    test('the entry with that id; absent when the entries show none', () => {
        const entries = [entry('a'), entry('b')];
        expect(idOf(resolve({ by: 'id', id: 'b' }, entries))).toBe('b');
        expect(resolve({ by: 'id', id: 'zz' }, entries)).toEqual({ state: 'absent', reason: 'not-present' });
    });
});

describe('pinned', () => {
    const entries = [entry('a'), entry('b')];
    const pins = (boost: unknown, turbo: unknown): SelectEvidence => ({ pins: known({ boost, turbo }) as never });

    test('the entry the power is pinned to', () => {
        expect(idOf(resolve({ by: 'pinned', power: 'boost' }, entries, pins('a', 'b')))).toBe('a');
        expect(idOf(resolve({ by: 'pinned', power: 'turbo' }, entries, pins('a', 'b')))).toBe('b');
    });

    test('absent when the power is not pinned, or pinned to a photo that is not an entry', () => {
        expect(resolve({ by: 'pinned', power: 'boost' }, entries, pins(null, 'b'))).toEqual({
            state: 'absent',
            reason: 'not-present',
        });
        expect(resolve({ by: 'pinned', power: 'boost' }, entries, pins('gone', null))).toEqual({
            state: 'absent',
            reason: 'not-present',
        });
    });

    test('unknown when the evidence is not loaded, unreadable or malformed', () => {
        expect(resolve({ by: 'pinned', power: 'boost' }, entries)).toEqual(
            unknown('evidence-not-loaded', ['entry-pins']),
        );
        const unreadable = unknown('pins-unreadable', ['entry-pins']);
        expect(resolve({ by: 'pinned', power: 'boost' }, entries, { pins: unreadable })).toEqual(unreadable);
        expect(resolve({ by: 'pinned', power: 'boost' }, entries, pins(7, null))).toEqual(
            unknown('evidence-malformed', ['entry-pins']),
        );
    });
});

describe('pendingBoostTarget', () => {
    const entries = [entry('a'), entry('b')];

    test('the photo a fill-new boost is waiting on', () => {
        expect(idOf(resolve({ by: 'pendingBoostTarget' }, entries, { pendingBoost: known({ id: 'b' }) }))).toBe('b');
    });

    test('absent when none waits, or the photo is not an entry', () => {
        for (const id of [null, 'gone']) {
            expect(resolve({ by: 'pendingBoostTarget' }, entries, { pendingBoost: known({ id }) })).toEqual({
                state: 'absent',
                reason: 'not-present',
            });
        }
    });

    test('unknown when the evidence is not loaded, unreadable or malformed', () => {
        expect(resolve({ by: 'pendingBoostTarget' }, entries)).toEqual(
            unknown('evidence-not-loaded', ['entry-pending-boost']),
        );
        const unreadable = unknown('entry-ages-unreadable', ['entry-pending-boost']);
        expect(resolve({ by: 'pendingBoostTarget' }, entries, { pendingBoost: unreadable })).toEqual(unreadable);
        expect(resolve({ by: 'pendingBoostTarget' }, entries, { pendingBoost: known({ id: 4 }) as never })).toEqual(
            unknown('evidence-malformed', ['entry-pending-boost']),
        );
    });
});

describe('newest and oldest', () => {
    const times = (record: Record<string, unknown>): SelectEvidence => ({
        entryTimes: known({ times: record }) as never,
    });
    const exact = (at: number) => ({ at, exact: true });
    const seen = (at: number) => ({ at, exact: false });
    const entries = [entry('c'), entry('a'), entry('b')];

    test('with every time exact: the last / first to go in, ties to the lowest id', () => {
        const evidence = times({ a: exact(100), b: exact(300), c: exact(300) });
        expect(idOf(resolve({ by: 'newest', time: 'exact' }, entries, evidence))).toBe('b');
        expect(idOf(resolve({ by: 'oldest', time: 'exact' }, entries, evidence))).toBe('a');
        const tied = times({ a: exact(100), b: exact(100), c: exact(300) });
        expect(idOf(resolve({ by: 'oldest', time: 'exact' }, entries, tied))).toBe('a');
    });

    test('observed compares every recorded time, exact or not', () => {
        const evidence = times({ a: seen(500), b: exact(300), c: seen(100) });
        expect(idOf(resolve({ by: 'newest', time: 'observed' }, entries, evidence))).toBe('a');
        expect(idOf(resolve({ by: 'oldest', time: 'observed' }, entries, evidence))).toBe('c');
    });

    test('exact: an observed time bounds the entry from above, so it blocks the oldest but not a newest it cannot reach', () => {
        const evidence = times({ a: exact(300), b: exact(200), c: seen(100) });
        // c went in at or before 100: it cannot be newer than 300 ...
        expect(idOf(resolve({ by: 'newest', time: 'exact' }, entries, evidence))).toBe('a');
        // ... but it may be older than 200
        expect(resolve({ by: 'oldest', time: 'exact' }, entries, evidence)).toEqual(
            unknown('entry-age-unusable', ['entry-ages']),
        );
    });

    test('exact: an observed time that reaches the best exact time could still be the newest', () => {
        const evidence = times({ a: exact(300), b: exact(200), c: seen(300) });
        expect(resolve({ by: 'newest', time: 'exact' }, entries, evidence)).toEqual(
            unknown('entry-age-unusable', ['entry-ages']),
        );
    });

    test('exact with no exact time at all is unknown', () => {
        const evidence = times({ a: seen(1), b: seen(2), c: seen(3) });
        expect(resolve({ by: 'newest', time: 'exact' }, entries, evidence)).toEqual(
            unknown('entry-age-unusable', ['entry-ages']),
        );
    });

    test.each([
        ['an entry with no recorded time', { a: exact(1), b: exact(2) }],
        ['a record that is not an object', { a: exact(1), b: exact(2), c: 'x' }],
        ['a time that is not positive', { a: exact(1), b: exact(2), c: exact(0) }],
        ['a time that is not a number', { a: exact(1), b: exact(2), c: { at: '9', exact: true } }],
        ['an exactness that is not a flag', { a: exact(1), b: exact(2), c: { at: 9, exact: 'yes' } }],
    ])('%s makes the selection unknown, whichever the mode', (_label, record) => {
        for (const by of ['newest', 'oldest'] as const) {
            for (const time of ['exact', 'observed'] as const) {
                expect(resolve({ by, time }, entries, times(record))).toEqual(
                    unknown('entry-age-unusable', ['entry-ages']),
                );
            }
        }
    });

    test('a times record that is not an object reads every entry as unrecorded', () => {
        const evidence: SelectEvidence = { entryTimes: known({ times: null }) as never };
        expect(resolve({ by: 'newest', time: 'observed' }, entries, evidence)).toEqual(
            unknown('entry-age-unusable', ['entry-ages']),
        );
    });

    test('absent with no entries; unknown when the evidence is not loaded or unreadable', () => {
        expect(resolve({ by: 'newest', time: 'exact' }, [])).toEqual({ state: 'absent', reason: 'not-present' });
        expect(resolve({ by: 'newest', time: 'exact' }, entries)).toEqual(
            unknown('evidence-not-loaded', ['entry-ages']),
        );
        const unreadable = unknown('entry-ages-unreadable', ['entry-ages']);
        expect(resolve({ by: 'oldest', time: 'exact' }, entries, { entryTimes: unreadable })).toEqual(unreadable);
    });
});

describe('slowest', () => {
    // Each entry gained votes over the last two hours: a +20, b +40, c +20 (so a and c tie).
    const entries = [
        entry('c', { votes: 30 }),
        entry('b', { votes: 50 }),
        entry('a', { votes: 30 }),
        entry('p', { votes: 5, boosted: true }),
    ];
    const history = {
        a: [[NOW - 2 * H, 10]],
        b: [[NOW - 2 * H, 10]],
        c: [[NOW - 2 * H, 10]],
        p: [[NOW - 2 * H, 5]],
    } as Record<string, Array<[number, number]>>;

    test('the entry with the fewest votes per hour; ties go to the lowest id', () => {
        expect(idOf(resolve({ by: 'slowest' }, entries, {}, { history }))).toBe('p');
        expect(idOf(resolve({ by: 'slowest', skipProtected: true }, entries, {}, { history }))).toBe('a');
        expect(idOf(resolve({ by: 'slowest', window: '2h', skipProtected: true }, entries, {}, { history }))).toBe('a');
    });

    test('absent when nothing is left to compare', () => {
        const protectedOnly = [entry('p', { boosted: true })];
        expect(resolve({ by: 'slowest', skipProtected: true }, protectedOnly, {}, { history })).toEqual({
            state: 'absent',
            reason: 'not-present',
        });
        expect(resolve({ by: 'slowest' }, [], {}, { history })).toEqual({ state: 'absent', reason: 'not-present' });
    });

    test('unknown while any entry has no measurable speed: it could be the slowest', () => {
        const partial = { ...history };
        delete partial.b;
        expect(resolve({ by: 'slowest' }, entries, {}, { history: partial })).toEqual(
            unknown('insufficient-history', ['vote-history']),
        );
        expect(resolve({ by: 'slowest' }, entries)).toEqual(unknown('insufficient-history', ['vote-history']));
    });
});

describe('matching', () => {
    const where = (...predicates: EntryPredicate[]): EntryPredicate[] => predicates;
    const entries = [
        entry('c', { votes: 40, rank: 2 }),
        entry('a', { votes: 40, rank: 9 }),
        entry('b', { votes: 25, rank: 0 }),
        entry('d', { votes: 3, rank: 1 }),
    ];
    const matching = (
        predicates: EntryPredicate[],
        order: 'votes' | 'rank' | 'age',
        direction: 'asc' | 'desc',
    ): ScenarioSelector => ({ by: 'matching', where: predicates, order, direction });
    const atLeast = (value: number): EntryPredicate => ({ field: 'votes', op: '>=', value });

    test('the first entry that meets every predicate by the order and direction; ties go to the lowest id', () => {
        expect(idOf(resolve(matching(where(atLeast(20)), 'votes', 'desc'), entries))).toBe('a');
        expect(idOf(resolve(matching(where(atLeast(20)), 'votes', 'asc'), entries))).toBe('b');
        const ranked = entries.filter((item) => item.id !== 'b');
        const rankedWell = where(atLeast(20), { field: 'rank', op: '>', value: 1 });
        expect(idOf(resolve(matching(rankedWell, 'rank', 'asc'), ranked))).toBe('c');
    });

    test('absent when no entry matches and none could', () => {
        expect(resolve(matching(where(atLeast(500)), 'votes', 'desc'), entries)).toEqual({
            state: 'absent',
            reason: 'not-present',
        });
        expect(resolve(matching(where(atLeast(1)), 'votes', 'desc'), [])).toEqual({
            state: 'absent',
            reason: 'not-present',
        });
    });

    test('a matching entry that cannot be placed in the order blocks the answer', () => {
        // b is unranked: it matches but has no rank to order by
        expect(resolve(matching(where(atLeast(20)), 'rank', 'asc'), entries)).toEqual(
            unknown('entry-data-unreadable', ['member.ranking.entries']),
        );
    });

    test('an entry whose predicates cannot be judged blocks the answer when it could be the winner', () => {
        const unjudged = [...entries, entry('e', { votes: 99, votesPerHour: undefined })];
        const speedy: EntryPredicate = { field: 'votesPerHour', op: '>', value: 5 };
        // only e has no speed on record: its predicate is unknown, and its votes (99) could beat every matching entry
        const withSpeed = [entry('c', { votes: 40, votesPerHour: 9 }), entry('e', { votes: 99 })];
        expect(resolve(matching(where(speedy), 'votes', 'desc'), withSpeed)).toEqual(
            unknown('entry-data-unreadable', ['member.ranking.entries', 'vote-history']),
        );
        // an unjudged entry that cannot beat the best match does not block it
        const weak = [entry('c', { votes: 40, votesPerHour: 9 }), entry('e', { votes: 1 })];
        expect(idOf(resolve(matching(where(speedy), 'votes', 'desc'), weak))).toBe('c');
        // an unjudged entry with nothing known to match is unknown, not absent
        expect(resolve(matching(where(speedy), 'votes', 'desc'), [entry('e', { votes: 1 })])).toEqual(
            unknown('entry-data-unreadable', ['member.ranking.entries', 'vote-history']),
        );
        expect(unjudged).toHaveLength(5);
    });

    test('an unjudged entry whose key cannot be read is a threat too', () => {
        const speedy: EntryPredicate = { field: 'votesPerHour', op: '>', value: 5 };
        // d is unranked (rank 0): matching on rank order, its key is unreadable
        const items = [entry('c', { votes: 40, votesPerHour: 9, rank: 2 }), entry('d', { rank: 0 })];
        expect(resolve(matching(where(speedy), 'rank', 'asc'), items)).toEqual(
            unknown('entry-data-unreadable', ['member.ranking.entries', 'vote-history']),
        );
    });

    test('a predicate on a rank an entry does not have leaves it unjudged, not matched', () => {
        const ranked: EntryPredicate = { field: 'rank', op: '<', value: 3 };
        expect(resolve(matching(where(ranked), 'votes', 'desc'), [entry('b', { rank: 0 })])).toEqual(
            unknown('entry-data-unreadable', ['member.ranking.entries']),
        );
    });

    describe('ordered by age', () => {
        const stamp = (record: Record<string, unknown>): SelectEvidence => ({
            entryTimes: known({ times: record }) as never,
        });

        test('ascending age is the newest first', () => {
            const evidence = stamp({
                a: { at: 100, exact: true },
                b: { at: 900, exact: false },
                c: { at: 500, exact: true },
            });
            expect(idOf(resolve(matching(where(atLeast(20)), 'age', 'asc'), entries, evidence))).toBe('b');
            expect(idOf(resolve(matching(where(atLeast(20)), 'age', 'desc'), entries, evidence))).toBe('a');
        });

        test('unknown when the entry times are not loaded, and when a matching entry has none recorded', () => {
            expect(resolve(matching(where(atLeast(20)), 'age', 'asc'), entries)).toEqual(
                unknown('evidence-not-loaded', ['entry-ages']),
            );
            expect(
                resolve(matching(where(atLeast(20)), 'age', 'asc'), entries, stamp({ a: { at: 100, exact: true } })),
            ).toEqual(unknown('entry-data-unreadable', ['member.ranking.entries']));
        });

        test('absent matches are absent before any time is needed', () => {
            expect(resolve(matching(where(atLeast(500)), 'age', 'asc'), entries)).toEqual({
                state: 'absent',
                reason: 'not-present',
            });
        });
    });
});
