/**
 * Rule stages in a scenario document: which stages a scope may declare, what an undeclared rule defaults to, and which
 * conditions, facts and actions are refused outside the stages they belong to. The three new actions (join,
 * claimChallengeReward, claimMissionReward) and the coin limit are shape-checked here too.
 */

import type * as scenarioSchemaModule from '../../src/ts/core/settings/scenarioSchema';
import type * as defaultsModule from '../../src/ts/core/settings/defaults';

const { validateScenario } = require('../../src/ts/core/settings/scenarioSchema') as typeof scenarioSchemaModule;
const { schemaDefaults } = require('../../src/ts/core/settings/defaults') as typeof defaultsModule;

const globalDefaults = schemaDefaults();

type Refused = Extract<ReturnType<typeof validateScenario>, { ok: false }>;

const challengeDoc = (rule: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    name: 'Plan',
    version: 1,
    start: 'main',
    phases: { main: { rules: [rule] } },
    ...extra,
});

const installationDoc = (rule: Record<string, unknown>) => challengeDoc(rule, { scope: 'installation' });

const issuesOf = (input: unknown) => {
    const result = validateScenario(input, globalDefaults);
    expect(result.ok).toBe(false);
    return (result as Refused).issues;
};

const accepts = (input: unknown) => validateScenario(input, globalDefaults).ok;

const refuses = (input: unknown, message: string, path?: string) =>
    expect(issuesOf(input)).toEqual(
        expect.arrayContaining([
            expect.objectContaining({
                ...(path === undefined ? {} : { path }),
                message: expect.stringContaining(message),
            }),
        ]),
    );

const COINS_LITERAL = { kind: 'literal', value: 50, quantity: 'coins' };

describe('the stages a rule declares', () => {
    test('a rule with none runs where it always did: the active stage of a challenge, the account stage of an installation', () => {
        expect(accepts(challengeDoc({ do: [{ type: 'boost', entry: { by: 'mostVotes' } }] }))).toBe(true);
        expect(accepts(installationDoc({ do: [{ type: 'notify', message: 'hi' }] }))).toBe(true);
        // …so the other stages' actions are refused there
        refuses(challengeDoc({ do: [{ type: 'join' }] }), 'join is not available while a challenge is active');
        refuses(
            installationDoc({ do: [{ type: 'boost', entry: { by: 'mostVotes' } }] }),
            'boost is not available outside a challenge',
        );
    });

    test.each([
        [['preJoin'], 'challenge'],
        [['active'], 'challenge'],
        [['postClose'], 'challenge'],
        [['preJoin', 'active', 'postClose'], 'challenge'],
        [['account'], 'installation'],
    ])('%j is a stage of a %s scenario', (stages, scope) => {
        const rule = { stages, do: [{ type: 'notify', message: 'hi' }] };
        expect(accepts(scope === 'challenge' ? challengeDoc(rule) : installationDoc(rule))).toBe(true);
    });

    test('a challenge scenario cannot declare the account stage, an installation scenario only that', () => {
        refuses(
            challengeDoc({ stages: ['account'], do: [{ type: 'notify', message: 'hi' }] }),
            'account is not a stage of a challenge scenario: use preJoin, active, postClose',
            'phases.main.rules[0].stages',
        );
        refuses(
            installationDoc({ stages: ['active'], do: [{ type: 'notify', message: 'hi' }] }),
            'active is not a stage of an installation scenario: use account',
            'phases.main.rules[0].stages',
        );
    });

    test('the list is not empty, holds no unknown stage and names none twice', () => {
        const rule = (stages: unknown) => challengeDoc({ stages, do: [{ type: 'notify', message: 'hi' }] });
        refuses(rule([]), 'Name at least one stage');
        refuses(rule(['later']), 'Invalid option');
        refuses(rule(['active', 'active']), 'A stage is named twice');
    });
});

