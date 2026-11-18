/**
 * The pure fact registry: every registered fact answers known, absent or unknown from the evidence the current
 * condition context carries, and never turns missing or malformed evidence into a default.
 */

import type * as factsModule from '../../src/ts/core/scenarios/facts';
import type * as selectorsModule from '../../src/ts/core/scenarios/selectors';
import type * as vocabularyModule from '../../src/ts/core/scenarios/vocabulary';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import type { FactName, ScenarioSelector } from '../../src/ts/core/types/scenario';
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

    test('a fact is usable in a rule when its stage list holds the active stage, and refused with the stage message otherwise', () => {
        const refused = vocabulary.FACT_NAMES.filter((name) => factStageIssues(name, 'active', 'p').length > 0);
        expect(refused).toEqual(['rewards.claimable', 'rewards.claimableCount']);
        expect(factStageIssues('rewards.claimable', 'active', 'p')).toEqual([
            { path: 'p', message: 'rewards.claimable is not available while a challenge is active' },
        ]);
        expect(factStageIssues('rewards.claimableCount', 'active', 'p')).toEqual([
            { path: 'p', message: 'rewards.claimableCount is not available while a challenge is active' },
        ]);
        for (const name of vocabulary.FACT_NAMES.filter((item) => !refused.includes(item))) {
            expect(FACTS[name].stages).toContain('active');
        }
    });

    test('the new facts list the stages the plan gives them', () => {
        const stages = (prefix: string) =>
            Object.fromEntries(
                Object.entries(FACTS)
                    .filter(([name]) => name.startsWith(prefix))
                    .map(([name, fact]) => [name, [...fact.stages]]),
            );
        expect(stages('missions.')).toEqual({
            'missions.joinNeed': ['account', 'active'],
            'missions.fillNeed': ['account', 'active'],
            'missions.turboNeed': ['account', 'active'],
            'missions.boostNeed': ['account', 'active'],
            'missions.voteNeed': ['account', 'active'],
            'missions.nextExpiry': ['account', 'active'],
        });
        expect(stages('rewards.')).toEqual({
            'rewards.claimable': ['postClose'],
            'rewards.claimableCount': ['account'],
        });
        expect(stages('photos.')).toEqual({
            'photos.eligibleCount': ['preJoin', 'active'],
            'photos.eligibleAtLeast': ['preJoin', 'active'],
            'photos.hasEligible': ['preJoin', 'active'],
        });
        expect(FACTS['challenge.joinPrice'].stages).toEqual(['preJoin', 'active']);
        expect(FACTS['challenge.membership'].stages).toEqual(['preJoin', 'active']);
        expect(FACTS['boost.open'].stages).toEqual(['active']);
        expect(FACTS['entry.minAge'].stages).toEqual(['active']);
    });

    test('photo facts depend on settings (policy); every other new fact is raw evidence', () => {
        const policy = Object.entries(FACTS)
            .filter(([, fact]) => fact.classification === 'policy')
            .map(([name]) => name);
        expect(policy.sort()).toEqual(['photos.eligibleAtLeast', 'photos.eligibleCount', 'photos.hasEligible']);
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
            {
                id: {},
                title: 5,
                type: 5,
                tags: 'x',
                start_time: 'x',
                close_time: 'x',
                max_photo_submits: 'x',
                players: 'x',
                max_players: 'x',
                join_coins: 'x',
            },
            { join_coins: 2.5, member: { submit_state: 'join_unlock' } },
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
            {
                missions: {
                    readable: true,
                    needs: { join: 'x' },
                    unreadable: ['join'],
                    nextExpiry: 'x',
                    expiryUnreadable: true,
                },
            },
            { rewards: { readable: true, claimable: [], listed: [], complete: false } },
            { entryAges: { readable: true, times: { a: { at: 'x', exact: 'x' } } } },
            { uncertain: { readable: true, ids: 'x' } },
            { photoScan: { readable: true, eligible: 'x', complete: 'x' } },
            { pins: null, rewards: null, missions: 'x' },
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
        expect(readableEntries(invalid<Challenge>(snap.challenge))).toHaveLength(3);
        expect(readableEntries(invalid<Challenge>({}))).toBeNull();
    });
});

