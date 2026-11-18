/**
 * The pure fact registry: every registered fact answers known, absent or unknown from the evidence the current
 * condition context carries, and never turns missing or malformed evidence into a default.
 */

import type * as factsModule from '../../src/ts/core/scenarios/facts';
import type * as selectorsModule from '../../src/ts/core/scenarios/selectors';
import type * as vocabularyModule from '../../src/ts/core/scenarios/vocabulary';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import type { ScenarioSelector } from '../../src/ts/core/types/scenario';
import { invalid } from '../helpers/invalid';
import type { FactSnapshot, FactValue } from '../../src/ts/core/scenarios/facts';
import type { ValueState } from '../../src/ts/core/scenarios/expressions';

const { FACTS, readScenarioFact, readEntryField, factStageIssues } =
    require('../../src/ts/core/scenarios/facts') as typeof factsModule;
const { readableEntries } = require('../../src/ts/core/scenarios/selectors') as typeof selectorsModule;
const vocabulary = require('../../src/ts/core/scenarios/vocabulary') as typeof vocabularyModule;

const NOW = 1_799_900_000;
const START = NOW - 10 * 86400;
const END = NOW + 2 * 86400;
const H = 3600;

const entries = () => [
    { id: 'a', votes: 10, rank: 30 },
    { id: 'b', votes: 50, rank: 5, boosted: true },
    { id: 'c', votes: 10, rank: 0, turbo: true, boosting: true },
];

const baseChallenge = (): Record<string, unknown> => ({
    id: 7,
    title: 'Spring',
    type: 'flash',
    tags: ['light', 'sea'],
    start_time: START,
    close_time: END,
    max_photo_submits: 4,
    member: {
        boost: { state: 'AVAILABLE', timeout: NOW + 3600 },
        turbo: { state: 'TIMER', mode: 'classic', time_to_open: NOW + 600 },
        ranking: { entries: entries(), exposure: { exposure_factor: 40 }, total: { rank: 12, votes: 70 } },
    },
});

const snapshot = (
    challenge: Record<string, unknown> = baseChallenge(),
    extra: Partial<Record<keyof FactSnapshot, unknown>> = {},
): FactSnapshot =>
    invalid<FactSnapshot>({
        challenge,
        state: { phaseEnteredAt: NOW - 600, memory: { held: 'b' } },
        now: NOW,
        timezone: 'UTC',
        bankroll: { keys: 1, swaps: 3, fills: 0, coins: 100 },
        ...extra,
    });

/** The base challenge with `member` replaced. */
const withMember = (member: unknown) => ({ ...baseChallenge(), member });
const withBoost = (boost: unknown) => withMember({ boost });
const withTurbo = (turbo: unknown) => withMember({ turbo });
const without = (key: string) => {
    const challenge = baseChallenge();
    delete challenge[key];
    return challenge;
};

const read = (
    name: string,
    challenge?: Record<string, unknown>,
    extra?: Partial<Record<keyof FactSnapshot, unknown>>,
) => readScenarioFact(invalid(name), snapshot(challenge, extra));
const known = (value: FactValue): ValueState<FactValue> => ({ state: 'known', value });
const absent = (reason: 'not-applicable' | 'not-present'): ValueState<FactValue> => ({ state: 'absent', reason });
const unknown = (reason: string, dependencies: string[]): ValueState<FactValue> => ({
    state: 'unknown',
    reason,
    dependencies,
});

