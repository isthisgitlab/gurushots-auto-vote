/**
 * Challenge rules: the pure matcher / default order (settings/challengeRules.ts)
 * and the facade's class conditions (type, photo count, runtime), its per-key
 * cascade, and the id-keyed resolution through the remembered facts cache.
 *
 * Drives the in-memory headless-store seam so loadSettings/saveSettings
 * round-trip without touching fs.
 */

import type { AndroidHeadlessStore, AppSettings } from '../../src/ts/types/settings';
import type { Challenge } from '../../src/ts/types/gurushots';
import type { CategoryLogger } from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';
import rules = require('../../src/ts/settings/challengeRules');
import settings = require('../../src/ts/settings');

jest.mock('../../src/ts/logger', () => {
    const cat = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        withCategory: jest.fn(() => cat),
        __cat: cat,
    };
});

const cat = invalid<{
    __cat: { [K in 'info' | 'error' | 'debug' | 'success' | 'warning']: jest.MockedFunction<CategoryLogger[K]> };
}>(require('../../src/ts/logger')).__cat;

const HOUR = 3600;
const START = 1_700_000_000;
const ZONE = 'UTC';
// 2026-06-15 17:10:59 UTC (20:10 in Europe/Riga, which is on summer time).
const CLOSE_1710_UTC = Date.UTC(2026, 5, 15, 17, 10, 59) / 1000;
// A challenge payload as the API sends it; `hours` sets its runtime.
const challenge = ({ hours = 24, ...over }: Partial<Challenge> & { hours?: number } = {}) => ({
    title: 'Seaside',
    tags: [],
    type: 'default',
    max_photo_submits: 4,
    start_time: START,
    close_time: START + hours * HOUR,
    ...over,
});