const readSel = (
    name: string,
    select: ScenarioSelector | undefined,
    extra: Partial<Record<keyof FactSnapshot, unknown>> = {},
    challenge?: Record<string, unknown>,
) => readScenarioFact(invalid(name), snapshot(challenge, extra), select);

const withSubmitState = (state: unknown, extra: Record<string, unknown> = {}) => ({
    ...baseChallenge(),
    ...extra,
    member: { ...(baseChallenge().member as Record<string, unknown>), submit_state: state },
});

describe('membership, capacity and join price', () => {
    test('players, caps and the price read from the listing', () => {
        const challenge = { ...withSubmitState('join'), players: 40, max_players: 100, join_coins: 25 };
        expect(read('challenge.players', challenge)).toEqual(known(40));
        expect(read('challenge.maxPlayers', challenge)).toEqual(known(100));
        expect(read('challenge.maxPhotoSubmits', challenge)).toEqual(known(4));
        expect(read('challenge.joinPrice', challenge)).toEqual(known(25));
        expect(read('challenge.membership', challenge)).toEqual(known('join'));
    });

    test('no cap (a missing, null or zero max_players) is confirmed absent', () => {
        for (const max of [undefined, null, 0]) {
            expect(read('challenge.maxPlayers', { ...baseChallenge(), max_players: max })).toEqual(
                absent('not-applicable'),
            );
        }
    });

    test('a free challenge has a zero price, whether the field is zero or missing', () => {
        expect(read('challenge.joinPrice', { ...baseChallenge(), join_coins: 0 })).toEqual(known(0));
        expect(read('challenge.joinPrice', baseChallenge())).toEqual(known(0));
        expect(read('challenge.joinPrice', { ...baseChallenge(), join_coins: null })).toEqual(known(0));
    });

    test.each([
        ['players', 'challenge.players', 'players'],
        ['max_players', 'challenge.maxPlayers', 'max_players'],
        ['max_photo_submits', 'challenge.maxPhotoSubmits', 'max_photo_submits'],
    ])('a malformed %s count is unknown, never zero', (field, name, dependency) => {
        for (const bad of ['x', -1, Number.NaN, {}]) {
            expect(read(name, { ...baseChallenge(), [field]: bad })).toEqual(
                unknown(`${field}-unreadable`, [`challenge.${dependency}`]),
            );
        }
    });

    test('a missing players or max_photo_submits count is unknown', () => {
        expect(read('challenge.players', baseChallenge())).toEqual(
            unknown('players-unreadable', ['challenge.players']),
        );
        expect(read('challenge.maxPhotoSubmits', without('max_photo_submits'))).toEqual(
            unknown('max_photo_submits-unreadable', ['challenge.max_photo_submits']),
        );
    });

    test.each([
        ['a text price', { join_coins: 'x' }, 'join'],
        ['a negative price', { join_coins: -5 }, 'join'],
        ['a fractional price', { join_coins: 2.5 }, 'join'],
        ['a fractional price on an unlock', { join_coins: 2.5 }, 'join_unlock'],
        ['an unlock owed with no price', {}, 'join_unlock'],
        ['an unlock owed with a zero price', { join_coins: 0 }, 'join_unlock'],
    ])('%s is an unreadable price', (_name, extra, state) => {
        expect(read('challenge.joinPrice', withSubmitState(state, extra))).toEqual(
            unknown('join-price-unreadable', ['challenge.join_coins', 'member.submit_state']),
        );
    });

    test('an unlock owed with a whole positive price reads that price', () => {
        expect(read('challenge.joinPrice', withSubmitState('join_unlock', { join_coins: 40 }))).toEqual(known(40));
    });

    test('membership is the submit state, and is not inferred from the member object being there', () => {
        for (const state of ['join', 'join_unlock', 'OPEN', 'FULL']) {
            expect(read('challenge.membership', withSubmitState(state))).toEqual(known(state));
        }
        for (const bad of [undefined, null, '', 5]) {
            expect(read('challenge.membership', withSubmitState(bad))).toEqual(
                unknown('membership-unreadable', ['member.submit_state']),
            );
        }
        // a member object with ranking, boost and turbo is not evidence of anything
        expect(read('challenge.membership', baseChallenge()).state).toBe('unknown');
        expect(read('challenge.membership', { ...baseChallenge(), member: undefined }).state).toBe('unknown');
    });
});