describe('the registry', () => {
    test('registers exactly the vocabulary fact names', () => {
        expect(Object.keys(FACTS).sort()).toEqual([...vocabulary.FACT_NAMES].sort());
    });

    test('every fact declares kind, optionality, stages, classification and dependencies', () => {
        for (const [name, fact] of Object.entries(FACTS)) {
            expect(['number', 'boolean', 'string', 'list']).toContain(fact.kind);
            expect(typeof fact.optional).toBe('boolean');
            expect(fact.stages.length).toBeGreaterThan(0);
            expect(['raw', 'policy']).toContain(fact.classification);
            expect(Array.isArray(fact.dependencies)).toBe(true);
            // a number has a quantity, and nothing else has one
            expect(
                fact.kind === 'number'
                    ? vocabulary.QUANTITIES.includes(invalid(fact.quantity))
                    : fact.quantity === undefined,
            ).toBe(true);
            // entry facts take a select
            expect(fact.takesSelect).toBe(name.startsWith('entry.'));
        }
    });

    test('every fact is usable during an active challenge', () => {
        for (const name of vocabulary.FACT_NAMES) expect(factStageIssues(name, 'active', 'p')).toEqual([]);
    });

    test('a fact is refused in a stage it does not list', () => {
        const only: Parameters<typeof factStageIssues>[3] = invalid({ 'clock.now': { stages: ['preJoin'] } });
        const refused = (stage: 'account' | 'preJoin' | 'active' | 'postClose') =>
            factStageIssues('clock.now', stage, 'p', only);
        expect(refused('active')).toEqual([
            { path: 'p', message: 'clock.now is not available while a challenge is active' },
        ]);
        expect(refused('preJoin')).toEqual([]);
        expect(refused('postClose')).toEqual([
            { path: 'p', message: 'clock.now is not available after a challenge closes' },
        ]);
        expect(refused('account')).toEqual([{ path: 'p', message: 'clock.now is not available outside a challenge' }]);
    });

    test('the dependencies of every unknown answer are declared by the fact', () => {
        const hostile: Array<Record<string, unknown>> = [
            {},
            { member: null },
            { member: {} },
            { member: { boost: { state: 5, timeout: 'x' }, turbo: { state: 5, mode: 5, time_to_open: 'x' } } },
            {
                member: {
                    boost: { state: 'AVAILABLE', timeout: 'x' },
                    turbo: 'x',
                    ranking: { entries: 'x', total: 'x' },
                },
            },
            { id: {}, title: 5, type: 5, tags: 'x', start_time: 'x', close_time: 'x', max_photo_submits: 'x' },
            {
                start_time: NOW + 1,
                close_time: NOW - 1,
                member: { ranking: { exposure: { exposure_factor: 'x' }, total: { rank: 'x', votes: 'x' } } },
            },
        ];
        const extras: Array<Partial<Record<keyof FactSnapshot, unknown>>> = [
            {},
            { now: Number.NaN },
            { state: { phaseEnteredAt: 'x', memory: {} } },
            { bankroll: { keys: 'x' } },
            { bankroll: null },
        ];
        const unknownSeen = new Set<string>();
        for (const challenge of hostile) {
            for (const extra of extras) {
                for (const name of vocabulary.FACT_NAMES) {
                    for (const select of [undefined, { by: 'slot', index: 1 } satisfies ScenarioSelector]) {
                        const result = readScenarioFact(name, snapshot(challenge, extra), select);
                        if (result.state === 'unknown') {
                            unknownSeen.add(name);
                            for (const dependency of result.dependencies) {
                                expect(FACTS[name].dependencies).toContain(dependency);
                            }
                        }
                    }
                }
            }
        }
        // every fact can be unknown, except those that read only injected state
        expect([...unknownSeen].sort()).toEqual(
            vocabulary.FACT_NAMES.filter((name) => name !== 'challenge.entries').sort(),
        );
    });
});

