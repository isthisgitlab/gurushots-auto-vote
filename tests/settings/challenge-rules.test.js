/**
 * Challenge rules: the pure matcher / default order (settings/challengeRules.js)
 * and the facade's class conditions (type, photo count, runtime), its per-key
 * cascade, and the id-keyed resolution through the remembered facts cache.
 *
 * Drives the in-memory headless-store seam so loadSettings/saveSettings
 * round-trip without touching fs.
 */

const rules = require('../../src/js/settings/challengeRules');
const settings = require('../../src/js/settings');

jest.mock('../../src/js/logger', () => {
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

const cat = require('../../src/js/logger').__cat;

const HOUR = 3600;
const START = 1_700_000_000;
// A challenge payload as the API sends it; `hours` sets its runtime.
const challenge = ({ hours = 24, ...over } = {}) => ({
    title: 'Seaside',
    tags: [],
    type: 'default',
    max_photo_submits: 4,
    start_time: START,
    close_time: START + hours * HOUR,
    ...over,
});

describe('settings/challengeRules — pure matcher', () => {
    const target = (over) => rules.ruleMatchTarget(challenge(over));

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

    test('runtime is close - start in hours, or null when unreadable', () => {
        expect(rules.challengeRuntimeHours(challenge({ hours: 72 }))).toBe(72);
        expect(rules.challengeRuntimeHours({ close_time: START })).toBeNull();
        expect(rules.challengeRuntimeHours({ start_time: START })).toBeNull();
        expect(rules.challengeRuntimeHours({ start_time: START, close_time: START })).toBeNull();
        expect(rules.challengeRuntimeHours({ start_time: 0, close_time: HOUR })).toBeNull();
        expect(rules.challengeRuntimeHours(null)).toBeNull();
    });

    test('a bare title and a missing target normalize to empty keys', () => {
        expect(rules.ruleMatchTarget('  Hats ')).toMatchObject({ titleKey: 'hats', tagKeys: [], pics: null });
        expect(rules.ruleMatchTarget(null)).toEqual({
            titleKey: '',
            tagKeys: [],
            typeKey: '',
            pics: null,
            runtimeHours: null,
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

    test('a title condition needs a title; a rule with no condition matches nothing', () => {
        expect(rules.ruleMatches({ title: 'Seaside' }, rules.ruleMatchTarget({ tags: ['x'] }))).toBe(false);
        expect(rules.ruleMatches({ autoJoin: true }, target())).toBe(false);
        expect(rules.hasRuleCondition({ autoJoin: true })).toBe(false);
        expect(rules.hasRuleCondition({ maxHours: 24 })).toBe(true);
        expect(rules.hasRuleCondition({ title: 'x' })).toBe(true);
    });

    test('matchingRules keeps list order and tolerates a non-array list', () => {
        const a = { pics: 4 };
        const b = { title: 'Seaside' };
        expect(rules.matchingRules([a, { pics: 2 }, b], challenge())).toEqual([a, b]);
        expect(rules.matchingRules(null, challenge())).toEqual([]);
        expect(rules.matchingRules([], challenge())).toEqual([]);
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
    let store;
    const seed = (obj) => {
        store.value = JSON.stringify({ _challengeRulesOrderedV1: true, ...obj });
        settings.loadSettings();
        store.write.mockClear();
    };
    const saved = () => JSON.parse(store.value);
    const base = (over = {}) => ({ challengeSettings: { globalDefaults: {}, ...over } });
    const withTags = (rule) => ({ mustIncludeTags: [], shouldIncludeTags: [], ...rule });

    beforeEach(() => {
        globalThis.__GS_HEADLESS__ = true;
        store = {
            value: null,
            read: jest.fn(() => store.value),
            write: jest.fn((d) => {
                store.value = d;
            }),
        };
        globalThis.AndroidHeadlessStore = store;
        settings.rememberChallengeTitles([]);
        jest.clearAllMocks();
    });

    afterAll(() => {
        delete globalThis.__GS_HEADLESS__;
        delete globalThis.AndroidHeadlessStore;
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
                    perChallenge: { c1: 5 },
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
                { id: 9, ...challenge(), start_time: '1700000000', type: 't'.repeat(201) },
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
        const optIn = (rule, target = challenge({ tags: ['Comm'] })) => {
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