describe('settings/challengeRules — pure matcher', () => {
    const target = (over?: Parameters<typeof challenge>[0]) => rules.ruleMatchTarget(challenge(over), ZONE);

    test('normalizers bound photo counts and runtime hours, treating empties as absent', () => {
        expect(rules.normalizeRulePics(4)).toBe(4);
        expect(rules.normalizeRulePics('3')).toBe(3);
        for (const bad of [0, 11, 2.5, 'x', '', null, undefined]) expect(rules.normalizeRulePics(bad)).toBeNull();
        expect(rules.normalizeRuleHours(168)).toBe(168);
        expect(rules.normalizeRuleHours('0.5')).toBe(0.5);
        for (const bad of [0, -1, 2001, 'x', '', null, undefined, Infinity]) {
            expect(rules.normalizeRuleHours(bad)).toBeNull();
        }
    });

    test('normalizeRuleClosesAt: absent is null, a strict HH:MM is kept, anything else is false', () => {
        for (const absent of [undefined, null, '']) expect(rules.normalizeRuleClosesAt(absent)).toBeNull();
        expect(rules.normalizeRuleClosesAt('17:10')).toBe('17:10');
        for (const bad of ['25:00', '7:10', '17:10:00', ' 17:10', 1710, {}, true]) {
            expect(rules.normalizeRuleClosesAt(bad)).toBe(false);
        }
    });

    test('close time of day is read in the given zone and floored, or null when unreadable', () => {
        const close = { close_time: CLOSE_1710_UTC };
        expect(rules.challengeCloseTimeOfDay(close, 'UTC')).toBe('17:10');
        expect(rules.challengeCloseTimeOfDay(close, 'Europe/Riga')).toBe('20:10');
        for (const bad of [{}, { close_time: 0 }, { close_time: -5 }, { close_time: 'x' }, null, undefined]) {
            expect(rules.challengeCloseTimeOfDay(bad, 'UTC')).toBeNull();
        }
    });

    test('runtime is close - start in hours, or null when unreadable', () => {
        expect(rules.challengeRuntimeHours(challenge({ hours: 72 }))).toBe(72);
        expect(rules.challengeRuntimeHours({ close_time: START })).toBeNull();
        expect(rules.challengeRuntimeHours({ start_time: START })).toBeNull();
        expect(rules.challengeRuntimeHours({ start_time: START, close_time: START })).toBeNull();
        expect(rules.challengeRuntimeHours({ start_time: 0, close_time: HOUR })).toBeNull();
        expect(rules.challengeRuntimeHours(null)).toBeNull();
    });

    test('a bare title and a missing target normalize to empty keys', () => {
        expect(rules.ruleMatchTarget('  Hats ', ZONE)).toMatchObject({ titleKey: 'hats', tagKeys: [], pics: null });
        expect(rules.ruleMatchTarget(null, ZONE)).toEqual({
            titleKey: '',
            tagKeys: [],
            typeKey: '',
            pics: null,
            runtimeHours: null,
            closeTimeOfDay: null,
        });
    });

    test('every condition a rule carries must hold', () => {
        const rule = { pics: 4, type: 'Default', challengeTag: 'Comm', minHours: 24, maxHours: 24 };
        expect(rules.ruleMatches(rule, target({ tags: ['comm'] }))).toBe(true);
        expect(rules.ruleMatches(rule, target({ tags: ['comm'], max_photo_submits: 2 }))).toBe(false);
        expect(rules.ruleMatches(rule, target({ tags: ['comm'], type: 'flash' }))).toBe(false);
        expect(rules.ruleMatches(rule, target({ tags: [] }))).toBe(false);
        expect(rules.ruleMatches(rule, target({ tags: ['comm'], hours: 25 }))).toBe(false);
    });

    test('runtime bounds are inclusive, either side may be open, and unknown times never match', () => {
        const atLeastWeek = { minHours: 168 };
        const atMostDay = { maxHours: 24 };
        expect(rules.ruleMatches(atLeastWeek, target({ hours: 168 }))).toBe(true);
        expect(rules.ruleMatches(atLeastWeek, target({ hours: 167 }))).toBe(false);
        expect(rules.ruleMatches(atMostDay, target({ hours: 24 }))).toBe(true);
        expect(rules.ruleMatches(atMostDay, target({ hours: 48 }))).toBe(false);
        expect(rules.ruleMatches(atMostDay, target({ start_time: undefined }))).toBe(false);
    });

    test('a closesAt condition matches the card time, and fails closed on an unreadable close_time', () => {
        const rule = { closesAt: '17:10' };
        expect(rules.ruleMatches(rule, target({ close_time: CLOSE_1710_UTC }))).toBe(true);
        expect(rules.ruleMatches(rule, target({ close_time: CLOSE_1710_UTC + 60 }))).toBe(false);
        expect(rules.ruleMatches(rule, target({ close_time: CLOSE_1710_UTC - 60 }))).toBe(false);
        expect(rules.ruleMatches(rule, target({ close_time: undefined }))).toBe(false);
        // The same instant reads differently in another zone.
        expect(rules.ruleMatches(rule, rules.ruleMatchTarget({ close_time: CLOSE_1710_UTC }, 'Europe/Riga'))).toBe(
            false,
        );
    });

    test('an invalid stored closesAt matches nothing, alone or AND-ed with a matching condition', () => {
        const hit = target({ close_time: CLOSE_1710_UTC, title: 'Seaside', type: 'default' });
        expect(rules.ruleMatches({ closesAt: '25:00' }, hit)).toBe(false);
        expect(rules.ruleMatches({ closesAt: '25:00', type: 'default' }, hit)).toBe(false);
        expect(rules.ruleMatches({ closesAt: '25:00', title: 'Seaside' }, hit)).toBe(false);
        expect(rules.ruleMatches({ closesAt: '17:10', title: 'Seaside', type: 'default' }, hit)).toBe(true);
    });

    test('a title condition needs a title; a rule with no condition matches nothing', () => {
        expect(rules.ruleMatches({ title: 'Seaside' }, rules.ruleMatchTarget({ tags: ['x'] }, ZONE))).toBe(false);
        expect(rules.ruleMatches({ autoJoin: true }, target())).toBe(false);
        expect(rules.hasRuleCondition({ autoJoin: true })).toBe(false);
        expect(rules.hasRuleCondition({ maxHours: 24 })).toBe(true);
        expect(rules.hasRuleCondition({ closesAt: '17:10' })).toBe(true);
        expect(rules.hasRuleCondition({ closesAt: '25:00' })).toBe(false);
        expect(rules.hasRuleCondition({ title: 'x' })).toBe(true);
    });

    test('invalid per-title modes fall back to exact when matching hand-edited rules', () => {
        expect(rules.ruleTitleModes({ title: 'Seaside', titleMatchModes: [42] })).toEqual(['exact']);
        expect(rules.ruleTitleModes({ title: 'Seaside', titleMatchModes: ['regex'] })).toEqual(['exact']);
        expect(rules.ruleMatches({ title: 'Seaside', titleMatchModes: ['regex'] }, target())).toBe(true);
        expect(
            rules.ruleMatches({ title: 'Seaside', titleMatchModes: ['regex'] }, target({ title: 'Seaside 2' })),
        ).toBe(false);
    });

    test('matchingRules keeps list order and tolerates a non-array list', () => {
        const a = { pics: 4 };
        const b = { title: 'Seaside' };
        expect(rules.matchingRules([a, { pics: 2 }, b], challenge(), ZONE)).toEqual([a, b]);
        expect(rules.matchingRules(null, challenge(), ZONE)).toEqual([]);
        expect(rules.matchingRules([], challenge(), ZONE)).toEqual([]);
    });

    test('matchingRules reads the close time in the given zone', () => {
        const skip = { closesAt: '17:10' };
        const close = challenge({ close_time: CLOSE_1710_UTC });
        expect(rules.matchingRules([skip], close, 'UTC')).toEqual([skip]);
        expect(rules.matchingRules([skip], close, 'Europe/Riga')).toEqual([]);
        // No rule carries a valid closesAt: other rules still match without the close time being read.
        expect(rules.matchingRules([{ pics: 4 }, { closesAt: 'x' }], close, 'UTC')).toEqual([{ pics: 4 }]);
    });

    describe('sortRulesByDefaultOrder', () => {
        test('title rules first, then photos + runtime, photos, runtime, type, tag', () => {
            const tag = { challengeTag: 'Comm' };
            const type = { type: 'flash' };
            const runtime = { minHours: 168 };
            const pics = { pics: 4 };
            const both = { pics: 4, maxHours: 24 };
            const titled = { title: 'Hats', match: 'contains' };
            expect(rules.sortRulesByDefaultOrder([tag, type, runtime, pics, both, titled])).toEqual([
                titled,
                both,
                pics,
                runtime,
                type,
                tag,
            ]);
        });

        test('among title rules: mode + class conditions, then the longer pattern, then class kinds, then input order', () => {
            const contains = { title: 'photo', match: 'contains' };
            const starts = { title: 'photo', match: 'starts' };
            const exact = { title: 'photo of the week' };
            const startsPlusTag = { title: 'ph', match: 'starts', challengeTag: 'Turbo' };
            const exactLong = { titles: ['x', 'photo of the week!'] };
            const tieA = { title: 'abc', match: 'contains' };
            const tieB = { title: 'abd', match: 'contains' };
            expect(
                rules.sortRulesByDefaultOrder([contains, starts, startsPlusTag, exact, exactLong, tieA, tieB]),
            ).toEqual([exactLong, exact, startsPlusTag, starts, contains, tieA, tieB]);
            // Same score and pattern length: the class kinds decide (photos before tag).
            const withPics = { title: 'abc', match: 'starts', pics: 4 };
            const withTag = { title: 'abc', match: 'starts', challengeTag: 'Comm' };
            expect(rules.sortRulesByDefaultOrder([withTag, withPics])).toEqual([withPics, withTag]);
        });

        test('a mixed-mode rule sorts by its broadest title match', () => {
            const exact = { title: 'Photo' };
            const mixed = {
                title: 'Photo',
                titles: ['Photo', 'Hats and More'],
                titleMatchModes: ['starts', 'exact'],
            };
            expect(rules.sortRulesByDefaultOrder([mixed, exact])).toEqual([exact, mixed]);
        });

        test('a close-time rule ranks after runtime and before type, and below every title rule', () => {
            const closes = { closesAt: '17:10' };
            const runtime = { minHours: 168 };
            const type = { type: 'flash' };
            const titled = { title: 'Hats', match: 'contains' };
            expect(rules.sortRulesByDefaultOrder([type, closes, runtime, titled])).toEqual([
                titled,
                runtime,
                closes,
                type,
            ]);
            // An invalid close time is no condition, so it takes no slot.
            expect(rules.sortRulesByDefaultOrder([{ closesAt: '25:00', type: 'flash' }, closes])).toEqual([
                closes,
                { closesAt: '25:00', type: 'flash' },
            ]);
        });

        test('returns a new array and an empty one for a non-array', () => {
            const list = [{ pics: 2 }, { title: 'a' }];
            const sorted = rules.sortRulesByDefaultOrder(list);
            expect(sorted).not.toBe(list);
            expect(list[0]).toEqual({ pics: 2 });
            expect(rules.sortRulesByDefaultOrder(undefined)).toEqual([]);
        });
    });
});