describe('boost readiness', () => {
    test('open: a key-unlocked boost, a timed boost with time left, and an untimed one are open', () => {
        expect(read('boost.open', withBoost({ state: 'AVAILABLE_KEY' }))).toEqual(known(true));
        expect(read('boost.open', withBoost({ state: 'AVAILABLE', timeout: NOW + 60 }))).toEqual(known(true));
        expect(read('boost.open', withBoost({ state: 'AVAILABLE' }))).toEqual(known(true));
    });

    test('open: a timer that has run out, and a state that is not available, are closed', () => {
        expect(read('boost.open', withBoost({ state: 'AVAILABLE', timeout: NOW - 1 }))).toEqual(known(false));
        for (const state of ['LOCKED', 'MISSED', 'USED', 'UNAVAILABLE']) {
            expect(read('boost.open', withBoost({ state }))).toEqual(known(false));
        }
    });

    test('keyUnlocked: AVAILABLE_KEY and AVAILABLE with no countdown; a timed or closed boost is not', () => {
        expect(read('boost.keyUnlocked', withBoost({ state: 'AVAILABLE_KEY' }))).toEqual(known(true));
        expect(read('boost.keyUnlocked', withBoost({ state: 'AVAILABLE', timeout: 0 }))).toEqual(known(true));
        expect(read('boost.keyUnlocked', withBoost({ state: 'AVAILABLE', timeout: NOW + 60 }))).toEqual(known(false));
        expect(read('boost.keyUnlocked', withBoost({ state: 'USED' }))).toEqual(known(false));
    });

    test.each([
        ['a missing state', withBoost({}), 'boost-state-unreadable', ['member.boost.state']],
        ['an unrecognized state', withBoost({ state: 'WEIRD' }), 'boost-state-unrecognized', ['member.boost.state']],
        [
            'a malformed timer on a timed boost',
            withBoost({ state: 'AVAILABLE', timeout: 'x' }),
            'boost-timeout-malformed',
            ['member.boost.timeout'],
        ],
    ])('%s: open and keyUnlocked are unknown, never false', (_name, challenge, reason, dependencies) => {
        expect(read('boost.open', challenge)).toEqual(unknown(reason, dependencies));
        expect(read('boost.keyUnlocked', challenge)).toEqual(unknown(reason, dependencies));
    });

    test('open needs the clock; keyUnlocked does not', () => {
        const boost = withBoost({ state: 'AVAILABLE', timeout: NOW + 60 });
        expect(read('boost.open', boost, { now: Number.NaN })).toEqual(unknown('clock-unreadable', ['clock']));
        expect(read('boost.keyUnlocked', boost, { now: Number.NaN })).toEqual(known(false));
    });
});

const mission = (over: Record<string, unknown> = {}) => ({
    readable: true,
    needs: { join: 5, fill: 2, turbo: 0, boost: 1, vote: 300 },
    unreadable: [],
    nextExpiry: NOW + 600,
    expiryUnreadable: false,
    ...over,
});

