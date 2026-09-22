/**
 * Settings facade edge cases: corrupt/legacy persisted blobs (missing or null
 * challengeSettings containers), rejection paths of the mutation helpers,
 * cleanup + reset helpers, title-pin fallbacks and the named-profile guards.
 *
 * Drives the in-memory headless-store seam (same as title-tag-rules.test.js)
 * so loadSettings/saveSettings round-trip without touching fs. `seed()` writes
 * a raw persisted blob; `saved()` reads back what the facade last persisted.
 */

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

const settings = require('../../src/js/settings');
const logger = require('../../src/js/logger');

const cat = logger.__cat;

describe('settings facade — edge cases', () => {
    let store;
    // Seed a raw blob, then let one load apply the (write-on-change) load-time
    // migrations so a test's write assertions only see the call under test.
    const seed = (obj) => {
        store.value = JSON.stringify(obj);
        settings.loadSettings();
        store.write.mockClear();
    };
    const saved = () => JSON.parse(store.value);

    beforeAll(() => {
        // Burn the once-per-process obsolete-settings cleanup so it never
        // rewrites a blob seeded by an individual test below.
        const warmup = JSON.stringify({ challengeSettings: { globalDefaults: {} } });
        globalThis.__GS_HEADLESS__ = true;
        globalThis.AndroidHeadlessStore = { read: () => warmup, write: () => {} };
        settings.loadSettings();
    });

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

    describe('load / save', () => {
        test('a corrupt settings blob falls back to defaults and logs the parse error', () => {
            store.value = '{not json';
            const loaded = settings.loadSettings();
            expect(loaded).toEqual(settings.getDefaultSettings());
            expect(cat.error).toHaveBeenCalledWith('Error loading settings:', expect.any(SyntaxError));
        });

        test('saveSettings reports false instead of throwing on an unserializable value', () => {
            seed({ theme: 'dark' });
            expect(settings.saveSettings({ big: 1n })).toBe(false);
            expect(cat.error).toHaveBeenCalledWith('Error saving settings:', expect.any(TypeError));
            expect(saved().theme).toBe('dark');
        });

        test('a non-object stored profile does not break the load-time migrations', () => {
            seed({ challengeSettings: { globalDefaults: {}, profiles: { Broken: 5, Ok: { exposure: 70 } } } });
            const loaded = settings.loadSettings();
            expect(loaded.challengeSettings.profiles.Broken).toBe(5);
            expect(loaded.challengeSettings.profiles.Ok).toEqual({ exposure: 70 });
        });

        test('getSetting / setSetting round-trip a top-level key', () => {
            seed({});
            expect(settings.setSetting('theme', 'dark')).toBe(true);
            expect(settings.getSetting('theme')).toBe('dark');
        });

        test('isReloadRequired: UI keys and per-challenge keys reload, others do not', () => {
            expect(settings.isReloadRequired('theme')).toBe(true);
            expect(settings.isReloadRequired('exposure')).toBe(true);
            expect(settings.isReloadRequired('lastMinuteCheckFrequency')).toBeFalsy();
            expect(settings.isReloadRequired('token')).toBeFalsy();
        });
    });

    describe('window bounds', () => {
        test('saveWindowBounds recreates a missing windowBounds container', () => {
            seed({ windowBounds: null });
            const bounds = { x: 1, y: 2, width: 300, height: 400 };
            expect(settings.saveWindowBounds('main', bounds)).toBe(true);
            expect(saved().windowBounds).toEqual({ main: bounds });
            expect(settings.getWindowBounds('main')).toEqual(bounds);

            // An existing container keeps the other window's bounds.
            const login = { x: 5, y: 6, width: 700, height: 800 };
            expect(settings.saveWindowBounds('login', login)).toBe(true);
            expect(saved().windowBounds).toEqual({ main: bounds, login });
        });

        test('getWindowBounds falls back to the default for a missing container or window', () => {
            const defaults = settings.getDefaultSettings().windowBounds;
            seed({ windowBounds: null });
            expect(settings.getWindowBounds('login')).toEqual(defaults.login);
            seed({ windowBounds: { main: { width: 1 } } });
            expect(settings.getWindowBounds('login')).toEqual(defaults.login);
        });
    });

    describe('global defaults', () => {
        test('getGlobalDefault falls back to the schema default when containers are missing', () => {
            seed({ challengeSettings: null });
            expect(settings.getGlobalDefault('exposure')).toBe(100);
            seed({ challengeSettings: { globalDefaults: { exposure: 70 } } });
            expect(settings.getGlobalDefault('exposure')).toBe(70);
            expect(settings.getGlobalDefault('exposureTarget')).toBe(0);
            expect(settings.getGlobalDefault('noSuchKey')).toBeUndefined();
        });

        test('setGlobalDefault rejects unknown keys and invalid values without writing', () => {
            seed({ challengeSettings: { globalDefaults: { exposure: 70 } } });
            expect(settings.setGlobalDefault('noSuchKey', 1)).toBe(false);
            expect(settings.setGlobalDefault('exposure', 500)).toBe(false);
            // Context validation: target below the stored trigger.
            expect(settings.setGlobalDefault('exposureTarget', 50)).toBe(false);
            expect(store.write).not.toHaveBeenCalled();
            expect(cat.error).toHaveBeenCalledWith('Invalid setting key: noSuchKey', null);
        });

        test('setGlobalDefault rebuilds a missing challengeSettings / globalDefaults container', () => {
            seed({ challengeSettings: null });
            expect(settings.setGlobalDefault('exposure', 80)).toBe(true);
            expect(saved().challengeSettings.globalDefaults.exposure).toBe(80);
            expect(saved().challengeSettings.perChallenge).toEqual({});

            seed({ challengeSettings: { perChallenge: {} } });
            expect(settings.setGlobalDefault('exposure', 60)).toBe(true);
            expect(saved().challengeSettings.globalDefaults).toEqual({ exposure: 60 });
        });

        test('resetGlobalDefault restores the schema default and rejects unknown keys', () => {
            seed({ challengeSettings: { globalDefaults: { exposure: 70 } } });
            expect(settings.isGlobalDefaultModified('exposure')).toBe(true);
            expect(settings.resetGlobalDefault('exposure')).toBe(true);
            expect(saved().challengeSettings.globalDefaults.exposure).toBe(100);
            expect(settings.isGlobalDefaultModified('exposure')).toBe(false);
            expect(settings.resetGlobalDefault('noSuchKey')).toBe(false);
            expect(settings.isGlobalDefaultModified('noSuchKey')).toBe(false);
        });

        test('resetAllGlobalDefaults rebuilds every schema key even from a null container', () => {
            seed({ challengeSettings: null });
            expect(settings.resetAllGlobalDefaults()).toBe(true);
            const gd = saved().challengeSettings.globalDefaults;
            for (const key of Object.keys(settings.SETTINGS_SCHEMA)) {
                expect(gd[key]).toEqual(settings.SETTINGS_SCHEMA[key].default);
            }
        });

        test('resetAllGlobalDefaults keeps per-challenge overrides', () => {
            seed({ challengeSettings: { globalDefaults: { exposure: 70 }, perChallenge: { c1: { exposure: 60 } } } });
            expect(settings.resetAllGlobalDefaults()).toBe(true);
            const cs = saved().challengeSettings;
            expect(cs.globalDefaults.exposure).toBe(100);
            expect(cs.perChallenge).toEqual({ c1: { exposure: 60 } });
        });
    });

    describe('per-challenge overrides', () => {
        test('getChallengeOverride returns null when challengeSettings is missing', () => {
            seed({ challengeSettings: null });
            expect(settings.getChallengeOverride('exposure', 'c1')).toBeNull();
        });

        test('setChallengeOverride rejects unknown and global-only keys', () => {
            seed({});
            expect(settings.setChallengeOverride('noSuchKey', 'c1', 1)).toBe(false);
            expect(settings.setChallengeOverride('lastMinuteCheckFrequency', 'c1', 2)).toBe(false);
            expect(store.write).not.toHaveBeenCalled();
        });

        test('setChallengeOverride rebuilds missing containers', () => {
            seed({ challengeSettings: null });
            expect(settings.setChallengeOverride('exposure', 'c1', 70)).toBe(true);
            expect(saved().challengeSettings.perChallenge.c1).toEqual({ exposure: 70 });

            seed({ challengeSettings: { globalDefaults: {} } });
            expect(settings.setChallengeOverride('exposure', 'c2', 60)).toBe(true);
            expect(saved().challengeSettings.perChallenge).toEqual({ c2: { exposure: 60 } });
        });

        test('setChallengeOverrides rejects a blank id or a non-object payload', () => {
            seed({});
            expect(settings.setChallengeOverrides(null, { exposure: 70 })).toBe(false);
            expect(settings.setChallengeOverrides('   ', { exposure: 70 })).toBe(false);
            expect(settings.setChallengeOverrides('c1', null)).toBe(false);
            expect(settings.setChallengeOverrides('c1', [70])).toBe(false);
            expect(settings.setChallengeOverrides('c1', 'x')).toBe(false);
            expect(store.write).not.toHaveBeenCalled();
        });

        test('setChallengeOverrides rebuilds a null container and rejects an invalid combination', () => {
            seed({ challengeSettings: null });
            expect(settings.setChallengeOverrides(' c1 ', { exposure: 70 })).toBe(true);
            expect(saved().challengeSettings.perChallenge.c1).toEqual({ exposure: 70 });

            // exposureTarget must be 0 or >= exposure.
            expect(settings.setChallengeOverrides('c1', { exposureTarget: 50 })).toBe(false);
            expect(saved().challengeSettings.perChallenge.c1).toEqual({ exposure: 70 });
        });

        test('removeChallengeOverride is a no-op when there is nothing to remove', () => {
            seed({ challengeSettings: null });
            expect(settings.removeChallengeOverride('exposure', 'c1')).toBe(true);
            seed({ challengeSettings: { globalDefaults: {}, perChallenge: { c1: { exposure: 70 } } } });
            expect(settings.removeChallengeOverride('exposureTarget', 'c1')).toBe(true);
            expect(store.write).not.toHaveBeenCalled();
        });

        test('removeChallengeOverride refuses a removal that would leave an invalid combination', () => {
            seed({
                challengeSettings: {
                    globalDefaults: { exposure: 50, exposureTarget: 60 },
                    perChallenge: { c1: { exposure: 40, exposureTarget: 45 } },
                },
            });
            // Dropping exposure would inherit 50 with the override target 45 < 50.
            expect(settings.removeChallengeOverride('exposure', 'c1')).toBe(false);
            expect(store.write).not.toHaveBeenCalled();
            // Dropping the target inherits 60 >= 40 — fine.
            expect(settings.removeChallengeOverride('exposureTarget', 'c1')).toBe(true);
            expect(saved().challengeSettings.perChallenge.c1).toEqual({ exposure: 40 });
        });

        test('getEffectiveSetting guards unknown keys and missing containers', () => {
            seed({ challengeSettings: null });
            expect(settings.getEffectiveSetting('noSuchKey', 'c1')).toBeUndefined();
            expect(settings.getEffectiveSetting('exposure')).toBe(100);
            seed({ challengeSettings: { perChallenge: {} } });
            expect(settings.getEffectiveSetting('exposure', 'c1')).toBe(100);
        });

        test('getExposureResolver falls back to the schema default when resolution throws', () => {
            seed({});
            const entry = settings.SETTINGS_SCHEMA.exposure;
            const original = Object.getOwnPropertyDescriptor(entry, 'perChallenge');
            let armed = true;
            Object.defineProperty(entry, 'perChallenge', {
                configurable: true,
                get() {
                    if (armed) {
                        armed = false;
                        throw new Error('corrupt');
                    }
                    return true;
                },
            });
            try {
                expect(settings.getExposureResolver()('c1')).toBe(100);
                expect(cat.warning).toHaveBeenCalledWith(
                    'Error getting exposure setting for challenge c1:',
                    expect.any(Error),
                );
            } finally {
                Object.defineProperty(entry, 'perChallenge', original);
            }
        });

        test('getChallengeOverrides filters unknown keys and ignores non-object containers', () => {
            seed({
                challengeSettings: {
                    globalDefaults: {},
                    perChallenge: { c1: { exposure: 70, bogus: 1, lastMinuteCheckFrequency: 2 }, c2: [1, 2] },
                },
            });
            expect(settings.getChallengeOverrides('c1')).toEqual({ exposure: 70 });
            expect(settings.getChallengeOverrides('c2')).toEqual({});
            expect(settings.getChallengeOverrides('missing')).toEqual({});
        });

        test('replaceChallengeOverrides validates id, flag and payload', () => {
            seed({});
            expect(settings.replaceChallengeOverrides('', { exposure: 70 })).toBe(false);
            expect(settings.replaceChallengeOverrides(undefined, { exposure: 70 })).toBe(false);
            expect(settings.replaceChallengeOverrides('c1', { exposure: 70 }, 'yes')).toBe(false);
            expect(settings.replaceChallengeOverrides('c1', [70])).toBe(false);
            expect(settings.replaceChallengeOverrides('c1', { bogus: 1 })).toBe(false);
            expect(settings.replaceChallengeOverrides('c1', { exposure: 50, exposureTarget: 40 })).toBe(false);
            expect(store.write).not.toHaveBeenCalled();
        });

        test('replaceChallengeOverrides rebuilds a null container and stores only non-inherited values', () => {
            seed({ challengeSettings: null });
            expect(settings.replaceChallengeOverrides('c1', { exposure: 70, exposureTarget: 0 })).toBe(true);
            const cs = saved().challengeSettings;
            expect(cs.perChallenge.c1).toEqual({ exposure: 70 });
            expect(cs.titleProfileSuppressions).toEqual({});
        });
    });

    describe('active challenge titles / tags cache', () => {
        const PROFILE_SETUP = {
            globalDefaults: {},
            profiles: { P: { exposure: 70 } },
        };

        test('rememberChallengeTitles rejects a non-array', () => {
            expect(settings.rememberChallengeTitles('nope')).toBe(false);
            expect(settings.rememberChallengeTitles(null)).toBe(false);
        });

        test('only bounded, first-seen observations enter the cache', () => {
            seed({
                challengeSettings: {
                    ...PROFILE_SETUP,
                    titlePins: { c: 'Alpha' },
                    titleRules: [
                        { title: 'Alpha', profile: 'P' },
                        { title: 'T', profile: 'P' },
                    ],
                },
            });
            expect(
                settings.rememberChallengeTitles([
                    { id: null, title: 'Alpha' },
                    { id: '', title: 'Alpha' },
                    { id: 'a', title: '  T  ' },
                    { id: 'a', title: 'Alpha' }, // duplicate id — first row wins
                    { id: 'b', title: 5 },
                    { id: 'c', title: 'y'.repeat(201) }, // over-length → explicit miss
                ]),
            ).toBe(true);

            expect(settings.getEffectiveSetting('exposure', 'a')).toBe(70);
            expect(settings.getEffectiveSetting('exposure', 'b')).toBe(100);
            // The explicit miss must NOT fall back to the persisted pin.
            expect(settings.getEffectiveSetting('exposure', 'c')).toBe(100);
        });

        test('challenge tags are trimmed and bounded; junk entries are dropped', () => {
            seed({
                challengeSettings: {
                    ...PROFILE_SETUP,
                    titleRules: [{ challengeTag: 'exhibition', profile: 'P' }],
                },
            });
            settings.rememberChallengeTitles([
                { id: 'a', title: 'Whatever', tags: [5, '   ', 'x'.repeat(201), '  Exhibition '] },
                { id: 'b', title: 'Other', tags: 'Exhibition' },
            ]);
            expect(settings.getEffectiveSetting('exposure', 'a')).toBe(70);
            expect(settings.getEffectiveSetting('exposure', 'b')).toBe(100);
            expect(settings.getTitleProfile('Nope', 'a')).toEqual({
                name: 'P',
                values: { exposure: 70 },
                suppressed: false,
            });
        });

        test('persisted title pins resolve a title profile for an id missing from the live cache', () => {
            seed({
                challengeSettings: {
                    ...PROFILE_SETUP,
                    titlePins: { c1: 'Alpha', c2: 5, c3: 'z'.repeat(200) },
                    titleRules: [
                        { title: 'Alpha', profile: 'P' },
                        { title: 'z'.repeat(200), profile: 'P' },
                    ],
                },
            });
            expect(settings.getEffectiveSetting('exposure', 'c1')).toBe(70);
            // Non-string pin, boundary-length (possibly truncated) pin, unknown id.
            expect(settings.getEffectiveSetting('exposure', 'c2')).toBe(100);
            expect(settings.getEffectiveSetting('exposure', 'c3')).toBe(100);
            expect(settings.getEffectiveSetting('exposure', 'c4')).toBe(100);
        });
    });

    describe('title rules', () => {
        test('getTitleRules tolerates a non-array stored value', () => {
            seed({ challengeSettings: { globalDefaults: {}, titleRules: 'x' } });
            expect(settings.getTitleRules()).toEqual([]);
        });

        test('a title-keyed rule never matches a challenge known only by tags; condition-less rules are ignored', () => {
            seed({
                challengeSettings: {
                    globalDefaults: {},
                    titleRules: [
                        { autoJoin: true },
                        { title: 'Alpha', autoJoin: true },
                        { challengeTag: 'Exhibition', autoJoin: false },
                    ],
                },
            });
            expect(settings.getTitleRuleOverrides({ tags: ['exhibition'] })).toEqual({ autoJoin: false });
            expect(settings.getTitleRuleOverrides({ tags: ['comm'] })).toEqual({});
        });

        test('getTitleRuleOverrides re-validates a hand-edited inline value', () => {
            seed({ challengeSettings: { globalDefaults: {}, titleRules: [{ title: 'Alpha', autoJoin: 'yes' }] } });
            expect(settings.getTitleRuleOverrides('Alpha')).toEqual({});
        });

        test('setTitleRules rejects invalid tag-only rules', () => {
            seed({});
            expect(settings.setTitleRules([{ challengeTag: 'x'.repeat(201), mustIncludeTags: ['a'] }])).toBe(false);
            expect(
                settings.setTitleRules([{ challengeTag: 'Exhibition', match: 'regex', mustIncludeTags: ['a'] }]),
            ).toBe(false);
            expect(settings.setTitleRules([{ challengeTag: 'Exhibition', autoJoin: 'yes' }])).toBe(false);
            expect(store.write).not.toHaveBeenCalled();
            expect(cat.error).toHaveBeenCalledWith(
                expect.stringContaining('Title rule rejected for "Exhibition"'),
                null,
            );
        });

        test('setTitleRules treats a non-array tag list as empty and rebuilds a null container', () => {
            seed({ challengeSettings: null });
            expect(
                settings.setTitleRules([{ title: 'Alpha', mustIncludeTags: 'not-a-list', shouldIncludeTags: ['b'] }]),
            ).toBe(true);
            expect(saved().challengeSettings.titleRules).toEqual([
                { title: 'Alpha', mustIncludeTags: [], shouldIncludeTags: ['b'] },
            ]);
        });

        test('setTitleRules rejects a profile whose stored values are invalid', () => {
            seed({ challengeSettings: { globalDefaults: {}, profiles: { P: { exposure: 'bad' } } } });
            expect(settings.setTitleRules([{ title: 'Alpha', profile: 'P' }])).toBe(false);
            expect(store.write).not.toHaveBeenCalled();
        });

        test('profile/override composition: missing, suppressed, unrelated and corrupt overrides', () => {
            const base = {
                globalDefaults: {},
                profiles: { P: { exposure: 70 } },
                titlePins: { c1: 'Alpha' },
            };
            // No perChallenge container at all.
            seed({ challengeSettings: { ...base, perChallenge: null } });
            expect(settings.setTitleRules([{ title: 'Alpha', profile: 'P' }])).toBe(true);

            // A corrupt (non-object) override on a challenge the rule applies to fails closed.
            seed({ challengeSettings: { ...base, perChallenge: { c1: 5 } } });
            expect(settings.setTitleRules([{ title: 'Alpha', profile: 'P' }])).toBe(false);

            // ...unless that challenge suppresses its title profile.
            seed({ challengeSettings: { ...base, perChallenge: { c1: 5 }, titleProfileSuppressions: { c1: true } } });
            expect(settings.setTitleRules([{ title: 'Alpha', profile: 'P' }])).toBe(true);

            // Overrides on a challenge the rule does not reach are not checked.
            seed({ challengeSettings: { ...base, perChallenge: { c9: 5 } } });
            expect(settings.setTitleRules([{ title: 'Alpha', profile: 'P' }])).toBe(true);
        });

        test('getTitleProfile: non-array rules and a dangling profile reference resolve to null', () => {
            seed({ challengeSettings: { globalDefaults: {}, titleRules: null, profiles: { P: {} } } });
            expect(settings.getTitleProfile('Alpha')).toBeNull();
            seed({ challengeSettings: { globalDefaults: {}, titleRules: [{ title: 'Alpha', profile: 'Missing' }] } });
            expect(settings.getTitleProfile({ title: 'Alpha' })).toBeNull();
        });

        test('getTitleProfile accepts a challenge object and reports suppression for an id', () => {
            seed({
                challengeSettings: {
                    globalDefaults: {},
                    profiles: { P: { exposure: 70 } },
                    titleRules: [{ title: 'Alpha', profile: 'P' }],
                    titleProfileSuppressions: { c1: true },
                },
            });
            expect(settings.getTitleProfile({ title: 'Alpha', tags: [] })).toEqual({
                name: 'P',
                values: { exposure: 70 },
            });
            expect(settings.getTitleProfile({ title: 'Alpha' }, 'c1')).toEqual({
                name: 'P',
                values: { exposure: 70 },
                suppressed: true,
            });
        });
    });

    describe('effective tag / ignore-word lists', () => {
        test('rule tags union onto the base list, skipping non-string base entries', () => {
            seed({
                challengeSettings: {
                    globalDefaults: { mustIncludeTags: ['a', 5, 'b'] },
                    titleRules: [{ title: 'Alpha', mustIncludeTags: ['b', 'c'], shouldIncludeTags: [] }],
                },
            });
            expect(settings.getEffectiveTagSetting('mustIncludeTags', { title: 'Alpha' })).toEqual(['a', 'b', 'c']);
            // No rule tags → base passes through untouched.
            expect(settings.getEffectiveTagSetting('shouldIncludeTags', { title: 'Alpha' })).toEqual([]);
            // Non-tag key → plain effective value.
            expect(settings.getEffectiveTagSetting('exposure', { title: 'Alpha' })).toBe(100);
        });

        test('a null base (no filter) still yields a real array when a rule contributes', () => {
            seed({
                challengeSettings: {
                    globalDefaults: { mustIncludeTags: null },
                    titleRules: [{ title: 'Alpha', mustIncludeTags: ['x'] }],
                },
            });
            expect(settings.getEffectiveTagSetting('mustIncludeTags', { id: 7, title: 'Alpha' })).toEqual(['x']);
        });

        test('getEffectiveIgnoreTitleWords returns the list, or null when empty', () => {
            seed({
                challengeSettings: {
                    globalDefaults: { ignoreTitleWords: ['epic'] },
                    perChallenge: { 5: { ignoreTitleWords: [] } },
                },
            });
            expect(settings.getEffectiveIgnoreTitleWords({ title: 'x' })).toEqual(['epic']);
            expect(settings.getEffectiveIgnoreTitleWords({ id: 5 })).toBeNull();
            expect(settings.getEffectiveIgnoreTitleWords(null)).toEqual(['epic']);
        });
    });

    describe('category rules', () => {
        test('no rules → no match; condition-less rules are skipped', () => {
            seed({ challengeSettings: { globalDefaults: {} } });
            expect(settings.findCategoryRule({ type: 'exhibition' })).toBeNull();
            seed({
                challengeSettings: {
                    globalDefaults: {},
                    categoryRules: [
                        { autoJoinWithinHoursOfEnd: 5 },
                        { type: 'exhibition', autoJoinWithinHoursOfEnd: 3 },
                    ],
                },
            });
            expect(settings.getCategoryRuleOverrides({ type: 'Exhibition' })).toEqual({ autoJoinWithinHoursOfEnd: 3 });
        });

        test('empty / null inline values read as inherit', () => {
            seed({
                challengeSettings: {
                    globalDefaults: {},
                    categoryRules: [
                        { type: 'exhibition', autoJoinWithinHoursOfEnd: '', autoJoinAfterPercentElapsed: null },
                    ],
                },
            });
            expect(settings.getCategoryRuleOverrides({ type: 'exhibition' })).toEqual({});
        });

        test('setCategoryRules enforces the rule cap and rebuilds a null container', () => {
            seed({ challengeSettings: null });
            const tooMany = Array.from({ length: 21 }, (_, i) => ({ type: `t${i}` }));
            expect(settings.setCategoryRules(tooMany)).toBe(false);
            expect(store.write).not.toHaveBeenCalled();

            expect(settings.setCategoryRules([{ type: ' Exhibition ', pics: 4, autoJoinWithinHoursOfEnd: 2 }])).toBe(
                true,
            );
            expect(saved().challengeSettings.categoryRules).toEqual([
                { type: 'exhibition', pics: 4, autoJoinWithinHoursOfEnd: 2 },
            ]);
        });
    });

    describe('title pins', () => {
        test('mergeTitlePins rebuilds a null container and drops corrupt stored pins', () => {
            seed({ challengeSettings: null });
            expect(settings.mergeTitlePins({ a: 'A' }, [])).toBe(true);
            expect(saved().challengeSettings.titlePins).toEqual({ a: 'A' });

            seed({
                challengeSettings: { globalDefaults: {}, titlePins: { x: '', y: 5, z: 'q'.repeat(200), ok: 'Ok' } },
            });
            expect(settings.mergeTitlePins({ b: 'B' })).toBe(true);
            expect(saved().challengeSettings.titlePins).toEqual({ ok: 'Ok', b: 'B' });
        });

        test('the pin-cap warning fires once while the map stays saturated', () => {
            const pins = {};
            for (let i = 0; i < 500; i++) pins[`id${i}`] = `T${i}`;
            seed({ challengeSettings: { globalDefaults: {}, titlePins: pins } });

            settings.mergeTitlePins({ extra1: 'E1' });
            settings.mergeTitlePins({ extra2: 'E2' });
            const capWarnings = cat.warning.mock.calls.filter(([msg]) => String(msg).includes('pin cap'));
            expect(capWarnings).toHaveLength(1);
            expect(capWarnings[0][0]).toContain('extra1');
            expect(Object.keys(saved().challengeSettings.titlePins)).toHaveLength(500);
            expect(saved().challengeSettings.titlePins.extra2).toBeUndefined();
        });
    });

    describe('named profiles', () => {
        test('getChallengeProfiles skips reserved names and drops invalid/oversized values silently', () => {
            const huge = {};
            for (let i = 0; i < 101; i++) huge[`k${i}`] = i;
            seed({
                challengeSettings: {
                    globalDefaults: {},
                    profiles: { constructor: { exposure: 70 }, Good: { exposure: 70, exposureTarget: 5 }, Huge: huge },
                },
            });
            expect(settings.getChallengeProfiles()).toEqual({ Good: { exposure: 70 }, Huge: {} });
        });

        test('saveChallengeProfile rejects an oversized payload', () => {
            seed({});
            const huge = {};
            for (let i = 0; i < 101; i++) huge[`k${i}`] = i;
            expect(settings.saveChallengeProfile('Big', huge)).toBe(false);
            expect(store.write).not.toHaveBeenCalled();
        });

        test('saveChallengeProfile rebuilds a null container and drops reserved stored names', () => {
            seed({ challengeSettings: null });
            expect(settings.saveChallengeProfile('Mine', { exposure: 70 })).toBe(true);
            expect(saved().challengeSettings.profiles).toEqual({ Mine: { exposure: 70 } });

            seed({ challengeSettings: { globalDefaults: {}, profiles: { constructor: { exposure: 1 }, A: {} } } });
            expect(settings.saveChallengeProfile('B', {})).toBe(true);
            expect(Object.keys(saved().challengeSettings.profiles)).toEqual(['A', 'B']);
        });

        test('overwriting a profile tolerates non-array rules and renames only its own assignments', () => {
            seed({ challengeSettings: { globalDefaults: {}, profiles: { A: {} }, titleRules: 'x' } });
            expect(settings.saveChallengeProfile('a', { exposure: 70 })).toBe(true);
            expect(saved().challengeSettings.profiles).toEqual({ a: { exposure: 70 } });

            seed({
                challengeSettings: {
                    globalDefaults: {},
                    profiles: { A: {}, B: {} },
                    titleRules: [
                        { title: 'X', profile: 'A', mustIncludeTags: [], shouldIncludeTags: [] },
                        { title: 'Y', profile: 'B', mustIncludeTags: [], shouldIncludeTags: [] },
                    ],
                },
            });
            expect(settings.saveChallengeProfile('a', { exposure: 70 })).toBe(true);
            const rules = saved().challengeSettings.titleRules;
            expect(rules.map((r) => r.profile)).toEqual(['a', 'B']);
        });

        test("deleteChallengeProfile skips reserved stored keys and keeps other profiles' rules", () => {
            seed({
                challengeSettings: {
                    globalDefaults: {},
                    profiles: { constructor: {}, A: {}, B: {} },
                    titleRules: [
                        { title: 'X', profile: 'A' },
                        { title: 'Y', profile: 'B' },
                    ],
                },
            });
            expect(settings.deleteChallengeProfile('a')).toBe(true);
            const cs = saved().challengeSettings;
            expect(cs.profiles.A).toBeUndefined();
            expect(cs.titleRules).toEqual([{ title: 'Y', profile: 'B' }]);

            seed({ challengeSettings: { globalDefaults: {}, profiles: { A: {} }, titleRules: null } });
            expect(settings.deleteChallengeProfile('A')).toBe(true);
            expect(saved().challengeSettings.profiles).toEqual({});
        });

        test('applyChallengeProfile rejects a blank or reserved profile name', () => {
            seed({ challengeSettings: { globalDefaults: {}, profiles: { A: {} } } });
            expect(settings.applyChallengeProfile('', 'c1')).toBe(false);
            expect(settings.applyChallengeProfile('__proto__', 'c1')).toBe(false);
            expect(store.write).not.toHaveBeenCalled();
            expect(cat.error).toHaveBeenCalledWith('Invalid profile name: "__proto__"', null);
        });

        test('seedIntentProfiles marks an intent that cannot be saved on this install as seeded', () => {
            // Global final-window settings that are self-inconsistent make the one
            // intent that inherits them (Just Participate) fail validation.
            seed({
                challengeSettings: {
                    globalDefaults: {
                        useFinalWindowExposure: true,
                        finalWindowExposure: 90,
                        finalWindowExposureTarget: 50,
                    },
                },
            });
            expect(settings.seedIntentProfiles()).toBe(true);
            const cs = saved().challengeSettings;
            expect(cs.profiles['Just Participate']).toBeUndefined();
            expect(cs.profiles['Finish Strong']).toBeDefined();
            expect(cs.seededProfiles).toContain('just participate');
            expect(cat.warning).toHaveBeenCalledWith(
                expect.stringContaining('Skipped seeding intent profile "Just Participate"'),
            );
        });
    });

    describe('cleanup', () => {
        test('cleanupStaleChallengeSetting: nothing to do without a container or stale ids', () => {
            seed({ challengeSettings: null });
            expect(settings.cleanupStaleChallengeSetting(['c1'])).toBe(true);
            seed({ challengeSettings: { globalDefaults: {}, perChallenge: { c1: { exposure: 70 } } } });
            expect(settings.cleanupStaleChallengeSetting(['c1'])).toBe(true);
            expect(store.write).not.toHaveBeenCalled();
        });

        test('cleanupStaleChallengeSetting prunes stale overrides and suppressions', () => {
            seed({
                challengeSettings: {
                    globalDefaults: {},
                    perChallenge: { c1: { exposure: 70 }, old: { exposure: 60 } },
                    titleProfileSuppressions: { c1: true, gone: true },
                },
            });
            expect(settings.cleanupStaleChallengeSetting(['c1'])).toBe(true);
            const cs = saved().challengeSettings;
            expect(cs.perChallenge).toEqual({ c1: { exposure: 70 } });
            expect(cs.titleProfileSuppressions).toEqual({ c1: true });
        });

        test('cleanupStaleChallengeSetting handles missing maps', () => {
            seed({ challengeSettings: { globalDefaults: {}, titleProfileSuppressions: { gone: true } } });
            expect(settings.cleanupStaleChallengeSetting([])).toBe(true);
            expect(saved().challengeSettings.titleProfileSuppressions).toEqual({});
        });

        test('cleanupObsoleteSettings drops unknown keys and empty override containers', () => {
            seed({
                boostConfig: { x: 1 },
                challengeSettings: {
                    globalDefaults: { exposure: 70, bogus: 1 },
                    perChallenge: { c1: { bogus: 1 }, c2: { exposure: 60, junk: 2 }, c3: {} },
                },
            });
            settings.cleanupObsoleteSettings();
            const out = saved();
            expect(out.challengeSettings.globalDefaults).toEqual({ exposure: 70 });
            expect(out.challengeSettings.perChallenge).toEqual({ c2: { exposure: 60 } });
            expect(out).not.toHaveProperty('boostConfig');
        });

        test('cleanupObsoleteSettings leaves a clean or container-less blob alone', () => {
            seed({ challengeSettings: null });
            settings.cleanupObsoleteSettings();
            seed({ challengeSettings: { globalDefaults: null, perChallenge: null } });
            settings.cleanupObsoleteSettings();
            seed({ challengeSettings: { globalDefaults: { exposure: 70 }, perChallenge: { c1: { exposure: 60 } } } });
            settings.cleanupObsoleteSettings();
            expect(store.write).not.toHaveBeenCalled();
        });

        test('load-time cleanup runs once per process on the first load', () => {
            jest.isolateModules(() => {
                const fresh = require('../../src/js/settings');
                store.value = JSON.stringify({ challengeSettings: { globalDefaults: { exposure: 70, bogus: 1 } } });
                fresh.loadSettings();
                expect(saved().challengeSettings.globalDefaults).toEqual({ exposure: 70 });
                // Second load in the same process: cleanup already ran, so the
                // unknown key is no longer stripped.
                store.value = JSON.stringify({ challengeSettings: { globalDefaults: { exposure: 70, bogus: 1 } } });
                expect(fresh.loadSettings().challengeSettings.globalDefaults.bogus).toBe(1);
            });
        });
    });

    describe('reset / modified helpers', () => {
        test('resetSetting restores a top-level default and rejects unknown keys', () => {
            seed({ theme: 'weird-theme' });
            expect(settings.isSettingModified('theme')).toBe(true);
            expect(settings.resetSetting('theme')).toBe(true);
            expect(saved().theme).toBe(settings.getDefaultSettings().theme);
            expect(settings.isSettingModified('theme')).toBe(false);

            expect(settings.resetSetting('noSuchKey')).toBe(false);
            expect(settings.isSettingModified('noSuchKey')).toBe(false);
        });

        test('resetAllSettings keeps token/mock/apiHeaders and resets everything else', () => {
            seed({ token: 'tok', mock: true, apiHeaders: { a: 1 }, theme: 'weird-theme' });
            expect(settings.resetAllSettings()).toBe(true);
            const out = saved();
            expect(out.token).toBe('tok');
            expect(out.mock).toBe(true);
            expect(out.apiHeaders).toEqual({ a: 1 });
            expect(out.theme).toBe(settings.getDefaultSettings().theme);
        });
    });

    describe('guards on hand-edited or unusual input', () => {
        test('a global-only key inside a stored override is ignored when composing a title profile', () => {
            seed({
                challengeSettings: {
                    globalDefaults: {},
                    profiles: { P: { exposure: 70 } },
                    titlePins: { c1: 'Alpha' },
                    perChallenge: { c1: { lastMinuteCheckFrequency: 'junk' } },
                },
            });
            expect(settings.setTitleRules([{ title: 'Alpha', profile: 'P' }])).toBe(true);
        });

        test('a null challenge id never inherits a title profile through a pin keyed "null"', () => {
            seed({
                challengeSettings: {
                    globalDefaults: {},
                    profiles: { P: { exposure: 70 } },
                    titlePins: { null: 'Alpha' },
                    titleRules: [{ title: 'Alpha', profile: 'P' }],
                },
            });
            settings.rememberChallengeTitles([{ id: 'null', title: 'Alpha', tags: ['x'] }]);
            // 70 differs from the (un-inherited) global 100, so it is stored rather
            // than cleared as "equal to the inherited profile value".
            expect(settings.setChallengeOverride('exposure', null, 70)).toBe(true);
            expect(saved().challengeSettings.perChallenge.null).toEqual({ exposure: 70 });
        });
    });

    describe('persistence failures (fs transport)', () => {
        let fs;
        // A blob that already went through the load-time migrations, so a
        // re-load performs no write of its own.
        const migratedBlob = (obj) => {
            seed(obj);
            return store.value;
        };
        const useFailingDisk = (blob) => {
            fs = require('node:fs');
            delete globalThis.__GS_HEADLESS__;
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(blob);
            fs.writeFileSync.mockImplementation(() => {
                throw new Error('EROFS');
            });
        };

        afterEach(() => {
            fs.existsSync.mockReset();
            fs.readFileSync.mockReset();
            fs.writeFileSync.mockReset();
        });

        test('cleanupObsoleteSettings logs a failed write instead of throwing', () => {
            useFailingDisk(migratedBlob({ challengeSettings: { globalDefaults: { exposure: 70, bogus: 1 } } }));
            expect(() => settings.cleanupObsoleteSettings()).not.toThrow();
            expect(fs.writeFileSync).toHaveBeenCalled();
            expect(cat.error).toHaveBeenCalledWith('Error during settings cleanup:', expect.any(Error));
        });

        test('resetAllSettings reports a failed save and skips the follow-up cleanup', () => {
            useFailingDisk(migratedBlob({ challengeSettings: { globalDefaults: {} } }));
            expect(settings.resetAllSettings()).toBe(false);
            expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
        });

        test('seedIntentProfiles survives a null challengeSettings when every write fails', () => {
            const blob = migratedBlob({ challengeSettings: null });
            expect(JSON.parse(blob).challengeSettings).toBeNull();
            useFailingDisk(blob);
            expect(settings.seedIntentProfiles()).toBe(false);
            expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining('Skipped seeding intent profile'));
        });
    });
});