describe('the actions of each stage', () => {
    const PRE = ['preJoin'];
    test('join is a pre-join action; claimChallengeReward a post-close one; claimMissionReward an account one', () => {
        expect(accepts(challengeDoc({ stages: PRE, do: [{ type: 'join' }] }))).toBe(true);
        expect(accepts(challengeDoc({ stages: ['postClose'], do: [{ type: 'claimChallengeReward' }] }))).toBe(true);
        expect(accepts(installationDoc({ do: [{ type: 'claimMissionReward', missionId: 'daily-7' }] }))).toBe(true);
        refuses(
            challengeDoc({ stages: ['postClose'], do: [{ type: 'join' }] }),
            'join is not available after a challenge closes',
            'phases.main.rules[0].do[0].type',
        );
        refuses(
            challengeDoc({ stages: PRE, do: [{ type: 'claimChallengeReward' }] }),
            'claimChallengeReward is not available before a challenge is joined',
        );
        refuses(
            challengeDoc({ do: [{ type: 'claimMissionReward', missionId: 'x' }] }),
            'claimMissionReward is not available while a challenge is active',
        );
    });

    test('an action must be available in every stage the rule declares', () => {
        refuses(
            challengeDoc({ stages: ['preJoin', 'active'], do: [{ type: 'join' }] }),
            'join is not available while a challenge is active',
        );
        // goto and notify are offered everywhere
        expect(
            accepts(
                challengeDoc({ stages: ['preJoin', 'active', 'postClose'], do: [{ type: 'notify', message: 'x' }] }),
            ),
        ).toBe(true);
    });

    test('the new actions are shape-checked', () => {
        refuses(challengeDoc({ stages: PRE, do: [{ type: 'join', maxCoins: 5 }] }), 'Not a valid expression');
        refuses(challengeDoc({ stages: PRE, do: [{ type: 'join', extra: true }] }), 'Unrecognized key');
        refuses(installationDoc({ do: [{ type: 'claimMissionReward', missionId: 'bad id!' }] }), 'Use letters, digits');
        refuses(installationDoc({ do: [{ type: 'claimMissionReward' }] }), 'Invalid input');
    });
});

describe('the price limit of a join', () => {
    const join = (maxCoins: unknown) => challengeDoc({ stages: ['preJoin'], do: [{ type: 'join', maxCoins }] });

    test('is an expression that gives an amount of coins', () => {
        expect(accepts(join(COINS_LITERAL))).toBe(true);
        expect(accepts(join({ kind: 'fact', name: 'balance.coins' }))).toBe(true);
        expect(accepts(join({ kind: 'fact', name: 'challenge.joinPrice' }))).toBe(true);
    });

    test('is refused when it gives anything else', () => {
        refuses(
            join({ kind: 'literal', value: 5, quantity: 'keys' }),
            'The price limit is an amount of coins',
            'phases.main.rules[0].do[0].maxCoins',
        );
        refuses(join({ kind: 'literal', value: true }), 'The price limit is an amount of coins');
    });

    test('cannot read what the pre-join stage does not have', () => {
        refuses(
            join({ kind: 'fact', name: 'entry.votes', select: { by: 'mostVotes' } }),
            'entry.votes is not available before a challenge is joined',
        );
        // an unsound expression is reported as it is, with no stage issue on top
        const issues = issuesOf(join({ kind: 'offset', from: COINS_LITERAL, by: COINS_LITERAL, direction: 'before' }));
        expect(issues.some((issue) => issue.message.includes('before a challenge is joined'))).toBe(false);
    });
});