describe('missions', () => {
    test.each([
        ['missions.joinNeed', 5],
        ['missions.fillNeed', 2],
        ['missions.turboNeed', 0],
        ['missions.boostNeed', 1],
        ['missions.voteNeed', 300],
    ])('%s reads its need from the evidence (a read list with no need is a known zero)', (name, need) => {
        expect(read(name, undefined, { missions: mission() })).toEqual(known(need));
    });

    test('the next expiry is the earliest of an unfinished mission, absent when none has one', () => {
        expect(read('missions.nextExpiry', undefined, { missions: mission() })).toEqual(known(NOW + 600));
        expect(read('missions.nextExpiry', undefined, { missions: mission({ nextExpiry: null }) })).toEqual(
            absent('not-present'),
        );
    });

    test('mission facts are unknown until the evidence is loaded', () => {
        for (const name of ['missions.joinNeed', 'missions.voteNeed', 'missions.nextExpiry']) {
            expect(read(name)).toEqual(unknown('evidence-not-loaded', ['missions']));
        }
    });

    test('a failed mission read makes every mission fact unknown, never zero or absent', () => {
        const failed = { missions: { readable: false, reason: 'missions-unreadable' } };
        for (const name of [
            'missions.joinNeed',
            'missions.fillNeed',
            'missions.turboNeed',
            'missions.boostNeed',
            'missions.voteNeed',
            'missions.nextExpiry',
        ]) {
            expect(read(name, undefined, failed)).toEqual(unknown('missions-unreadable', ['missions']));
        }
    });

    test('a kind with a mission whose progress cannot be read is unknown; the other kinds are not', () => {
        const evidence = { missions: mission({ unreadable: ['fill'] }) };
        expect(read('missions.fillNeed', undefined, evidence)).toEqual(
            unknown('mission-progress-unreadable', ['missions']),
        );
        expect(read('missions.joinNeed', undefined, evidence)).toEqual(known(5));
    });

    test('a malformed need or expiry is unknown, never zero', () => {
        expect(read('missions.joinNeed', undefined, { missions: mission({ needs: { join: 'x' } }) })).toEqual(
            unknown('mission-need-malformed', ['missions']),
        );
        expect(read('missions.joinNeed', undefined, { missions: mission({ needs: {} }) })).toEqual(
            unknown('mission-need-malformed', ['missions']),
        );
        expect(read('missions.joinNeed', undefined, { missions: mission({ needs: -1 }) })).toEqual(
            unknown('mission-need-malformed', ['missions']),
        );
        expect(read('missions.nextExpiry', undefined, { missions: mission({ expiryUnreadable: true }) })).toEqual(
            unknown('mission-expiry-unreadable', ['missions']),
        );
        expect(read('missions.nextExpiry', undefined, { missions: mission({ nextExpiry: 'soon' }) })).toEqual(
            unknown('mission-expiry-unreadable', ['missions']),
        );
    });

    test('evidence of the wrong shape is unknown (evidence-malformed)', () => {
        for (const bad of ['x', {}, { readable: 'yes' }, { readable: false }, null]) {
            expect(read('missions.joinNeed', undefined, { missions: bad })).toEqual(
                unknown('evidence-malformed', ['missions']),
            );
        }
    });
});

describe('the subject of a snapshot', () => {
    const installation = { challenge: undefined, subject: { kind: 'installation' } };
    const closed = {
        challenge: undefined,
        subject: { kind: 'completed', challenge: { id: 9, title: 'Done' }, provenance: 'completed-list' },
    };

    test.each(['challenge.entries', 'boost.state', 'challenge.end', 'challenge.type'])(
        'a fact about the challenge, %s, is unknown for a subject that has none',
        (name) => {
            // the answer names the evidence the fact declares, as every unknown answer does
            const declared = [...FACTS[invalid<FactName>(name)].dependencies];
            expect(read(name, undefined, installation)).toEqual(unknown('no-challenge', declared));
            expect(read(name, undefined, closed)).toEqual(unknown('no-challenge', declared));
        },
    );

    test('the identity of a closed challenge is what its listing row gives; the clock and the account read as ever', () => {
        expect(read('challenge.id', undefined, closed)).toEqual(known('9'));
        expect(read('challenge.title', undefined, closed)).toEqual(known('Done'));
        expect(read('clock.now', undefined, closed)).toEqual(known(NOW));
        expect(read('balance.coins', undefined, installation)).toEqual(known(100));
        // an installation has no identity
        expect(read('challenge.id', undefined, installation)).toEqual(unknown('id-unreadable', ['challenge.id']));
    });

    test('an entry’s own reading of its speed needs the challenge’s entries: with none to read, the history is not enough', () => {
        const entry = entries()[0];
        expect(readEntryField('speedRatio', entry, snapshot(undefined, installation))).toEqual(
            unknown('insufficient-history', ['vote-history']),
        );
    });

    test('a snapshot that names no subject is an active challenge’s, as it always was', () => {
        expect(read('challenge.id')).toEqual(known('7'));
        expect(read('challenge.entries')).toEqual(known(3));
    });
});

