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
});