describe('clock and phase', () => {
    test('known', () => {
        expect(read('clock.now')).toEqual(known(NOW));
        expect(read('phase.enteredAt')).toEqual(known(NOW - 600));
        expect(read('phase.elapsed')).toEqual(known(600));
    });

    test('unknown when the clock or the phase start is not a number', () => {
        expect(read('clock.now', undefined, { now: Number.NaN })).toEqual(unknown('clock-unreadable', ['clock']));
        const broken = { state: { phaseEnteredAt: 'x', memory: {} } };
        expect(read('phase.enteredAt', undefined, broken)).toEqual(
            unknown('phase-clock-unreadable', ['state.phaseEnteredAt']),
        );
        expect(read('phase.elapsed', undefined, broken)).toEqual(
            unknown('phase-clock-unreadable', ['state.phaseEnteredAt']),
        );
        expect(read('phase.elapsed', undefined, { now: Number.NaN })).toEqual(unknown('clock-unreadable', ['clock']));
    });
});

describe('challenge identity and dates', () => {
    test('known', () => {
        expect(read('challenge.id')).toEqual(known('7'));
        expect(read('challenge.title')).toEqual(known('Spring'));
        expect(read('challenge.type')).toEqual(known('flash'));
        expect(read('challenge.tags')).toEqual(known(['light', 'sea']));
        expect(read('challenge.start')).toEqual(known(START));
        expect(read('challenge.end')).toEqual(known(END));
        expect(read('challenge.timeLeft')).toEqual(known(END - NOW));
        expect(read('challenge.elapsed')).toEqual(known(NOW - START));
        expect(read('challenge.elapsedPercent')).toEqual(known(((NOW - START) / (END - START)) * 100));
    });

    test('a string id is read as it is', () => {
        expect(read('challenge.id', { ...baseChallenge(), id: 'abc' })).toEqual(known('abc'));
    });

    test('absent: a regular challenge has no type, an untagged one no tags', () => {
        expect(read('challenge.type', without('type'))).toEqual(absent('not-present'));
        expect(read('challenge.type', { ...baseChallenge(), type: '' })).toEqual(absent('not-present'));
        expect(read('challenge.type', { ...baseChallenge(), type: null })).toEqual(absent('not-present'));
        expect(read('challenge.tags', without('tags'))).toEqual(absent('not-present'));
    });

    test('unknown: missing or malformed data is never a default', () => {
        expect(read('challenge.id', without('id'))).toEqual(unknown('id-unreadable', ['challenge.id']));
        expect(read('challenge.title', { ...baseChallenge(), title: 5 })).toEqual(
            unknown('title-unreadable', ['challenge.title']),
        );
        expect(read('challenge.type', { ...baseChallenge(), type: 5 })).toEqual(
            unknown('type-unreadable', ['challenge.type']),
        );
        expect(read('challenge.tags', { ...baseChallenge(), tags: 'x' })).toEqual(
            unknown('tags-unreadable', ['challenge.tags']),
        );
        expect(read('challenge.tags', { ...baseChallenge(), tags: ['x', 5] })).toEqual(
            unknown('tags-unreadable', ['challenge.tags']),
        );
        expect(read('challenge.start', without('start_time'))).toEqual(
            unknown('start-time-unreadable', ['challenge.start_time']),
        );
        expect(read('challenge.end', { ...baseChallenge(), close_time: 'x' })).toEqual(
            unknown('close-time-unreadable', ['challenge.close_time']),
        );
        expect(read('challenge.timeLeft', without('close_time'))).toEqual(
            unknown('close-time-unreadable', ['challenge.close_time']),
        );
        expect(read('challenge.timeLeft', undefined, { now: END })).toEqual(
            unknown('challenge-closed', ['challenge.close_time']),
        );
        expect(read('challenge.elapsed', without('start_time'))).toEqual(
            unknown('start-time-unreadable', ['challenge.start_time']),
        );
        expect(read('challenge.elapsed', undefined, { now: START - 1 })).toEqual(
            unknown('challenge-not-started', ['challenge.start_time']),
        );
        expect(read('challenge.elapsedPercent', without('close_time'))).toEqual(
            unknown('span-unreadable', ['challenge.start_time', 'challenge.close_time']),
        );
        expect(read('challenge.elapsedPercent', { ...baseChallenge(), close_time: START })).toEqual(
            unknown('span-unreadable', ['challenge.start_time', 'challenge.close_time']),
        );
        expect(read('challenge.elapsedPercent', undefined, { now: START - 1 })).toEqual(
            unknown('challenge-not-started', ['challenge.start_time']),
        );
    });
});