describe('rewards', () => {
    const rewards = (over: Record<string, unknown> = {}) => ({
        readable: true,
        claimable: ['7', '12'],
        listed: ['7', '12', '30'],
        complete: true,
        ...over,
    });

    // The subject of a post-close read: a completed challenge as the completed listing gives it.
    const completed = (id: unknown) => ({
        subject: { kind: 'completed', challenge: { id }, provenance: 'completed-list' },
    });

    test('claimable: true when the read lists the subject as claimable', () => {
        expect(read('rewards.claimable', undefined, { rewards: rewards(), ...completed(7) })).toEqual(known(true));
    });

    test('claimable: false when the read lists the subject as not claimable, or the finished listing lacks it', () => {
        expect(read('rewards.claimable', undefined, { rewards: rewards(), ...completed(30) })).toEqual(known(false));
        expect(read('rewards.claimable', undefined, { rewards: rewards(), ...completed(99) })).toEqual(known(false));
    });

    test('claimable: unknown when a capped listing never reached the subject', () => {
        expect(
            read('rewards.claimable', undefined, { rewards: rewards({ complete: false }), ...completed(99) }),
        ).toEqual(unknown('rewards-list-incomplete', ['rewards']));
        // a lower bound still proves a claimable subject
        expect(
            read('rewards.claimable', undefined, { rewards: rewards({ complete: false }), ...completed(7) }),
        ).toEqual(known(true));
    });

    test('claimable: unknown for a subject with no readable id', () => {
        expect(read('rewards.claimable', undefined, { rewards: rewards(), ...completed(undefined) })).toEqual(
            unknown('id-unreadable', ['challenge.id']),
        );
    });

    test('claimable: unknown for a subject that is not a completed challenge (an active one is never cast to one)', () => {
        expect(read('rewards.claimable', undefined, { rewards: rewards() })).toEqual(
            unknown('subject-not-completed', ['challenge.id']),
        );
    });

    test('claimableCount: the claimable ones of a finished listing; unknown while it is capped', () => {
        expect(read('rewards.claimableCount', undefined, { rewards: rewards() })).toEqual(known(2));
        expect(read('rewards.claimableCount', undefined, { rewards: rewards({ claimable: [] }) })).toEqual(known(0));
        expect(read('rewards.claimableCount', undefined, { rewards: rewards({ complete: false }) })).toEqual(
            unknown('rewards-list-incomplete', ['rewards']),
        );
    });

    test('not loaded, a failed read and malformed lists are unknown for both facts', () => {
        for (const name of ['rewards.claimable', 'rewards.claimableCount']) {
            expect(read(name)).toEqual(unknown('evidence-not-loaded', ['rewards']));
            expect(read(name, undefined, { rewards: { readable: false, reason: 'rewards-unreadable' } })).toEqual(
                unknown('rewards-unreadable', ['rewards']),
            );
            expect(read(name, undefined, { rewards: rewards({ claimable: 'x' }) })).toEqual(
                unknown('evidence-malformed', ['rewards']),
            );
            expect(read(name, undefined, { rewards: rewards({ complete: 'x' }) })).toEqual(
                unknown('evidence-malformed', ['rewards']),
            );
        }
    });
});

