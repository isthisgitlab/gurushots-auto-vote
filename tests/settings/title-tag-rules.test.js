/**
 * Title-keyed tag rules on the settings facade.
 *
 * GuruShots challenges rotate with a fresh id each time, so id-keyed
 * per-challenge overrides are lost on every rotation. These rules match a
 * challenge by its (stable) title and merge their tags into the effective
 * must/should-include lists at fill time. Covers:
 *   - setTitleRules/getTitleRules round-trip + sanitization
 *   - getEffectiveTagSetting precedence (exact case-insensitive match, union
 *     with global default and with a per-challenge id override, no-op cases).
 *
 * Drives the in-memory headless-store seam (same one reset-all-settings.test.js
 * uses) so the facade's loadSettings/saveSettings round-trip without touching fs.
 */

const settings = require('../../src/js/settings');

jest.mock('../../src/js/logger', () => ({
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    api: jest.fn(),
    startOperation: jest.fn(),
    endOperation: jest.fn(),
    apiRequest: jest.fn(),
    apiResponse: jest.fn(),
    isDevMode: jest.fn(() => false),
    isSourceCode: jest.fn(() => true),
    getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
    withCategory: jest.fn(() => ({
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
    })),
}));

describe('settings facade — title-keyed tag rules', () => {
    let store;

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
    });

    afterEach(() => {
        delete globalThis.__GS_HEADLESS__;
        delete globalThis.AndroidHeadlessStore;
    });

    describe('getTitleRules / setTitleRules', () => {
        test('defaults to an empty array', () => {
            expect(settings.getTitleRules()).toEqual([]);
        });

        test('round-trips a saved rule', () => {
            const ok = settings.setTitleRules([
                { title: "Let's See Hats", mustIncludeTags: ['hat'], shouldIncludeTags: ['portrait'] },
            ]);
            expect(ok).toBe(true);
            expect(settings.getTitleRules()).toEqual([
                { title: "Let's See Hats", mustIncludeTags: ['hat'], shouldIncludeTags: ['portrait'] },
            ]);
        });

        test('trims the title and the tags', () => {
            settings.setTitleRules([
                { title: "  Let's See Hats  ", mustIncludeTags: [' hat '], shouldIncludeTags: ['  portrait'] },
            ]);
            expect(settings.getTitleRules()).toEqual([
                { title: "Let's See Hats", mustIncludeTags: ['hat'], shouldIncludeTags: ['portrait'] },
            ]);
        });

        test('drops rules with an empty title', () => {
            settings.setTitleRules([
                { title: '   ', mustIncludeTags: ['hat'], shouldIncludeTags: [] },
                { title: 'Keep Me', mustIncludeTags: ['x'], shouldIncludeTags: [] },
            ]);
            expect(settings.getTitleRules()).toEqual([
                { title: 'Keep Me', mustIncludeTags: ['x'], shouldIncludeTags: [] },
            ]);
        });

        test('drops rules that contribute no tags', () => {
            settings.setTitleRules([
                { title: 'No Tags', mustIncludeTags: [], shouldIncludeTags: [] },
                { title: 'Has Tags', mustIncludeTags: ['x'], shouldIncludeTags: [] },
            ]);
            expect(settings.getTitleRules()).toEqual([
                { title: 'Has Tags', mustIncludeTags: ['x'], shouldIncludeTags: [] },
            ]);
        });

        test('keeps a profile-only rule and canonicalizes the profile name', () => {
            settings.saveChallengeProfile('Portrait Tactic', { exposure: 80 });
            expect(
                settings.setTitleRules([
                    {
                        title: 'Portraits',
                        profile: 'portrait tactic',
                        mustIncludeTags: [],
                        shouldIncludeTags: [],
                    },
                ]),
            ).toBe(true);
            expect(settings.getTitleRules()).toEqual([
                {
                    title: 'Portraits',
                    profile: 'Portrait Tactic',
                    mustIncludeTags: [],
                    shouldIncludeTags: [],
                },
            ]);
        });

        test('rejects an unknown profile without persisting', () => {
            expect(
                settings.setTitleRules([
                    { title: 'Portraits', profile: 'missing', mustIncludeTags: [], shouldIncludeTags: [] },
                ]),
            ).toBe(false);
            expect(settings.getTitleRules()).toEqual([]);
        });

        test('de-dupes by normalized title, last wins', () => {
            settings.setTitleRules([
                { title: "Let's See Hats", mustIncludeTags: ['old'], shouldIncludeTags: [] },
                { title: "let's see HATS", mustIncludeTags: ['new'], shouldIncludeTags: [] },
            ]);
            expect(settings.getTitleRules()).toEqual([
                { title: "let's see HATS", mustIncludeTags: ['new'], shouldIncludeTags: [] },
            ]);
        });

        test('rejects (returns false) an invalid tag without persisting', () => {
            const ok = settings.setTitleRules([
                { title: 'Bad', mustIncludeTags: ['a'.repeat(51)], shouldIncludeTags: [] },
            ]);
            expect(ok).toBe(false);
            expect(settings.getTitleRules()).toEqual([]);
        });

        test('rejects a non-array argument', () => {
            expect(settings.setTitleRules('nope')).toBe(false);
        });

        test('rejects (returns false) more than the rule-count cap', () => {
            const tooMany = Array.from({ length: 201 }, (_, i) => ({
                title: `Rule ${i}`,
                mustIncludeTags: ['x'],
                shouldIncludeTags: [],
            }));
            expect(settings.setTitleRules(tooMany)).toBe(false);
            expect(settings.getTitleRules()).toEqual([]);
        });

        test('rejects (returns false) a title longer than the cap', () => {
            const ok = settings.setTitleRules([
                { title: 'a'.repeat(201), mustIncludeTags: ['x'], shouldIncludeTags: [] },
            ]);
            expect(ok).toBe(false);
            expect(settings.getTitleRules()).toEqual([]);
        });
    });

    /**
     * Inline overrides: a rule may set behaviour for its title directly, without
     * a named profile. An OMITTED key means "inherit" and must never be written
     * as a default — otherwise a rule saved today would freeze today's default
     * and silently stop following a later change to the global setting.
     */
    describe('inline rule overrides', () => {
        test('round-trips autoJoin, autoFill and the join window', () => {
            const ok = settings.setTitleRules([
                {
                    title: 'abc',
                    mustIncludeTags: [],
                    shouldIncludeTags: [],
                    autoJoin: true,
                    autoFill: false,
                    autoJoinWithinHoursOfEnd: 24,
                },
            ]);
            expect(ok).toBe(true);
            expect(settings.getTitleRules()[0]).toMatchObject({
                title: 'abc',
                autoJoin: true,
                autoFill: false,
                autoJoinWithinHoursOfEnd: 24,
            });
        });

        test('a rule whose ONLY content is an inline override is kept, not dropped as a no-op', () => {
            settings.setTitleRules([{ title: 'abc', mustIncludeTags: [], shouldIncludeTags: [], autoJoin: true }]);
            expect(settings.getTitleRules()).toHaveLength(1);
        });

        test('an omitted key stays omitted (inherit), never defaulted into storage', () => {
            settings.setTitleRules([{ title: 'abc', mustIncludeTags: ['hat'], shouldIncludeTags: [] }]);
            const [rule] = settings.getTitleRules();
            expect(rule).not.toHaveProperty('autoJoin');
            expect(rule).not.toHaveProperty('autoJoinWithinHoursOfEnd');
        });

        test("the editor's empty-string 'inherit' is dropped rather than coerced to 0/false", () => {
            settings.setTitleRules([
                {
                    title: 'abc',
                    mustIncludeTags: ['hat'],
                    shouldIncludeTags: [],
                    autoJoin: '',
                    autoJoinWithinHoursOfEnd: '',
                },
            ]);
            const [rule] = settings.getTitleRules();
            expect(rule).not.toHaveProperty('autoJoin');
            expect(rule).not.toHaveProperty('autoJoinWithinHoursOfEnd');
        });

        test('an explicit 0 window is preserved — it means "join on sight", not "inherit"', () => {
            settings.setTitleRules([
                { title: 'abc', mustIncludeTags: [], shouldIncludeTags: [], autoJoinWithinHoursOfEnd: 0 },
            ]);
            expect(settings.getTitleRules()[0].autoJoinWithinHoursOfEnd).toBe(0);
        });

        test('an explicit false is preserved and distinct from inherit', () => {
            settings.setTitleRules([{ title: 'abc', mustIncludeTags: [], shouldIncludeTags: [], autoJoin: false }]);
            expect(settings.getTitleRules()[0].autoJoin).toBe(false);
        });

        test('rejects the whole save when an inline value fails schema validation', () => {
            expect(
                settings.setTitleRules([
                    { title: 'abc', mustIncludeTags: [], shouldIncludeTags: [], autoJoin: 'yes please' },
                ]),
            ).toBe(false);
            expect(
                settings.setTitleRules([
                    { title: 'abc', mustIncludeTags: [], shouldIncludeTags: [], autoJoinWithinHoursOfEnd: -5 },
                ]),
            ).toBe(false);
            expect(
                settings.setTitleRules([
                    { title: 'abc', mustIncludeTags: [], shouldIncludeTags: [], autoJoinWithinHoursOfEnd: 99999 },
                ]),
            ).toBe(false);
            expect(settings.getTitleRules()).toEqual([]);
        });

        test('only allowlisted keys are stored — an arbitrary setting is not smuggled in', () => {
            settings.setTitleRules([
                { title: 'abc', mustIncludeTags: ['hat'], shouldIncludeTags: [], exposure: 80, nonsense: 1 },
            ]);
            const [rule] = settings.getTitleRules();
            expect(rule).not.toHaveProperty('exposure');
            expect(rule).not.toHaveProperty('nonsense');
        });

        describe('getTitleRuleOverrides', () => {
            test('returns the inline values for a matching title, case-insensitively', () => {
                settings.setTitleRules([
                    {
                        title: 'ABC',
                        mustIncludeTags: [],
                        shouldIncludeTags: [],
                        autoJoin: true,
                        autoJoinWithinHoursOfEnd: 24,
                    },
                ]);
                expect(settings.getTitleRuleOverrides('abc')).toEqual({ autoJoin: true, autoJoinWithinHoursOfEnd: 24 });
            });

            test('returns {} for an unknown title and for a tag-only rule', () => {
                settings.setTitleRules([{ title: 'abc', mustIncludeTags: ['hat'], shouldIncludeTags: [] }]);
                expect(settings.getTitleRuleOverrides('abc')).toEqual({});
                expect(settings.getTitleRuleOverrides('nope')).toEqual({});
                expect(settings.getTitleRuleOverrides('')).toEqual({});
            });
        });
    });

    /**
     * Match modes + challenge-tag conditions. A rule carries a title condition,
     * a challenge-tag condition, or both; every condition present must hold.
     * Back-compat is the load-bearing case: a rule saved before match modes
     * existed has no `match` key and must keep matching EXACTLY.
     */
    describe('match modes and challenge-tag conditions', () => {
        const save = (...rules) =>
            settings.setTitleRules(rules.map((r) => ({ mustIncludeTags: [], shouldIncludeTags: [], ...r })));

        describe('title match modes', () => {
            test('a rule with no match key stays exact (back-compat)', () => {
                save({ title: 'abc', autoJoin: true });
                expect(settings.getTitleRuleOverrides({ title: 'abc' })).toEqual({ autoJoin: true });
                expect(settings.getTitleRuleOverrides({ title: 'The ABC Challenge' })).toEqual({});
            });

            test('contains matches a substring, case-insensitively', () => {
                save({ title: 'abc', match: 'contains', autoJoin: true });
                expect(settings.getTitleRuleOverrides({ title: 'The ABC Challenge' })).toEqual({ autoJoin: true });
                expect(settings.getTitleRuleOverrides({ title: 'nothing here' })).toEqual({});
            });

            test('starts matches only at the beginning', () => {
                save({ title: 'photo', match: 'starts', autoJoin: true });
                expect(settings.getTitleRuleOverrides({ title: 'Photographer of the Week' })).toEqual({
                    autoJoin: true,
                });
                expect(settings.getTitleRuleOverrides({ title: 'Best Photo' })).toEqual({});
            });

            test('the default mode is not persisted, a non-default one is', () => {
                save({ title: 'a', autoJoin: true }, { title: 'b', match: 'contains', autoJoin: true });
                const [exact, contains] = settings.getTitleRules();
                expect(exact).not.toHaveProperty('match');
                expect(contains.match).toBe('contains');
            });

            test('an unknown match mode is rejected rather than silently narrowed', () => {
                expect(settings.setTitleRules([{ title: 'a', match: 'regex', mustIncludeTags: [] }])).toBe(false);
                expect(settings.getTitleRules()).toEqual([]);
            });
        });

        describe('challenge-tag conditions', () => {
            test('a tag-only rule matches any challenge carrying that tag', () => {
                save({ challengeTag: 'Exhibition', autoJoin: true });
                expect(settings.getTitleRuleOverrides({ title: 'Anything', tags: ['Exhibition', 'Comm'] })).toEqual({
                    autoJoin: true,
                });
                expect(settings.getTitleRuleOverrides({ title: 'Anything', tags: ['Turbo'] })).toEqual({});
            });

            test('tag comparison is case- and whitespace-insensitive', () => {
                save({ challengeTag: '  exhibition ', autoJoin: true });
                expect(settings.getTitleRuleOverrides({ title: 'x', tags: ['EXHIBITION'] })).toEqual({
                    autoJoin: true,
                });
            });

            test('a rule with BOTH conditions requires both to hold', () => {
                save({ title: 'photo', match: 'starts', challengeTag: 'Turbo', autoJoin: true });
                expect(settings.getTitleRuleOverrides({ title: 'Photo of the Week', tags: ['Turbo'] })).toEqual({
                    autoJoin: true,
                });
                // Title matches, tag does not.
                expect(settings.getTitleRuleOverrides({ title: 'Photo of the Week', tags: ['Comm'] })).toEqual({});
                // Tag matches, title does not.
                expect(settings.getTitleRuleOverrides({ title: 'Going Viral', tags: ['Turbo'] })).toEqual({});
            });

            test('a challenge with no tags cannot satisfy a tag condition', () => {
                save({ challengeTag: 'Exhibition', autoJoin: true });
                expect(settings.getTitleRuleOverrides({ title: 'x' })).toEqual({});
                expect(settings.getTitleRuleOverrides({ title: 'x', tags: [] })).toEqual({});
            });

            test('a tag-only rule survives the save (it has no title to key on)', () => {
                save({ challengeTag: 'Exhibition', autoJoin: true });
                expect(settings.getTitleRules()).toHaveLength(1);
                expect(settings.getTitleRules()[0]).toMatchObject({ challengeTag: 'Exhibition', autoJoin: true });
            });

            test('a rule with neither condition is dropped', () => {
                save({ autoJoin: true });
                expect(settings.getTitleRules()).toEqual([]);
            });
        });

        describe('precedence when several rules match', () => {
            test('exact beats starts beats contains beats tag-only', () => {
                save(
                    { challengeTag: 'Turbo', autoJoinWithinHoursOfEnd: 1 },
                    { title: 'pho', match: 'contains', autoJoinWithinHoursOfEnd: 2 },
                    { title: 'photo', match: 'starts', autoJoinWithinHoursOfEnd: 3 },
                    { title: 'photo of the week', autoJoinWithinHoursOfEnd: 4 },
                );
                const target = { title: 'Photo of the Week', tags: ['Turbo'] };
                expect(settings.getTitleRuleOverrides(target)).toEqual({ autoJoinWithinHoursOfEnd: 4 });
            });

            test('with the exact rule gone, starts-with wins', () => {
                save(
                    { challengeTag: 'Turbo', autoJoinWithinHoursOfEnd: 1 },
                    { title: 'pho', match: 'contains', autoJoinWithinHoursOfEnd: 2 },
                    { title: 'photo', match: 'starts', autoJoinWithinHoursOfEnd: 3 },
                );
                expect(settings.getTitleRuleOverrides({ title: 'Photo of the Week', tags: ['Turbo'] })).toEqual({
                    autoJoinWithinHoursOfEnd: 3,
                });
            });

            test('carrying both conditions outranks the same title mode alone', () => {
                save(
                    { title: 'pho', match: 'contains', autoJoinWithinHoursOfEnd: 2 },
                    { title: 'pho', match: 'contains', challengeTag: 'Turbo', autoJoinWithinHoursOfEnd: 9 },
                );
                expect(settings.getTitleRuleOverrides({ title: 'Photo of the Week', tags: ['Turbo'] })).toEqual({
                    autoJoinWithinHoursOfEnd: 9,
                });
            });

            test('same mode and specificity: the longer pattern wins', () => {
                save(
                    { title: 'pho', match: 'contains', autoJoinWithinHoursOfEnd: 2 },
                    { title: 'photo of', match: 'contains', autoJoinWithinHoursOfEnd: 7 },
                );
                expect(settings.getTitleRuleOverrides({ title: 'Photo of the Week' })).toEqual({
                    autoJoinWithinHoursOfEnd: 7,
                });
            });

            test('a total tie resolves to the earliest rule, not an arbitrary one', () => {
                save(
                    { challengeTag: 'Turbo', autoJoinWithinHoursOfEnd: 1 },
                    { challengeTag: 'Comm', autoJoinWithinHoursOfEnd: 2 },
                );
                expect(settings.getTitleRuleOverrides({ title: 'x', tags: ['Turbo', 'Comm'] })).toEqual({
                    autoJoinWithinHoursOfEnd: 1,
                });
            });
        });

        describe('de-duplication', () => {
            test('same title with different modes are kept as distinct rules', () => {
                save(
                    { title: 'abc', autoJoinWithinHoursOfEnd: 1 },
                    { title: 'abc', match: 'contains', autoJoinWithinHoursOfEnd: 2 },
                );
                expect(settings.getTitleRules()).toHaveLength(2);
            });

            test('an identical condition still collapses, last wins', () => {
                save(
                    { title: 'abc', match: 'contains', autoJoinWithinHoursOfEnd: 1 },
                    { title: 'abc', match: 'contains', autoJoinWithinHoursOfEnd: 2 },
                );
                const rules = settings.getTitleRules();
                expect(rules).toHaveLength(1);
                expect(rules[0].autoJoinWithinHoursOfEnd).toBe(2);
            });

            test('two tag-only rules for different tags both survive', () => {
                save({ challengeTag: 'Turbo', autoJoin: true }, { challengeTag: 'Comm', autoJoin: false });
                expect(settings.getTitleRules()).toHaveLength(2);
            });
        });

        describe('several titles on one rule', () => {
            test("any listed title matches, with the rule's one match mode", () => {
                save({ titles: ['Hats', 'Going Viral'], autoJoin: true });
                expect(settings.getTitleRuleOverrides({ title: 'hats' })).toEqual({ autoJoin: true });
                expect(settings.getTitleRuleOverrides({ title: 'Going Viral' })).toEqual({ autoJoin: true });
                expect(settings.getTitleRuleOverrides({ title: 'Something Else' })).toEqual({});
            });

            test('persists the trimmed, de-duplicated list with title mirroring the first', () => {
                save({ titles: ['  Hats ', '', 'hats', 'Going Viral'], autoJoin: true });
                const [rule] = settings.getTitleRules();
                expect(rule.title).toBe('Hats');
                expect(rule.titles).toEqual(['Hats', 'Going Viral']);
            });

            test('a list of one is stored as a plain single-title rule', () => {
                save({ titles: ['Hats', '  '], autoJoin: true });
                const [rule] = settings.getTitleRules();
                expect(rule.title).toBe('Hats');
                expect(rule).not.toHaveProperty('titles');
            });

            test('the same title set in another order is one rule, last wins', () => {
                save(
                    { titles: ['a', 'b'], autoJoinWithinHoursOfEnd: 1 },
                    { titles: ['B', 'A'], autoJoinWithinHoursOfEnd: 2 },
                );
                const rules = settings.getTitleRules();
                expect(rules).toHaveLength(1);
                expect(rules[0].autoJoinWithinHoursOfEnd).toBe(2);
            });

            test('the tie-break uses the title that matched, not the first one', () => {
                save(
                    { titles: ['x', 'photo of'], match: 'contains', autoJoinWithinHoursOfEnd: 7 },
                    { title: 'pho', match: 'contains', autoJoinWithinHoursOfEnd: 2 },
                );
                expect(settings.getTitleRuleOverrides({ title: 'Photo of the Week' })).toEqual({
                    autoJoinWithinHoursOfEnd: 7,
                });
            });

            test('an over-length title anywhere in the list rejects the save', () => {
                expect(settings.setTitleRules([{ titles: ['ok', 'x'.repeat(201)], autoJoin: true }])).toBe(false);
            });

            test('too many titles on one rule rejects the save', () => {
                const titles = Array.from({ length: 51 }, (_, i) => `t${i}`);
                expect(settings.setTitleRules([{ titles, autoJoin: true }])).toBe(false);
            });
        });

        test('a bare title string still resolves (callers that have no challenge)', () => {
            save({ title: 'abc', match: 'contains', autoJoin: true });
            expect(settings.getTitleRuleOverrides('The ABC Challenge')).toEqual({ autoJoin: true });
        });
    });

    describe('getEffectiveTagSetting', () => {
        test('with no rules, equals the global default ("no filter" = empty)', () => {
            const challenge = { id: 1, title: 'Anything' };
            expect(settings.getEffectiveTagSetting('mustIncludeTags', challenge)).toEqual([]);
        });

        test('matches title exactly but case-insensitively and unions with the global default', () => {
            settings.setGlobalDefault('mustIncludeTags', ['common']);
            settings.setTitleRules([{ title: "Let's See Hats", mustIncludeTags: ['hat'], shouldIncludeTags: [] }]);

            // id differs from any saved override; only the title matches.
            const challenge = { id: 4242, title: "lEt'S sEe hAtS" };
            expect(settings.getEffectiveTagSetting('mustIncludeTags', challenge)).toEqual(['common', 'hat']);
        });

        test('non-matching title falls back to the global default unchanged', () => {
            settings.setGlobalDefault('shouldIncludeTags', ['base']);
            settings.setTitleRules([{ title: 'Some Other Title', mustIncludeTags: [], shouldIncludeTags: ['x'] }]);

            const challenge = { id: 7, title: 'Unrelated' };
            expect(settings.getEffectiveTagSetting('shouldIncludeTags', challenge)).toEqual(['base']);
        });

        test('a rule that sets only one list leaves the other at its base', () => {
            settings.setTitleRules([{ title: 'Portraits', mustIncludeTags: [], shouldIncludeTags: ['face'] }]);

            const challenge = { id: 9, title: 'Portraits' };
            expect(settings.getEffectiveTagSetting('mustIncludeTags', challenge)).toEqual([]); // base, no must in rule
            expect(settings.getEffectiveTagSetting('shouldIncludeTags', challenge)).toEqual(['face']);
        });

        test('de-dupes when the rule repeats a global-default tag', () => {
            settings.setGlobalDefault('mustIncludeTags', ['hat']);
            settings.setTitleRules([{ title: 'Hats', mustIncludeTags: ['hat', 'cap'], shouldIncludeTags: [] }]);

            const challenge = { id: 11, title: 'Hats' };
            expect(settings.getEffectiveTagSetting('mustIncludeTags', challenge)).toEqual(['hat', 'cap']);
        });

        test('unions on top of a per-challenge id override (override is the base)', () => {
            const challenge = { id: 55, title: 'Rotating' };
            settings.setChallengeOverride('mustIncludeTags', String(challenge.id), ['override']);
            settings.setTitleRules([{ title: 'Rotating', mustIncludeTags: ['title'], shouldIncludeTags: [] }]);

            expect(settings.getEffectiveTagSetting('mustIncludeTags', challenge)).toEqual(['override', 'title']);
        });

        test('an explicit empty per-challenge override still unions the rule tags (union semantics, by design)', () => {
            // A user-chosen "merge/union" feature: title-rule tags are always
            // added on top of the base, even when the base is an explicit empty
            // per-challenge override. Documents that the rule is not suppressed
            // by an empty id-keyed override.
            const challenge = { id: 77, title: 'Rotating Empty' };
            settings.setChallengeOverride('mustIncludeTags', String(challenge.id), []);
            settings.setTitleRules([{ title: 'Rotating Empty', mustIncludeTags: ['hat'], shouldIncludeTags: [] }]);

            expect(settings.getEffectiveTagSetting('mustIncludeTags', challenge)).toEqual(['hat']);
        });

        test('the SAME title with a DIFFERENT id still resolves the rule (survives rotation)', () => {
            settings.setTitleRules([{ title: 'Weekly Theme', mustIncludeTags: ['theme'], shouldIncludeTags: [] }]);

            const firstRun = { id: 100, title: 'Weekly Theme' };
            const nextRun = { id: 999, title: 'Weekly Theme' }; // rotated back, new id
            expect(settings.getEffectiveTagSetting('mustIncludeTags', firstRun)).toEqual(['theme']);
            expect(settings.getEffectiveTagSetting('mustIncludeTags', nextRun)).toEqual(['theme']);
        });

        test('a non-tag key falls through to the plain id-keyed resolution', () => {
            settings.setGlobalDefault('autoFill', true);
            const challenge = { id: 3, title: 'Whatever' };
            expect(settings.getEffectiveTagSetting('autoFill', challenge)).toBe(true);
        });

        test('a challenge without a title returns the base', () => {
            settings.setGlobalDefault('mustIncludeTags', ['base']);
            settings.setTitleRules([{ title: 'Has Title', mustIncludeTags: ['x'], shouldIncludeTags: [] }]);

            expect(settings.getEffectiveTagSetting('mustIncludeTags', { id: 1 })).toEqual(['base']);
        });
    });

    describe('getTitleProfile', () => {
        test('resolves an exact title case-insensitively and returns sanitized values', () => {
            settings.saveChallengeProfile('Portrait Tactic', { exposure: 80, autoFill: true });
            settings.setTitleRules([
                {
                    title: 'Weekly Portraits',
                    profile: 'Portrait Tactic',
                    mustIncludeTags: [],
                    shouldIncludeTags: [],
                },
            ]);

            expect(settings.getTitleProfile(' weekly PORTRAITS ')).toEqual({
                name: 'Portrait Tactic',
                values: { exposure: 80, autoFill: true },
            });
            expect(settings.getTitleProfile('Other')).toBeNull();
        });

        test('deleting an assigned profile removes only its part of each title rule', () => {
            settings.saveChallengeProfile('Tactic', { exposure: 80 });
            settings.setTitleRules([
                { title: 'Profile only', profile: 'Tactic', mustIncludeTags: [], shouldIncludeTags: [] },
                { title: 'Also tags', profile: 'Tactic', mustIncludeTags: ['hat'], shouldIncludeTags: [] },
            ]);

            expect(settings.deleteChallengeProfile('tactic')).toBe(true);
            expect(settings.getTitleRules()).toEqual([
                { title: 'Also tags', mustIncludeTags: ['hat'], shouldIncludeTags: [] },
            ]);
        });

        test('profile overwrite updates assigned rule casing', () => {
            settings.saveChallengeProfile('Tactic', { exposure: 80 });
            settings.setTitleRules([
                { title: 'Portraits', profile: 'Tactic', mustIncludeTags: [], shouldIncludeTags: [] },
            ]);

            expect(settings.saveChallengeProfile('TACTIC', { exposure: 70 })).toBe(true);
            expect(settings.getTitleRules()[0].profile).toBe('TACTIC');
            expect(settings.getTitleProfile('Portraits')).toEqual({ name: 'TACTIC', values: { exposure: 70 } });
        });
    });
});