describe('challenge numbers', () => {
    test('known', () => {
        expect(read('challenge.entries')).toEqual(known(3));
        expect(read('challenge.freeSlots')).toEqual(known(1));
        expect(read('challenge.exposure')).toEqual(known(40));
        expect(read('challenge.rank')).toEqual(known(12));
        expect(read('challenge.votes')).toEqual(known(70));
    });

    test('the entry count of a challenge with no readable list is zero, as before; free slots never go negative', () => {
        expect(read('challenge.entries', {})).toEqual(known(0));
        expect(read('challenge.freeSlots', { ...baseChallenge(), max_photo_submits: 2 })).toEqual(known(0));
    });

    test('an unranked challenge has no rank: absent, not rank zero', () => {
        const unranked = (rank: number) => withMember({ ranking: { total: { rank } } });
        expect(read('challenge.rank', unranked(0))).toEqual(absent('not-present'));
        expect(read('challenge.rank', unranked(-1))).toEqual(absent('not-present'));
    });

    test('unknown when the number is missing or not finite', () => {
        const bare = withMember({});
        expect(read('challenge.freeSlots', without('max_photo_submits'))).toEqual(
            unknown('max-photo-submits-unreadable', ['challenge.max_photo_submits']),
        );
        expect(read('challenge.exposure', bare)).toEqual(unknown('exposure-unreadable', ['member.ranking.exposure']));
        expect(read('challenge.rank', bare)).toEqual(unknown('rank-unreadable', ['member.ranking.total']));
        expect(read('challenge.votes', bare)).toEqual(unknown('votes-unreadable', ['member.ranking.total']));
        expect(read('challenge.votes', withMember({ ranking: { total: { votes: 'x' } } }))).toEqual(
            unknown('votes-unreadable', ['member.ranking.total']),
        );
        expect(
            read('challenge.exposure', withMember({ ranking: { exposure: { exposure_factor: Infinity } } })),
        ).toEqual(unknown('exposure-unreadable', ['member.ranking.exposure']));
    });
});