describe('entry age', () => {
    const slotA: ScenarioSelector = { by: 'slot', index: 1 };
    const ages = (times: Record<string, unknown>) => ({ entryAges: { readable: true, times } });

    test('an exact time gives the age, the lower bound and the flag', () => {
        const evidence = ages({ a: { at: NOW - 900, exact: true } });
        expect(readSel('entry.age', slotA, evidence)).toEqual(known(900));
        expect(readSel('entry.minAge', slotA, evidence)).toEqual(known(900));
        expect(readSel('entry.ageExact', slotA, evidence)).toEqual(known(true));
    });

    test('an observed time gives only a lower bound: age is unknown, minAge and the flag are known', () => {
        const evidence = ages({ a: { at: NOW - 900, exact: false } });
        expect(readSel('entry.age', slotA, evidence)).toEqual(unknown('age-observed-only', ['entry-ages']));
        expect(readSel('entry.minAge', slotA, evidence)).toEqual(known(900));
        expect(readSel('entry.ageExact', slotA, evidence)).toEqual(known(false));
    });

    test('an entry the ledger has no time for is unknown, not new', () => {
        for (const name of ['entry.age', 'entry.minAge', 'entry.ageExact']) {
            expect(readSel(name, slotA, ages({ b: { at: NOW - 5, exact: true } }))).toEqual(
                unknown('entry-age-unrecorded', ['entry-ages']),
            );
            expect(readSel(name, slotA, ages({ a: { at: 'x', exact: true } })).state).toBe('unknown');
            expect(readSel(name, slotA, ages({ a: { at: 0, exact: true } })).state).toBe('unknown');
            expect(readSel(name, slotA, ages({ a: { at: NOW - 5, exact: 'yes' } })).state).toBe('unknown');
        }
        expect(readSel('entry.age', slotA, { entryAges: { readable: true, times: 'x' } }).state).toBe('unknown');
    });

    test('a time in the future is unknown, never a negative age', () => {
        const evidence = ages({ a: { at: NOW + 60, exact: true } });
        expect(readSel('entry.age', slotA, evidence)).toEqual(unknown('age-in-future', ['clock', 'entry-ages']));
        expect(readSel('entry.minAge', slotA, evidence)).toEqual(unknown('age-in-future', ['clock', 'entry-ages']));
        expect(readSel('entry.ageExact', slotA, evidence)).toEqual(known(true));
    });

    test('an unreadable clock makes the ages unknown', () => {
        const evidence = ages({ a: { at: NOW - 900, exact: true } });
        expect(readSel('entry.age', slotA, { ...evidence, now: Number.NaN })).toEqual(
            unknown('clock-unreadable', ['clock']),
        );
    });

    test('not loaded and a failed ledger read are unknown for all three facts', () => {
        for (const name of ['entry.age', 'entry.minAge', 'entry.ageExact']) {
            expect(readSel(name, slotA)).toEqual(unknown('evidence-not-loaded', ['entry-ages']));
            expect(readSel(name, slotA, { entryAges: { readable: false, reason: 'entry-ages-unreadable' } })).toEqual(
                unknown('entry-ages-unreadable', ['entry-ages']),
            );
        }
    });

    test('the selection rules stay in front: an unreadable entry list, no entry and no selector', () => {
        const evidence = ages({ a: { at: NOW - 900, exact: true } });
        expect(readSel('entry.age', slotA, evidence, withMember({}))).toEqual(
            unknown('entries-unreadable', ['member.ranking.entries']),
        );
        expect(readSel('entry.age', { by: 'memory', slot: 'gone' }, evidence)).toEqual(absent('not-present'));
        expect(readSel('entry.age', undefined, evidence)).toEqual(unknown('selector-missing', []));
    });
});