describe('the conditions of each stage', () => {
    const when = (stages: string[], condition: Record<string, unknown>) =>
        challengeDoc({ stages, if: [condition], do: [{ type: 'notify', message: 'x' }] });

    test('time, balance, phase and memory conditions, and the expression ones, are available in every stage', () => {
        const everywhere = [
            { type: 'dailyWindow', from: '08:00', to: '09:00' },
            { type: 'inPhaseFor', min: '1h' },
            { type: 'balance', currency: 'coins', op: '>=', value: 10 },
            { type: 'compare', left: { kind: 'fact', name: 'balance.coins' }, op: '>=', right: COINS_LITERAL },
            { type: 'not', condition: { type: 'dailyWindow', from: '08:00', to: '09:00' } },
        ];
        for (const condition of everywhere) {
            expect(accepts(when(['preJoin', 'active', 'postClose'], condition))).toBe(true);
        }
        expect(accepts(installationDoc({ if: [everywhere[0]], do: [{ type: 'notify', message: 'x' }] }))).toBe(true);
    });

    test('the challenge clock and numbers are for the stages that have a live challenge', () => {
        for (const condition of [
            { type: 'beforeEnd', max: '1d' },
            { type: 'afterStart', min: '1h' },
            { type: 'elapsedPercent', min: 10 },
            { type: 'entries', op: '>=', value: 1 },
            { type: 'challengeVotes', op: '>', value: 5 },
        ]) {
            expect(accepts(when(['preJoin', 'active'], condition))).toBe(true);
            refuses(
                when(['postClose'], condition),
                `${condition.type} is not available after a challenge closes`,
                'phases.main.rules[0].if[0]',
            );
        }
    });

    test('the entries, the boost and the turbo are for the active stage only', () => {
        for (const condition of [
            { type: 'boostState', in: ['AVAILABLE'] },
            { type: 'turboState', in: ['WON'] },
            { type: 'entry', select: { by: 'mostVotes' }, field: 'votes', op: '>', value: 1 },
            { type: 'entryCount', where: [{ field: 'votes', op: '>', value: 1 }], op: '>', value: 1 },
            { type: 'entriesWhere', quantifier: 'any', where: [{ field: 'votes', op: '>', value: 1 }] },
        ]) {
            expect(accepts(when(['active'], condition))).toBe(true);
            refuses(when(['preJoin'], condition), `${condition.type} is not available before a challenge is joined`);
        }
    });

    test('an installation scenario is told it cannot read a challenge, as before', () => {
        refuses(
            installationDoc({ if: [{ type: 'beforeEnd', max: '1d' }], do: [{ type: 'notify', message: 'x' }] }),
            'beforeEnd reads a challenge: an installation scenario cannot use it',
        );
    });

    test('a refusal reaches a condition nested in a composition', () => {
        refuses(
            when(['postClose'], { type: 'all', of: [{ type: 'beforeEnd', max: '1d' }] }),
            'beforeEnd is not available after a challenge closes',
            'phases.main.rules[0].if[0].of[0]',
        );
    });
});

describe('the facts of each stage', () => {
    const reads = (stages: string[], name: string) =>
        challengeDoc({
            stages,
            if: [{ type: 'present', value: { kind: 'fact', name } }],
            do: [{ type: 'notify', message: 'x' }],
        });

    test('rewards.claimable is readable after a challenge closes, rewards.claimableCount outside a challenge', () => {
        expect(accepts(reads(['postClose'], 'rewards.claimable'))).toBe(true);
        refuses(
            reads(['active'], 'rewards.claimable'),
            'rewards.claimable is not available while a challenge is active',
        );
        expect(
            accepts(
                installationDoc({
                    if: [{ type: 'present', value: { kind: 'fact', name: 'rewards.claimableCount' } }],
                    do: [{ type: 'notify', message: 'x' }],
                }),
            ),
        ).toBe(true);
    });

    test('every stage the rule declares is checked', () => {
        refuses(
            reads(['preJoin', 'postClose'], 'photos.eligibleCount'),
            'photos.eligibleCount is not available after a challenge closes',
        );
        expect(accepts(reads(['preJoin', 'active'], 'photos.eligibleCount'))).toBe(true);
    });
});

describe('the coin limit', () => {
    test('is a count like the other limits', () => {
        const rule = { stages: ['preJoin'], do: [{ type: 'join' }] };
        expect(accepts(challengeDoc(rule, { limits: { coins: 200 } }))).toBe(true);
        refuses(challengeDoc(rule, { limits: { coins: -1 } }), 'Too small');
        refuses(challengeDoc(rule, { limits: { coins: 1.5 } }), 'Invalid input');
    });
});