describe('boost', () => {
    test('AVAILABLE with a finite positive timeout: the free expiry is that instant', () => {
        const boost = withBoost({ state: 'AVAILABLE', timeout: 1_799_956_800 });
        expect(read('boost.state', boost)).toEqual(known('AVAILABLE'));
        expect(read('boost.freeExpiry', boost)).toEqual(known(1_799_956_800));
        expect(read('boost.freeRemaining', boost)).toEqual(known(1_799_956_800 - NOW));
    });

    test('the remaining time may be negative while the state still says AVAILABLE', () => {
        const boost = withBoost({ state: 'AVAILABLE', timeout: NOW - 30 });
        expect(read('boost.freeExpiry', boost)).toEqual(known(NOW - 30));
        expect(read('boost.freeRemaining', boost)).toEqual(known(-30));
    });

    test.each([
        ['AVAILABLE with no timeout', { state: 'AVAILABLE' }],
        ['AVAILABLE with a null timeout', { state: 'AVAILABLE', timeout: null }],
        ['AVAILABLE with a zero timeout', { state: 'AVAILABLE', timeout: 0 }],
        ['AVAILABLE with a negative timeout', { state: 'AVAILABLE', timeout: -5 }],
        ['AVAILABLE_KEY', { state: 'AVAILABLE_KEY' }],
        ['AVAILABLE_KEY with a timeout', { state: 'AVAILABLE_KEY', timeout: NOW + 100 }],
        ['USED', { state: 'USED', timeout: NOW + 100 }],
        ['MISSED', { state: 'MISSED' }],
        ['LOCKED', { state: 'LOCKED' }],
        ['UNAVAILABLE', { state: 'UNAVAILABLE' }],
    ])('%s: the free expiry is absent, not applicable', (_name, boost) => {
        expect(read('boost.freeExpiry', withBoost(boost))).toEqual(absent('not-applicable'));
        expect(read('boost.freeRemaining', withBoost(boost))).toEqual(absent('not-applicable'));
    });

    test('a free expiry is never derived from the challenge close', () => {
        expect(read('boost.freeExpiry', withBoost({ state: 'AVAILABLE_KEY' }))).not.toEqual(known(END));
        expect(read('boost.freeExpiry', withBoost({ state: 'AVAILABLE' }))).toEqual(absent('not-applicable'));
    });

    test.each([
        ['a missing boost', withMember({}), 'boost-state-unreadable'],
        ['a missing state', withBoost({}), 'boost-state-unreadable'],
        ['a state that is not a string', withBoost({ state: 5 }), 'boost-state-unreadable'],
        ['an unrecognized state', withBoost({ state: 'WEIRD' }), 'boost-state-unrecognized'],
        [
            'a timeout of the wrong type',
            withBoost({ state: 'AVAILABLE', timeout: '1799956800' }),
            'boost-timeout-malformed',
        ],
        [
            'a timeout that is not a number',
            withBoost({ state: 'AVAILABLE', timeout: Number.NaN }),
            'boost-timeout-malformed',
        ],
        ['an infinite timeout', withBoost({ state: 'AVAILABLE', timeout: Infinity }), 'boost-timeout-malformed'],
    ])('%s: the free expiry is unknown', (_name, challenge, reason) => {
        for (const name of ['boost.freeExpiry', 'boost.freeRemaining']) {
            expect(read(name, challenge)).toEqual(
                unknown(
                    reason,
                    reason === 'boost-timeout-malformed' ? ['member.boost.timeout'] : ['member.boost.state'],
                ),
            );
        }
    });

    test('the state fact is known for any string, unknown otherwise', () => {
        expect(read('boost.state', withBoost({ state: 'WEIRD' }))).toEqual(known('WEIRD'));
        expect(read('boost.state', withBoost({ state: 5 }))).toEqual(
            unknown('boost-state-unreadable', ['member.boost.state']),
        );
        expect(read('boost.state', withMember({}))).toEqual(unknown('boost-state-unreadable', ['member.boost.state']));
    });
});

describe('turbo', () => {
    test('known', () => {
        expect(read('turbo.state')).toEqual(known('TIMER'));
        expect(read('turbo.mode')).toEqual(known('classic'));
        expect(read('turbo.opensAt')).toEqual(known(NOW + 600));
    });

    test('absent: no mode reported, no timer', () => {
        const idle = withTurbo({ state: 'FREE' });
        expect(read('turbo.mode', idle)).toEqual(absent('not-present'));
        expect(read('turbo.mode', withTurbo({ state: 'FREE', mode: null }))).toEqual(absent('not-present'));
        for (const turbo of [
            { state: 'FREE' },
            { state: 'FREE', time_to_open: null },
            { state: 'FREE', time_to_open: 0 },
            { state: 'WON', time_to_open: -1 },
        ]) {
            expect(read('turbo.opensAt', withTurbo(turbo))).toEqual(absent('not-applicable'));
        }
    });

    test('unknown: no turbo object, or malformed fields', () => {
        const missing = withMember({});
        expect(read('turbo.state', missing)).toEqual(unknown('turbo-unreadable', ['member.turbo']));
        expect(read('turbo.mode', missing)).toEqual(unknown('turbo-unreadable', ['member.turbo']));
        expect(read('turbo.opensAt', missing)).toEqual(unknown('turbo-unreadable', ['member.turbo']));
        expect(read('turbo.state', withTurbo({ state: 5 }))).toEqual(
            unknown('turbo-state-unreadable', ['member.turbo.state']),
        );
        expect(read('turbo.state', withTurbo({}))).toEqual(unknown('turbo-state-unreadable', ['member.turbo.state']));
        expect(read('turbo.mode', withTurbo({ mode: 5 }))).toEqual(
            unknown('turbo-mode-malformed', ['member.turbo.mode']),
        );
        expect(read('turbo.opensAt', withTurbo({ time_to_open: 'soon' }))).toEqual(
            unknown('turbo-time-malformed', ['member.turbo.time_to_open']),
        );
        expect(read('turbo.opensAt', withTurbo({ time_to_open: Number.NaN }))).toEqual(
            unknown('turbo-time-malformed', ['member.turbo.time_to_open']),
        );
    });

    test('there is no won-turbo expiry fact', () => {
        expect(Object.keys(FACTS).filter((name) => name.startsWith('turbo.'))).toEqual([
            'turbo.state',
            'turbo.mode',
            'turbo.opensAt',
        ]);
    });
});