describe('entry flags', () => {
    const slotA: ScenarioSelector = { by: 'slot', index: 1 };
    const held: ScenarioSelector = { by: 'memory', slot: 'held' };

    test('uncertainSubmission: true for a marked entry, false for an unmarked one', () => {
        const evidence = { uncertain: { readable: true, ids: ['b'] } };
        expect(readSel('entry.uncertainSubmission', held, evidence)).toEqual(known(true));
        expect(readSel('entry.uncertainSubmission', slotA, evidence)).toEqual(known(false));
    });

    test('pinned: true for the Boost or Turbo pin of the entry, false otherwise', () => {
        expect(readSel('entry.pinned', held, { pins: { readable: true, boost: 'b', turbo: null } })).toEqual(
            known(true),
        );
        expect(readSel('entry.pinned', held, { pins: { readable: true, boost: null, turbo: 'b' } })).toEqual(
            known(true),
        );
        expect(readSel('entry.pinned', slotA, { pins: { readable: true, boost: 'b', turbo: 'b' } })).toEqual(
            known(false),
        );
        expect(readSel('entry.pinned', held, { pins: { readable: true, boost: null, turbo: null } })).toEqual(
            known(false),
        );
    });

    test('not loaded, unreadable or malformed evidence is unknown', () => {
        expect(readSel('entry.uncertainSubmission', held)).toEqual(unknown('evidence-not-loaded', ['entry-uncertain']));
        expect(readSel('entry.pinned', held)).toEqual(unknown('evidence-not-loaded', ['entry-pins']));
        expect(
            readSel('entry.uncertainSubmission', held, {
                uncertain: { readable: false, reason: 'entry-ages-unreadable' },
            }),
        ).toEqual(unknown('entry-ages-unreadable', ['entry-uncertain']));
        expect(readSel('entry.pinned', held, { pins: { readable: false, reason: 'pins-unreadable' } })).toEqual(
            unknown('pins-unreadable', ['entry-pins']),
        );
        expect(readSel('entry.uncertainSubmission', held, { uncertain: { readable: true, ids: 'x' } })).toEqual(
            unknown('evidence-malformed', ['entry-uncertain']),
        );
    });

    test('an entry that is not there is absent, and the selection rules stay in front', () => {
        expect(
            readSel(
                'entry.pinned',
                { by: 'memory', slot: 'gone' },
                { pins: { readable: true, boost: 'b', turbo: null } },
            ),
        ).toEqual(absent('not-present'));
        expect(readSel('entry.uncertainSubmission', held, {}, withMember({}))).toEqual(
            unknown('entries-unreadable', ['member.ranking.entries']),
        );
    });
});

describe('photo candidates', () => {
    const scan = (over: Record<string, unknown> = {}) => ({
        photoScan: { readable: true, eligible: 3, complete: true, ...over },
    });

    test('a complete scan: the count is exact, the lower bound equals it, and eligibility is known', () => {
        expect(read('photos.eligibleCount', undefined, scan())).toEqual(known(3));
        expect(read('photos.eligibleAtLeast', undefined, scan())).toEqual(known(3));
        expect(read('photos.hasEligible', undefined, scan())).toEqual(known(true));
    });

    test('a complete scan that found none proves there are none', () => {
        expect(read('photos.eligibleCount', undefined, scan({ eligible: 0 }))).toEqual(known(0));
        expect(read('photos.eligibleAtLeast', undefined, scan({ eligible: 0 }))).toEqual(known(0));
        expect(read('photos.hasEligible', undefined, scan({ eligible: 0 }))).toEqual(known(false));
    });

    test('an incomplete scan gives a lower bound, and cannot prove zero', () => {
        expect(read('photos.eligibleCount', undefined, scan({ complete: false }))).toEqual(
            unknown('photo-scan-incomplete', ['photo-scan']),
        );
        expect(read('photos.eligibleAtLeast', undefined, scan({ complete: false }))).toEqual(known(3));
        expect(read('photos.hasEligible', undefined, scan({ complete: false }))).toEqual(known(true));
        expect(read('photos.eligibleAtLeast', undefined, scan({ complete: false, eligible: 0 }))).toEqual(known(0));
        expect(read('photos.hasEligible', undefined, scan({ complete: false, eligible: 0 }))).toEqual(
            unknown('photo-scan-incomplete', ['photo-scan']),
        );
    });

    test('not loaded, a failed scan and a malformed scan are unknown for all three facts', () => {
        for (const name of ['photos.eligibleCount', 'photos.eligibleAtLeast', 'photos.hasEligible']) {
            expect(read(name)).toEqual(unknown('evidence-not-loaded', ['photo-scan']));
            expect(read(name, undefined, { photoScan: { readable: false, reason: 'photo-scan-failed' } })).toEqual(
                unknown('photo-scan-failed', ['photo-scan']),
            );
            expect(read(name, undefined, scan({ eligible: 'x' }))).toEqual(
                unknown('evidence-malformed', ['photo-scan']),
            );
            expect(read(name, undefined, scan({ eligible: -1 }))).toEqual(
                unknown('evidence-malformed', ['photo-scan']),
            );
            expect(read(name, undefined, scan({ complete: 'x' }))).toEqual(
                unknown('evidence-malformed', ['photo-scan']),
            );
        }
    });
});