describe('the entry selectors added with the remaining actions', () => {
    const boostWith = (entry: unknown) => challengeDoc({ do: [{ type: 'boost', entry }] });
    const predicate = { field: 'votes', op: '>=', value: 5 };

    test.each([
        [{ by: 'id', id: 'photo-1' }],
        [{ by: 'pinned', power: 'boost' }],
        [{ by: 'pinned', power: 'turbo' }],
        [{ by: 'pendingBoostTarget' }],
        [{ by: 'newest', time: 'exact' }],
        [{ by: 'oldest', time: 'observed' }],
        [{ by: 'slowest' }],
        [{ by: 'slowest', window: '2h', skipProtected: true }],
        [{ by: 'matching', where: [predicate], order: 'votes', direction: 'desc' }],
        [
            {
                by: 'matching',
                where: [predicate, { field: 'boosted', op: '=', value: false }],
                order: 'age',
                direction: 'asc',
            },
        ],
    ])('%j is accepted as an action target', (selector) => {
        expect(accepts(boostWith(selector))).toBe(true);
    });

    test.each([
        [{ by: 'id' }, 'phases.main.rules[0].do[0].entry.id'],
        [{ by: 'id', id: 'a b' }, 'phases.main.rules[0].do[0].entry.id'],
        [{ by: 'pinned', power: 'swap' }, 'phases.main.rules[0].do[0].entry.power'],
        [{ by: 'newest' }, 'phases.main.rules[0].do[0].entry.time'],
        [{ by: 'oldest', time: 'soon' }, 'phases.main.rules[0].do[0].entry.time'],
        [{ by: 'slowest', window: 'soon' }, 'phases.main.rules[0].do[0].entry.window'],
        [{ by: 'matching', where: [], order: 'votes', direction: 'asc' }, 'phases.main.rules[0].do[0].entry.where'],
        [
            { by: 'matching', where: Array.from({ length: 9 }, () => predicate), order: 'votes', direction: 'asc' },
            'phases.main.rules[0].do[0].entry.where',
        ],
        [
            { by: 'matching', where: [predicate], order: 'luck', direction: 'asc' },
            'phases.main.rules[0].do[0].entry.order',
        ],
        [
            { by: 'matching', where: [{ field: 'boosted', op: '<', value: 1 }], order: 'votes', direction: 'asc' },
            'phases.main.rules[0].do[0].entry.where[0].op',
        ],
        [{ by: 'pendingBoostTarget', extra: 1 }, 'phases.main.rules[0].do[0].entry'],
    ])('%j is refused', (selector, path) => {
        expect(issuesOf(boostWith(selector)).map((issue) => issue.path)).toContain(path);
    });

    test('a selector is usable in an entry condition and in an expression fact', () => {
        const condition = { type: 'entry', select: { by: 'newest', time: 'exact' }, field: 'votes', op: '>', value: 3 };
        expect(accepts(challengeDoc({ if: [condition], do: [{ type: 'notify', message: 'hi' }] }))).toBe(true);
        const fact = { kind: 'fact', name: 'entry.votes', select: { by: 'pinned', power: 'boost' } };
        const compare = {
            type: 'compare',
            left: fact,
            op: '>',
            right: { kind: 'literal', value: 3, quantity: 'votes' },
        };
        expect(accepts(challengeDoc({ if: [compare], do: [{ type: 'notify', message: 'hi' }] }))).toBe(true);
    });
});