describe('balance', () => {
    test('known', () => {
        expect(read('balance.keys')).toEqual(known(1));
        expect(read('balance.swaps')).toEqual(known(3));
        expect(read('balance.fills')).toEqual(known(0));
        expect(read('balance.coins')).toEqual(known(100));
    });

    test('a missing bankroll is unknown, never zero', () => {
        for (const bankroll of [null, undefined]) {
            expect(read('balance.keys', undefined, { bankroll })).toEqual(
                unknown('bankroll-unavailable', ['bankroll']),
            );
        }
    });

    test('a malformed amount is unknown, never zero', () => {
        for (const amount of ['x', Number.NaN, null, undefined, Infinity]) {
            expect(read('balance.coins', undefined, { bankroll: { coins: amount } })).toEqual(
                unknown('balance-malformed', ['bankroll']),
            );
        }
        expect(read('balance.coins', undefined, { bankroll: { keys: 1 } })).toEqual(
            unknown('balance-malformed', ['bankroll']),
        );
    });
});

describe('entry facts', () => {
    const history = { a: [[NOW - 2 * H, 0]], b: [[NOW - 2 * H, 10]], c: [[NOW - 2 * H, 10]] };
    const readEntry = (
        name: string,
        select?: ScenarioSelector,
        extra: Partial<Record<keyof FactSnapshot, unknown>> = {},
        challenge?: Record<string, unknown>,
        window?: string | number,
    ) => readScenarioFact(invalid(name), snapshot(challenge, extra), select, window);
    const withHistory = { state: { phaseEnteredAt: NOW, memory: { held: 'b' }, history } };

    test('votes, rank and the flags of the selected entry', () => {
        expect(readEntry('entry.votes', { by: 'mostVotes' })).toEqual(known(50));
        expect(readEntry('entry.rank', { by: 'bestRank' })).toEqual(known(5));
        expect(readEntry('entry.boosted', { by: 'memory', slot: 'held' })).toEqual(known(true));
        expect(readEntry('entry.turbo', { by: 'slot', index: 1 })).toEqual(known(false));
        expect(readEntry('entry.boosting', { by: 'turbo' })).toEqual(known(true));
        expect(readEntry('entry.boosted', { by: 'turbo' })).toEqual(known(false));
    });

    test('votes read as zero when the field is not a number, as the selectors do', () => {
        const challenge = withMember({ ranking: { entries: [{ id: 'u', votes: 'x' }] } });
        expect(readEntry('entry.votes', { by: 'slot', index: 1 }, {}, challenge)).toEqual(known(0));
    });

    test('an unranked entry has no rank: absent, not rank zero', () => {
        expect(readEntry('entry.rank', { by: 'slot', index: 3 })).toEqual(absent('not-present'));
    });

    test('speed facts need history', () => {
        expect(readEntry('entry.votesPerHour', { by: 'slot', index: 1 }, withHistory)).toEqual(known((10 - 0) / 2));
        expect(readEntry('entry.speedRatio', { by: 'slot', index: 1 }, withHistory)).toEqual(known(0.5));
        expect(readEntry('entry.votesPerHour', { by: 'slot', index: 1 })).toEqual(
            unknown('insufficient-history', ['vote-history']),
        );
        expect(readEntry('entry.speedRatio', { by: 'slot', index: 1 })).toEqual(
            unknown('insufficient-history', ['vote-history']),
        );
    });

    test('a speed cannot be measured without a readable clock', () => {
        const slot = { by: 'slot', index: 1 } satisfies ScenarioSelector;
        for (const name of ['entry.votesPerHour', 'entry.speedRatio']) {
            expect(readEntry(name, slot, { ...withHistory, now: Number.NaN })).toEqual(
                unknown('clock-unreadable', ['clock']),
            );
        }
    });

    test('the window narrows the speed measurement', () => {
        const shortHistory = {
            state: {
                phaseEnteredAt: NOW,
                memory: {},
                history: {
                    a: [
                        [NOW - 2 * H, 0],
                        [NOW - 30 * 60, 4],
                    ],
                },
            },
        };
        const slot = { by: 'slot', index: 1 } satisfies ScenarioSelector;
        expect(readEntry('entry.votesPerHour', slot, shortHistory)).toEqual(known(5));
        expect(readEntry('entry.votesPerHour', slot, shortHistory, undefined, 600)).toEqual(known(12));
        expect(readEntry('entry.votesPerHour', slot, shortHistory, undefined, '3h')).toEqual(known(5));
    });

    test('fastest finds the quickest entry, or cannot say without history', () => {
        expect(readEntry('entry.votes', { by: 'fastest' }, withHistory)).toEqual(known(50));
        expect(readEntry('entry.votes', { by: 'fastest' })).toEqual(unknown('insufficient-history', ['vote-history']));
    });

    test('absent when the selector proves there is no such entry', () => {
        expect(readEntry('entry.votes', { by: 'memory', slot: 'gone' })).toEqual(absent('not-present'));
        expect(
            readEntry(
                'entry.votes',
                { by: 'memory', slot: 'held' },
                {},
                withMember({ ranking: { entries: [{ id: 'z' }] } }),
            ),
        ).toEqual(absent('not-present'));
        expect(
            readEntry('entry.votes', { by: 'slot', index: 1 }, {}, withMember({ ranking: { entries: [] } })),
        ).toEqual(absent('not-present'));
        expect(
            readEntry('entry.boosted', { by: 'bestRank' }, {}, withMember({ ranking: { entries: [{ id: 'u' }] } })),
        ).toEqual(absent('not-present'));
    });

    test('unknown when the entry list cannot be read, or no selector was given', () => {
        expect(readEntry('entry.votes', { by: 'mostVotes' }, {}, withMember({}))).toEqual(
            unknown('entries-unreadable', ['member.ranking.entries']),
        );
        expect(readEntry('entry.votes', { by: 'mostVotes' }, {}, withMember({ ranking: { entries: 'x' } }))).toEqual(
            unknown('entries-unreadable', ['member.ranking.entries']),
        );
        expect(readEntry('entry.votes')).toEqual(unknown('selector-missing', []));
    });

    test('readEntryField and readableEntries serve the entry predicates', () => {
        const [first, second] = entries();
        const snap = snapshot();
        expect(readEntryField('votes', first, snap)).toEqual(known(10));
        expect(readEntryField('rank', second, snap)).toEqual(known(5));
        expect(readEntryField('rank', entries()[2], snap)).toEqual(absent('not-present'));
        expect(readEntryField('boosted', second, snap)).toEqual(known(true));
        expect(readEntryField('votesPerHour', first, snap)).toEqual(unknown('insufficient-history', ['vote-history']));
        expect(readableEntries(snap.challenge)).toHaveLength(3);
        expect(readableEntries(invalid<Challenge>({}))).toBeNull();
    });
});