describe('entry facts through the evidence-reading selectors', () => {
    const readEntry = (select: ScenarioSelector, extra: Partial<Record<keyof FactSnapshot, unknown>> = {}) =>
        readScenarioFact(invalid('entry.votes'), snapshot(undefined, extra), select);

    test('id needs no evidence', () => {
        expect(readEntry({ by: 'id', id: 'b' })).toEqual(known(50));
        expect(readEntry({ by: 'id', id: 'zz' })).toEqual(absent('not-present'));
    });

    test('pinned reads the pinned photos, and is unknown while they are not loaded or unreadable', () => {
        const pins = { readable: true, boost: 'b', turbo: 'a' };
        expect(readEntry({ by: 'pinned', power: 'boost' }, { pins })).toEqual(known(50));
        expect(readEntry({ by: 'pinned', power: 'turbo' }, { pins })).toEqual(known(10));
        expect(readEntry({ by: 'pinned', power: 'turbo' })).toEqual(unknown('evidence-not-loaded', ['entry-pins']));
        expect(
            readEntry({ by: 'pinned', power: 'turbo' }, { pins: { readable: false, reason: 'pins-unreadable' } }),
        ).toEqual(unknown('pins-unreadable', ['entry-pins']));
    });

    test('pendingBoostTarget reads the photo the boost waits on', () => {
        expect(readEntry({ by: 'pendingBoostTarget' }, { pendingBoost: { readable: true, id: 'a' } })).toEqual(
            known(10),
        );
        expect(readEntry({ by: 'pendingBoostTarget' })).toEqual(
            unknown('evidence-not-loaded', ['entry-pending-boost']),
        );
    });

    test('newest and oldest read the entry times', () => {
        const entryAges = {
            readable: true,
            times: {
                a: { at: NOW - 900, exact: true },
                b: { at: NOW - 100, exact: true },
                c: { at: NOW - 500, exact: false },
            },
        };
        expect(readEntry({ by: 'newest', time: 'observed' }, { entryAges })).toEqual(known(50));
        expect(readEntry({ by: 'oldest', time: 'observed' }, { entryAges })).toEqual(known(10));
        expect(readEntry({ by: 'oldest', time: 'exact' }, { entryAges })).toEqual(
            unknown('entry-age-unusable', ['entry-ages']),
        );
        expect(readEntry({ by: 'newest', time: 'exact' })).toEqual(unknown('evidence-not-loaded', ['entry-ages']));
    });

    test('matching reads each entry field through the registry', () => {
        const select: ScenarioSelector = {
            by: 'matching',
            where: [{ field: 'votes', op: '>=', value: 10 }],
            order: 'votes',
            direction: 'desc',
        };
        expect(readEntry(select)).toEqual(known(50));
    });

    test('slowest reads the sampled vote history', () => {
        const history = { a: [[NOW - 2 * H, 0]], b: [[NOW - 2 * H, 10]], c: [[NOW - 2 * H, 10]] };
        const extra = { state: { phaseEnteredAt: NOW, memory: {}, history } };
        expect(readEntry({ by: 'slowest' }, extra)).toEqual(known(10));
    });
});