describe('settings facade — class conditions and the rule cascade', () => {
    const headlessGlobals = globalThis as typeof globalThis & {
        __GS_HEADLESS__?: boolean;
        AndroidHeadlessStore?: AndroidHeadlessStore;
    };
    let store: { value: string | null; read: jest.Mock<string | null, []>; write: jest.Mock<void, [string]> };
    const seed = (obj: Record<string, unknown>) => {
        store.value = JSON.stringify({ _challengeRulesOrderedV1: true, ...obj });
        settings.loadSettings();
        store.write.mockClear();
    };
    const saved = () => JSON.parse(store.value!) as AppSettings;
    const base = (over = {}) => ({ challengeSettings: { globalDefaults: {}, ...over } });
    const withTags = (rule: Record<string, unknown>) => ({ mustIncludeTags: [], shouldIncludeTags: [], ...rule });

    beforeEach(() => {
        headlessGlobals.__GS_HEADLESS__ = true;
        store = {
            value: null,
            read: jest.fn(() => store.value),
            write: jest.fn((d) => {
                store.value = d;
            }),
        };
        headlessGlobals.AndroidHeadlessStore = store;
        settings.rememberChallengeTitles([]);
        jest.clearAllMocks();
    });

    afterAll(() => {
        delete headlessGlobals.__GS_HEADLESS__;
        delete headlessGlobals.AndroidHeadlessStore;
    });

    describe('setTitleRules — class conditions', () => {
        test('stores normalized type / photo count / runtime on a title-less rule', () => {
            seed(base());
            expect(
                settings.setTitleRules([
                    { type: '  Flash ', pics: '4', minHours: '24', maxHours: 168, autoJoin: true },
                    { minHours: '', maxHours: '', pics: '', type: '', title: '', autoJoin: true },
                ]),
            ).toBe(true);
            expect(saved().challengeSettings.titleRules).toEqual([
                withTags({ title: '', type: 'flash', pics: 4, minHours: 24, maxHours: 168, autoJoin: true }),
            ]);
            expect(saved()._challengeRulesOrderedV1).toBe(true);
        });

        test.each([
            ['an out-of-range photo count', { pics: 9.5 }],
            ['a zero runtime bound', { minHours: 0 }],
            ['an over-cap runtime bound', { maxHours: 5000 }],
            ['an inverted runtime range', { minHours: 48, maxHours: 24 }],
            ['an over-length type', { type: 't'.repeat(201) }],
            ['an over-length tag', { challengeTag: 't'.repeat(201) }],
        ])('rejects %s without persisting', (_label, condition) => {
            seed(base());
            expect(settings.setTitleRules([{ ...condition, autoJoin: true }])).toBe(false);
            expect(store.write).not.toHaveBeenCalled();
        });

        test('names a rejected untitled rule by its type, else generically, in the log', () => {
            seed(base());
            settings.setTitleRules([{ type: 'flash', autoJoin: 'yes' }]);
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('rejected for "flash"'), null);
            settings.setTitleRules([{ pics: 4, autoJoin: 'yes' }]);
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('rejected for "(untitled rule)"'), null);
        });

        test('rules differing only in a class condition are distinct; an identical one collapses', () => {
            seed(base());
            settings.setTitleRules([
                { pics: 4, autoJoinWithinHoursOfEnd: 1 },
                { pics: 2, autoJoinWithinHoursOfEnd: 2 },
                { pics: 4, minHours: 168, autoJoinWithinHoursOfEnd: 3 },
                { pics: 4, autoJoinWithinHoursOfEnd: 4 },
            ]);
            expect(settings.getTitleRules().map((rule) => rule.autoJoinWithinHoursOfEnd)).toEqual([4, 2, 3]);
        });

        test('a title-profile conflict on an untitled rule is logged by its generic name', () => {
            seed(
                base({
                    profiles: { P: { exposure: 70 } },
                    // A manual target below the profile's trigger: the pair is invalid.
                    perChallenge: { c1: { exposureTarget: 60 } },
                }),
            );
            settings.rememberChallengeTitles([{ id: 'c1', ...challenge() }]);
            expect(settings.setTitleRules([{ pics: 4, profile: 'P' }])).toBe(false);
            expect(cat.error).toHaveBeenCalledWith(
                'Title profile conflicts with manual overrides for "(untitled rule)"',
                null,
            );
        });
    });

    describe('the cascade', () => {
        test('the first matching rule naming a profile supplies the ONLY profile', () => {
            seed(
                base({
                    profiles: { Quad: { exposure: 70 }, Long: { exposure: 40, boostTime: 600 } },
                    titleRules: [
                        withTags({ title: '', pics: 4, maxHours: 24, profile: 'Quad' }),
                        withTags({ title: '', pics: 4, profile: 'Long' }),
                    ],
                }),
            );
            const day = challenge({ hours: 24 });
            expect(settings.resolveRuleSetting('exposure', day)).toEqual({ value: 70 });
            // Long's other keys do not leak in beside Quad's.
            expect(settings.resolveRuleSetting('boostTime', day)).toBeNull();
            expect(settings.getTitleProfile(day)).toEqual({ name: 'Quad', values: { exposure: 70 } });
            // A week-long 4-photo challenge misses the first rule and gets Long.
            expect(settings.resolveRuleSetting('exposure', challenge({ hours: 168 }))).toEqual({ value: 40 });
        });

        test('a rule above the profile rule still wins with its inline value; gaps fall through', () => {
            seed(
                base({
                    profiles: { P: { autoJoinWithinHoursOfEnd: 12, exposure: 70 } },
                    titleRules: [
                        withTags({ title: 'Seaside', autoJoinWithinHoursOfEnd: 2 }),
                        withTags({ title: '', pics: 4, profile: 'P', autoFill: true }),
                    ],
                }),
            );
            expect(settings.resolveRuleSetting('autoJoinWithinHoursOfEnd', challenge())).toEqual({ value: 2 });
            expect(settings.resolveRuleSetting('exposure', challenge())).toEqual({ value: 70 });
            expect(settings.resolveRuleSetting('autoFill', challenge())).toEqual({ value: true });
            expect(settings.resolveRuleSetting('autoJoin', challenge())).toBeNull();
        });

        test('a hand-edited reserved profile name on a rule resolves to no profile', () => {
            seed(base({ titleRules: [withTags({ title: 'Seaside', profile: '__proto__' })] }));
            expect(settings.getTitleProfile(challenge())).toBeNull();
            expect(settings.resolveRuleSetting('exposure', challenge())).toBeNull();
        });

        test('photo tags come from the first matching rule that lists them for that key', () => {
            seed(
                base({
                    globalDefaults: { mustIncludeTags: [], shouldIncludeTags: [] },
                    titleRules: [
                        withTags({ title: 'Seaside', shouldIncludeTags: ['sea'] }),
                        withTags({ title: '', pics: 4, mustIncludeTags: ['quad'], shouldIncludeTags: ['x'] }),
                    ],
                }),
            );
            expect(settings.getEffectiveTagSetting('mustIncludeTags', challenge())).toEqual(['quad']);
            expect(settings.getEffectiveTagSetting('shouldIncludeTags', challenge())).toEqual(['sea']);
        });
    });

    describe('id-keyed resolution through the facts cache', () => {
        const rulesForQuad = () =>
            base({
                profiles: { Quad: { exposure: 70 } },
                titleRules: [withTags({ title: '', pics: 4, minHours: 24, profile: 'Quad', autoFill: true })],
            });

        test('a joined challenge resolves class rules by id, including the inline auto-submit', () => {
            seed(rulesForQuad());
            settings.rememberChallengeTitles([
                { id: 7, ...challenge() },
                { id: 8, ...challenge({ hours: 2 }) },
            ]);
            expect(settings.getEffectiveSetting('exposure', '7')).toBe(70);
            expect(settings.getEffectiveSetting('autoFill', '7')).toBe(true);
            expect(settings.getEffectiveSetting('autoFill', '8')).toBe(false);
            expect(settings.getTitleProfile('Seaside', 7)).toEqual({
                name: 'Quad',
                values: { exposure: 70 },
                suppressed: false,
            });
            // An explicit payload field beats the remembered fact.
            expect(settings.getTitleProfile({ title: 'Seaside', max_photo_submits: 2 }, 7)).toBeNull();
        });

        test('an unknown id resolves nothing and a non-numeric or over-long fact is dropped', () => {
            seed(rulesForQuad());
            settings.rememberChallengeTitles([
                invalid({ id: 9, ...challenge(), start_time: '1700000000', type: 't'.repeat(201) }),
            ]);
            expect(settings.getEffectiveSetting('exposure', '9')).toBe(100);
            expect(settings.getEffectiveSetting('exposure', 'nope')).toBe(100);
        });

        test('a per-challenge override equal to the GLOBAL value still sticks against a rule value', () => {
            seed(rulesForQuad());
            settings.rememberChallengeTitles([{ id: 7, ...challenge() }]);
            expect(settings.setChallengeOverride('autoFill', '7', false)).toBe(true);
            expect(saved().challengeSettings.perChallenge['7']).toEqual({ autoFill: false });
            expect(settings.getEffectiveSetting('autoFill', '7')).toBe(false);
        });

        test('suppressing the rule profile keeps the rule inline values', () => {
            seed(rulesForQuad());
            settings.rememberChallengeTitles([{ id: 7, ...challenge() }]);
            expect(settings.replaceChallengeOverrides('7', {}, true)).toBe(true);
            expect(settings.getEffectiveSetting('exposure', '7')).toBe(100);
            expect(settings.getEffectiveSetting('autoFill', '7')).toBe(true);
            expect(settings.getTitleProfile('Seaside', 7)).toMatchObject({ suppressed: true });
        });
    });

    describe('hasRuleJoinOptIn', () => {
        const optIn = (rule: Record<string, unknown>, target = challenge({ tags: ['Comm'] })) => {
            seed(base({ profiles: { P: { exposure: 70 } }, titleRules: [withTags(rule)] }));
            return settings.hasRuleJoinOptIn(target);
        };

        test('an explicit autoJoin: true from any rule opts in', () => {
            expect(optIn({ title: '', pics: 4, autoJoin: true })).toBe(true);
        });

        test('a profile from a rule naming a title or a challenge tag opts in', () => {
            expect(optIn({ title: 'Seaside', profile: 'P' })).toBe(true);
            expect(optIn({ title: '', challengeTag: 'Comm', profile: 'P' })).toBe(true);
        });

        test('a profile from a class-only rule does not, and neither does no match', () => {
            expect(optIn({ title: '', pics: 4, profile: 'P' })).toBe(false);
            expect(optIn({ title: 'Other', profile: 'P' })).toBe(false);
        });
    });

    test('deleting a profile keeps a rule that still carries an inline override', () => {
        seed(
            base({
                profiles: { P: { exposure: 70 } },
                titleRules: [
                    withTags({ title: '', pics: 4, profile: 'P', autoJoin: true }),
                    withTags({ title: 'Only', profile: 'P' }),
                    withTags({ title: 'Broken', profile: 'P', autoJoin: 'yes' }),
                ],
            }),
        );
        expect(settings.deleteChallengeProfile('P')).toBe(true);
        expect(saved().challengeSettings.titleRules).toEqual([withTags({ title: '', pics: 4, autoJoin: true })]);
    });
});