describe('the remaining actions', () => {
    const activeRule = (action: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        challengeDoc({ do: [action], ...extra });

    describe('earnTurbo', () => {
        test('is an active-stage action', () => {
            expect(accepts(activeRule({ type: 'earnTurbo' }))).toBe(true);
            refuses(
                challengeDoc({ stages: ['preJoin'], do: [{ type: 'earnTurbo' }] }),
                'earnTurbo is not available before a challenge is joined',
            );
            refuses(installationDoc({ do: [{ type: 'earnTurbo' }] }), 'earnTurbo is not available outside a challenge');
            expect(issuesOf(activeRule({ type: 'earnTurbo', extra: 1 })).length).toBeGreaterThan(0);
        });
    });

    describe('runAutomation', () => {
        test.each(['submit', 'boost', 'turbo', 'unlockBoost', 'swap', 'fillExposure', 'vote'])(
            '%s runs while the challenge is active',
            (operation) => {
                expect(accepts(activeRule({ type: 'runAutomation', operation }))).toBe(true);
                refuses(
                    challengeDoc({ stages: ['preJoin'], do: [{ type: 'runAutomation', operation }] }),
                    `${operation} is an active-challenge operation`,
                    'phases.main.rules[0].do[0].operation',
                );
            },
        );

        test('join runs before joining only', () => {
            const action = { type: 'runAutomation', operation: 'join' };
            expect(accepts(challengeDoc({ stages: ['preJoin'], do: [action] }))).toBe(true);
            refuses(activeRule(action), 'join is a pre-join operation', 'phases.main.rules[0].do[0].operation');
            refuses(
                challengeDoc({ stages: ['preJoin', 'active'], do: [action] }),
                'join is a pre-join operation: it is not available while a challenge is active',
            );
        });

        test('is refused where no operation runs, and with an operation the app does not have', () => {
            refuses(
                installationDoc({ do: [{ type: 'runAutomation', operation: 'boost' }] }),
                'runAutomation is not available outside a challenge',
            );
            refuses(
                challengeDoc({ stages: ['postClose'], do: [{ type: 'runAutomation', operation: 'vote' }] }),
                'runAutomation is not available after a challenge closes',
            );
            expect(issuesOf(activeRule({ type: 'runAutomation', operation: 'dance' })).length).toBeGreaterThan(0);
        });
    });

    describe('setSetting and clearSetting', () => {
        test('a challenge scenario patches a per-challenge setting with a literal or an expression of its type', () => {
            expect(accepts(activeRule({ type: 'setSetting', key: 'autoBoost', value: true }))).toBe(true);
            expect(accepts(activeRule({ type: 'setSetting', key: 'autoExposureFillBelow', value: 60 }))).toBe(true);
            expect(accepts(activeRule({ type: 'setSetting', key: 'mustIncludeTags', value: ['sea'] }))).toBe(true);
            const cap = { kind: 'literal', value: 30, quantity: 'coins' };
            expect(accepts(activeRule({ type: 'setSetting', key: 'autoJoinMaxCoins', value: cap }))).toBe(true);
            expect(accepts(activeRule({ type: 'clearSetting', key: 'autoBoost' }))).toBe(true);
            expect(
                accepts(
                    challengeDoc({ stages: ['preJoin'], do: [{ type: 'setSetting', key: 'autoJoin', value: false }] }),
                ),
            ).toBe(true);
        });

        test('an installation scenario patches an installation setting', () => {
            expect(
                accepts(installationDoc({ do: [{ type: 'setSetting', key: 'missionJoinEarly', value: true }] })),
            ).toBe(true);
            expect(accepts(installationDoc({ do: [{ type: 'clearSetting', key: 'missionJoinEarly' }] }))).toBe(true);
        });

        test('a key the scope may not patch is refused with its reason', () => {
            // a per-challenge setting from an installation scenario, and an installation setting from a challenge one
            refuses(
                installationDoc({ do: [{ type: 'setSetting', key: 'autoBoost', value: true }] }),
                'Not a setting an installation scenario can change',
                'phases.main.rules[0].do[0].key',
            );
            refuses(
                activeRule({ type: 'setSetting', key: 'missionJoinEarly', value: true }),
                'Not a per-challenge setting',
                'phases.main.rules[0].do[0].key',
            );
            refuses(
                activeRule({ type: 'clearSetting', key: 'scenario' }),
                'scenario',
                'phases.main.rules[0].do[0].key',
            );
            refuses(activeRule({ type: 'setSetting', key: 'manualPhotosOnly', value: false }), 'Manual Only');
            refuses(activeRule({ type: 'setSetting', key: 'nonsense', value: 1 }), 'Not a per-challenge setting');
        });

        test('a key whose value has no literal or expression form cannot be set by an action', () => {
            refuses(
                activeRule({ type: 'setSetting', key: 'chosenPhotos', value: ['a'] }),
                '"chosenPhotos" has no value an action can set',
                'phases.main.rules[0].do[0].key',
            );
            refuses(activeRule({ type: 'clearSetting', key: 'chosenPhotos' }), 'has no value an action can set');
        });

        test('a value of the wrong type, or one the setting refuses, is refused', () => {
            refuses(
                activeRule({ type: 'setSetting', key: 'autoBoost', value: 'yes' }),
                'autoBoost does not take this value',
                'phases.main.rules[0].do[0].value',
            );
            refuses(
                activeRule({ type: 'setSetting', key: 'autoExposureFillBelow', value: 5000 }),
                '',
                'phases.main.rules[0].do[0].value',
            );
            const text = { kind: 'literal', value: 'x' };
            refuses(
                activeRule({ type: 'setSetting', key: 'autoBoost', value: text }),
                'This gives a string, but autoBoost takes a boolean',
            );
        });

        test('an expression value may read facts of the rule stages, and is checked like any expression', () => {
            const fact = { kind: 'fact', name: 'balance.coins' };
            expect(accepts(activeRule({ type: 'setSetting', key: 'autoJoinMaxCoins', value: fact }))).toBe(true);
            const reads = { kind: 'fact', name: 'entry.votes', select: { by: 'slot', index: 1 } };
            refuses(
                installationDoc({ do: [{ type: 'setSetting', key: 'missionJoinEarly', value: reads }] }),
                'entry.votes is not available',
            );
            expect(
                issuesOf(activeRule({ type: 'setSetting', key: 'autoBoost', value: { kind: 'nope' } })).length,
            ).toBeGreaterThan(0);
        });

        test('are not available after a challenge closes', () => {
            refuses(
                challengeDoc({ stages: ['postClose'], do: [{ type: 'setSetting', key: 'autoBoost', value: true }] }),
                'setSetting is not available after a challenge closes',
            );
        });
    });

    describe('useProfile', () => {
        test('names a saved profile, or none; challenge stages only', () => {
            expect(accepts(activeRule({ type: 'useProfile', name: 'Calm' }))).toBe(true);
            expect(accepts(activeRule({ type: 'useProfile', name: null }))).toBe(true);
            expect(accepts(challengeDoc({ stages: ['preJoin'], do: [{ type: 'useProfile', name: 'Calm' }] }))).toBe(
                true,
            );
            refuses(
                installationDoc({ do: [{ type: 'useProfile', name: 'Calm' }] }),
                'useProfile is not available outside a challenge',
            );
            expect(issuesOf(activeRule({ type: 'useProfile', name: '' })).length).toBeGreaterThan(0);
            expect(issuesOf(activeRule({ type: 'useProfile', name: 'x'.repeat(61) })).length).toBeGreaterThan(0);
            expect(issuesOf(activeRule({ type: 'useProfile' })).length).toBeGreaterThan(0);
        });

        test('a saved profile that sets a key a phase may not write is refused; one not saved yet is not', () => {
            const profiles = { Bad: { manualPhotosOnly: true }, Good: { autoBoost: true } };
            const check = (name: string | null) =>
                validateScenario(activeRule({ type: 'useProfile', name }), globalDefaults, profiles);
            expect(check('Good').ok).toBe(true);
            expect(check(null).ok).toBe(true);
            expect(check('Later').ok).toBe(true);
            const bad = check('Bad');
            expect(bad.ok).toBe(false);
            expect((bad as Refused).issues).toEqual(
                expect.arrayContaining([expect.objectContaining({ path: 'phases.main.rules[0].do[0].name' })]),
            );
        });
    });

    describe('pauseScenario', () => {
        test.each([
            [undefined, challengeDoc({ do: [{ type: 'pauseScenario' }] })],
            ['a reason', challengeDoc({ do: [{ type: 'pauseScenario', reason: 'cooling off' }] })],
            ['preJoin', challengeDoc({ stages: ['preJoin'], do: [{ type: 'pauseScenario' }] })],
            ['postClose', challengeDoc({ stages: ['postClose'], do: [{ type: 'pauseScenario' }] })],
            ['the installation', installationDoc({ do: [{ type: 'pauseScenario', reason: 'asleep' }] })],
        ])('%s is accepted', (_label, doc) => {
            expect(accepts(doc)).toBe(true);
        });

        test('a reason is short plain text', () => {
            expect(issuesOf(activeRule({ type: 'pauseScenario', reason: 'x'.repeat(121) })).length).toBeGreaterThan(0);
            expect(issuesOf(activeRule({ type: 'pauseScenario', reason: 'a\nb' })).length).toBeGreaterThan(0);
        });
    });

    describe('handoffScenario', () => {
        test('names a scenario or none, and is the last action of its rule', () => {
            const last = challengeDoc({
                do: [
                    { type: 'notify', message: 'hi' },
                    { type: 'handoffScenario', to: 'Other' },
                ],
            });
            expect(accepts(last)).toBe(true);
            expect(accepts(activeRule({ type: 'handoffScenario', to: null }))).toBe(true);
            expect(accepts(installationDoc({ do: [{ type: 'handoffScenario', to: 'Account two' }] }))).toBe(true);
            expect(
                accepts(challengeDoc({ stages: ['postClose'], do: [{ type: 'handoffScenario', to: 'Other' }] })),
            ).toBe(true);
        });

        test('a handoff that is not the last action is refused', () => {
            refuses(
                challengeDoc({
                    do: [
                        { type: 'handoffScenario', to: 'Other' },
                        { type: 'notify', message: 'hi' },
                    ],
                }),
                'handoffScenario must be the last action of its rule',
                'phases.main.rules[0].do[0]',
            );
        });

        test('a name that is not a scenario name is refused', () => {
            expect(issuesOf(activeRule({ type: 'handoffScenario', to: '' })).length).toBeGreaterThan(0);
            expect(issuesOf(activeRule({ type: 'handoffScenario' })).length).toBeGreaterThan(0);
        });
    });
});
