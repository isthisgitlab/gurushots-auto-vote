/**
 * Named challenge-settings profiles on the settings facade.
 *
 * Profiles are name-keyed presets of sparse per-challenge overrides — they
 * survive challenge rotation (unlike id-keyed overrides). Covers:
 *   - saveChallengeProfile / getChallengeProfiles round-trip + sanitization
 *     (whitelist, fail-closed validation, caps, reserved prototype names,
 *     case-insensitive name identity)
 *   - deleteChallengeProfile
 *   - getChallengeOverrides batch reader
 *   - applyChallengeProfile atomic replace semantics (incl. the stale
 *     conflicting-override case the set-then-remove design would break on).
 *
 * Drives the in-memory headless-store seam (same one title-tag-rules.test.js
 * uses) so the facade's loadSettings/saveSettings round-trip without touching fs.
 */

const settings = require('../../src/js/settings');
const logger = require('../../src/js/logger');

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

describe('settings facade — challenge profiles', () => {
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

    describe('saveChallengeProfile / getChallengeProfiles', () => {
        test('defaults to an empty map', () => {
            expect(settings.getChallengeProfiles()).toEqual({});
        });

        test('round-trips a saved profile', () => {
            expect(settings.saveChallengeProfile('2-pic tactic', { exposure: 80, autoFill: true })).toBe(true);
            expect(settings.getChallengeProfiles()).toEqual({
                '2-pic tactic': { exposure: 80, autoFill: true },
            });
        });

        test('trims the name and allows an empty values map', () => {
            expect(settings.saveChallengeProfile('  Reset Preset  ', {})).toBe(true);
            expect(settings.getChallengeProfiles()).toEqual({ 'Reset Preset': {} });
        });

        test('overwrites case-insensitively, latest casing wins', () => {
            settings.saveChallengeProfile('Tactic', { exposure: 70 });
            settings.saveChallengeProfile('tactic', { exposure: 90 });
            expect(settings.getChallengeProfiles()).toEqual({ tactic: { exposure: 90 } });
        });

        test('rejects an empty or non-string name', () => {
            expect(settings.saveChallengeProfile('   ', {})).toBe(false);
            expect(settings.saveChallengeProfile(null, {})).toBe(false);
            expect(settings.saveChallengeProfile(42, {})).toBe(false);
        });

        test('rejects a name over the length cap', () => {
            const longName = 'x'.repeat(settings.MAX_PROFILE_NAME_LENGTH + 1);
            expect(settings.saveChallengeProfile(longName, {})).toBe(false);
            expect(settings.saveChallengeProfile('x'.repeat(settings.MAX_PROFILE_NAME_LENGTH), {})).toBe(true);
        });

        test('rejects reserved prototype-shaped names', () => {
            for (const name of ['__proto__', 'constructor', 'prototype', ' __PROTO__ ']) {
                expect(settings.saveChallengeProfile(name, { exposure: 80 })).toBe(false);
            }
            expect(settings.getChallengeProfiles()).toEqual({});
        });

        test('getChallengeProfiles never surfaces prototype members', () => {
            const profiles = settings.getChallengeProfiles();
            expect(Object.keys(profiles)).toEqual([]);
            // A prototype member reachable via [] would be a pollution vector.
            expect(Object.prototype.hasOwnProperty.call(profiles, 'toString')).toBe(false);
        });

        test('enforces the profile-count cap for new names only', () => {
            for (let i = 0; i < settings.MAX_CHALLENGE_PROFILES; i++) {
                expect(settings.saveChallengeProfile(`profile-${i}`, {})).toBe(true);
            }
            expect(settings.saveChallengeProfile('one-too-many', {})).toBe(false);
            // Overwriting an existing name at the cap still succeeds.
            expect(settings.saveChallengeProfile('profile-0', { exposure: 55 })).toBe(true);
            expect(settings.getChallengeProfiles()['profile-0']).toEqual({ exposure: 55 });
        });

        test('rejects non-plain-object values payloads', () => {
            expect(settings.saveChallengeProfile('p', null)).toBe(false);
            expect(settings.saveChallengeProfile('p', [1, 2])).toBe(false);
            expect(settings.saveChallengeProfile('p', 'exposure=80')).toBe(false);
        });

        test('drops keys that are not perChallenge in the schema', () => {
            expect(
                settings.saveChallengeProfile('p', {
                    exposure: 80,
                    theme: 'dark', // top-level setting, not perChallenge
                    totallyUnknownKey: 123,
                    lastMinuteCheckFrequency: 5, // schema key with perChallenge: false
                }),
            ).toBe(true);
            expect(settings.getChallengeProfiles()).toEqual({ p: { exposure: 80 } });
        });

        test('fails closed on an invalid value', () => {
            expect(settings.saveChallengeProfile('p', { exposure: 999 })).toBe(false);
            expect(settings.getChallengeProfiles()).toEqual({});
        });

        test('fails closed on a cross-field violation (exposureTarget < exposure)', () => {
            expect(settings.saveChallengeProfile('p', { exposure: 90, exposureTarget: 50 })).toBe(false);
            // The same pair in a satisfying order is accepted.
            expect(settings.saveChallengeProfile('p', { exposure: 60, exposureTarget: 80 })).toBe(true);
        });

        test('strips a hand-injected stale key from the read view without rewriting storage', () => {
            settings.saveChallengeProfile('p', { exposure: 80 });
            const raw = settings.loadSettings();
            raw.challengeSettings.profiles.p.removedLegacyKey = 'stale';
            settings.saveSettings(raw);

            expect(settings.getChallengeProfiles()).toEqual({ p: { exposure: 80 } });
            // Storage still carries the stale key — reads never rewrite.
            expect(settings.loadSettings().challengeSettings.profiles.p.removedLegacyKey).toBe('stale');
        });
    });

    describe('deleteChallengeProfile', () => {
        test('deletes by case-insensitive name match', () => {
            settings.saveChallengeProfile('My Tactic', { exposure: 80 });
            expect(settings.deleteChallengeProfile('my tactic')).toBe(true);
            expect(settings.getChallengeProfiles()).toEqual({});
        });

        test('returns false when no such profile exists', () => {
            expect(settings.deleteChallengeProfile('ghost')).toBe(false);
            expect(settings.deleteChallengeProfile('__proto__')).toBe(false);
        });
    });

    describe('getChallengeOverrides', () => {
        test('returns an empty map for a challenge without overrides', () => {
            expect(settings.getChallengeOverrides('123')).toEqual({});
        });

        test('returns the sparse override map', () => {
            settings.setChallengeOverride('exposure', '123', 80);
            settings.setChallengeOverride('autoFill', '123', true);
            expect(settings.getChallengeOverrides('123')).toEqual({ exposure: 80, autoFill: true });
            expect(settings.getChallengeOverrides('456')).toEqual({});
        });
    });

    describe('applyChallengeProfile', () => {
        test('requires a challenge id and an existing profile', () => {
            settings.saveChallengeProfile('p', { exposure: 80 });
            expect(settings.applyChallengeProfile('p', '')).toBe(false);
            expect(settings.applyChallengeProfile('p', null)).toBe(false);
            expect(settings.applyChallengeProfile('ghost', '123')).toBe(false);
        });

        test('sets listed keys and removes unlisted ones atomically', () => {
            settings.setChallengeOverride('autoFill', '123', true);
            settings.setChallengeOverride('boostTime', '123', 1800);
            settings.saveChallengeProfile('p', { exposure: 80 });

            expect(settings.applyChallengeProfile('p', '123')).toBe(true);
            expect(settings.getChallengeOverrides('123')).toEqual({ exposure: 80 });
        });

        test('succeeds when a stale override on an unlisted key conflicts with a profile value', () => {
            // Ordering case: profile saved under global
            // defaults (exposure=100 → exposureTarget=80 would be invalid, so
            // lower the default first).
            settings.setGlobalDefault('exposure', 50);
            settings.saveChallengeProfile('p', { exposureTarget: 80 });

            // Later the challenge picks up a stale exposure=95 override; a
            // set-then-remove apply would validate 80 >= 95 and silently drop
            // exposureTarget. The atomic replace must not.
            settings.setChallengeOverride('exposure', '123', 95);

            expect(settings.applyChallengeProfile('p', '123')).toBe(true);
            expect(settings.getChallengeOverrides('123')).toEqual({ exposureTarget: 80 });
            expect(settings.getEffectiveSetting('exposure', '123')).toBe(50);
        });

        test('removes an array-valued override the profile does not list', () => {
            // Array defaults never match the reference-equality clear check in
            // _applyChallengeOverride — the wholesale replace must drop them anyway.
            settings.setChallengeOverride('mustIncludeTags', '123', ['hat']);
            settings.saveChallengeProfile('p', { exposure: 80 });

            expect(settings.applyChallengeProfile('p', '123')).toBe(true);
            expect(settings.getChallengeOverrides('123')).toEqual({ exposure: 80 });
            expect(settings.getEffectiveSetting('mustIncludeTags', '123')).toEqual([]);
        });

        test('an empty profile clears all overrides', () => {
            settings.setChallengeOverride('exposure', '123', 80);
            settings.saveChallengeProfile('reset', {});

            expect(settings.applyChallengeProfile('reset', '123')).toBe(true);
            expect(settings.getChallengeOverrides('123')).toEqual({});
            expect(settings.loadSettings().challengeSettings.perChallenge['123']).toBeUndefined();
        });

        test('prunes profile values equal to the current global default', () => {
            settings.saveChallengeProfile('p', { exposure: 80 });
            settings.setGlobalDefault('exposure', 80);

            expect(settings.applyChallengeProfile('p', '123')).toBe(true);
            // exposure=80 equals the global default — stored as no override.
            expect(settings.getChallengeOverrides('123')).toEqual({});
            expect(settings.getEffectiveSetting('exposure', '123')).toBe(80);
        });

        test('scheduled-fill keys ride along automatically (dynamic perChallenge whitelist)', () => {
            expect(
                settings.saveChallengeProfile('night tactic', {
                    useScheduledFill: true,
                    scheduledFillTime: ['21:30', '09:00'],
                    scheduledFillBeforeEnd: [14400, 36000],
                    scheduledFillReplaces: true,
                }),
            ).toBe(true);

            expect(settings.applyChallengeProfile('night tactic', '123')).toBe(true);
            // The load-time bounds pass canonical-sorts lists (order carries
            // no meaning), so the round-tripped arrays come back sorted.
            expect(settings.getChallengeOverrides('123')).toEqual({
                useScheduledFill: true,
                scheduledFillTime: ['09:00', '21:30'],
                scheduledFillBeforeEnd: [14400, 36000],
                scheduledFillReplaces: true,
            });
            expect(settings.getEffectiveSetting('scheduledFillTime', '123')).toEqual(['09:00', '21:30']);
        });

        test('rejects a profile carrying an invalid scheduledFillTime fail-closed', () => {
            // The zod validator runs through the same validateSetting path as
            // direct per-challenge writes — an invalid value must abort the
            // whole save/apply, not slip through the profile side door.
            expect(settings.saveChallengeProfile('bad', { scheduledFillTime: ['25:99'] })).toBe(false);
            expect(settings.saveChallengeProfile('bad', { scheduledFillTime: [2130] })).toBe(false);
            expect(settings.saveChallengeProfile('bad', { scheduledFillTime: '21:30' })).toBe(false); // non-array

            // And a profile corrupted in place after saving is rejected at apply.
            settings.saveChallengeProfile('was-fine', { scheduledFillTime: ['21:30'] });
            const raw = settings.loadSettings();
            raw.challengeSettings.profiles['was-fine'].scheduledFillTime = ['25:99'];
            settings.saveSettings(raw);
            expect(settings.applyChallengeProfile('was-fine', '123')).toBe(false);
            expect(settings.getChallengeOverrides('123')).toEqual({});
        });

        test('writes nothing when a stored value has become invalid (schema drift)', () => {
            settings.setChallengeOverride('autoFill', '123', true);
            settings.saveChallengeProfile('p', { exposure: 80 });
            const raw = settings.loadSettings();
            raw.challengeSettings.profiles.p.exposure = 999; // corrupt in place
            settings.saveSettings(raw);

            expect(settings.applyChallengeProfile('p', '123')).toBe(false);
            // Pre-existing override untouched — no partial write.
            expect(settings.getChallengeOverrides('123')).toEqual({ autoFill: true });
        });
    });

    describe('automatic title profile inheritance', () => {
        beforeEach(() => {
            settings.saveChallengeProfile('Recurring Tactic', { exposure: 80, autoFill: true });
            settings.setTitleRules([
                {
                    title: 'Weekly Theme',
                    profile: 'Recurring Tactic',
                    mustIncludeTags: [],
                    shouldIncludeTags: [],
                },
            ]);
        });

        test('inherits profile values for the current id and a rotated id with the same title', () => {
            settings.rememberChallengeTitles([{ id: 100, title: 'Weekly Theme' }]);
            expect(settings.getEffectiveSetting('exposure', '100')).toBe(80);
            expect(settings.getEffectiveSetting('autoFill', '100')).toBe(true);

            settings.rememberChallengeTitles([{ id: 999, title: 'weekly theme' }]);
            expect(settings.getEffectiveSetting('exposure', '999')).toBe(80);
        });

        test('keeps manual per-challenge overrides above the automatic profile', () => {
            settings.rememberChallengeTitles([{ id: 100, title: 'Weekly Theme' }]);
            expect(settings.setChallengeOverride('exposure', '100', 65)).toBe(true);
            expect(settings.getEffectiveSetting('exposure', '100')).toBe(65);
            expect(settings.getEffectiveSetting('autoFill', '100')).toBe(true);
        });

        test('clears a redundant manual value against the profile baseline, not the global default', () => {
            settings.rememberChallengeTitles([{ id: 100, title: 'Weekly Theme' }]);
            settings.setChallengeOverride('exposure', '100', 65);

            expect(settings.setChallengeOverride('exposure', '100', 80)).toBe(true);
            expect(settings.getChallengeOverrides('100')).toEqual({});
            expect(settings.getEffectiveSetting('exposure', '100')).toBe(80);
        });

        test('validates a manual override against the inherited profile as a complete setting set', () => {
            settings.saveChallengeProfile('Strict', { exposure: 90, exposureTarget: 100 });
            settings.setTitleRules([
                { title: 'Strict Theme', profile: 'Strict', mustIncludeTags: [], shouldIncludeTags: [] },
            ]);
            settings.rememberChallengeTitles([{ id: 123, title: 'Strict Theme' }]);

            expect(settings.setChallengeOverride('exposureTarget', '123', 80)).toBe(false);
            expect(settings.getChallengeOverrides('123')).toEqual({});
            expect(settings.getEffectiveSetting('exposureTarget', '123')).toBe(100);
        });

        test('rejects a trigger override that would invalidate the inherited profile target', () => {
            settings.saveChallengeProfile('Strict', { exposure: 50, exposureTarget: 80 });
            settings.setTitleRules([
                { title: 'Strict Theme', profile: 'Strict', mustIncludeTags: [], shouldIncludeTags: [] },
            ]);
            settings.rememberChallengeTitles([{ id: 123, title: 'Strict Theme' }]);

            expect(settings.setChallengeOverride('exposure', '123', 90)).toBe(false);
            expect(settings.getChallengeOverrides('123')).toEqual({});
            expect(settings.getEffectiveSetting('exposure', '123')).toBe(50);
        });

        test('batch override rejects an invalid composition without partially saving sibling values', () => {
            settings.saveChallengeProfile('Strict', { exposure: 50, exposureTarget: 80, autoFill: true });
            settings.setTitleRules([
                { title: 'Strict Theme', profile: 'Strict', mustIncludeTags: [], shouldIncludeTags: [] },
            ]);
            settings.rememberChallengeTitles([{ id: 123, title: 'Strict Theme' }]);

            expect(settings.setChallengeOverrides('123', { exposure: 90, autoFill: false })).toBe(false);
            expect(settings.getChallengeOverrides('123')).toEqual({});
            expect(settings.getEffectiveSetting('autoFill', '123')).toBe(true);
        });

        test('rejects removing an override when the inherited trigger would exceed the remaining target', () => {
            settings.saveChallengeProfile('Strict', { exposure: 90, exposureTarget: 100 });
            settings.setTitleRules([
                { title: 'Strict Theme', profile: 'Strict', mustIncludeTags: [], shouldIncludeTags: [] },
            ]);
            settings.rememberChallengeTitles([{ id: 123, title: 'Strict Theme' }]);
            settings.setChallengeOverride('exposure', '123', 70);
            settings.setChallengeOverride('exposureTarget', '123', 80);

            expect(settings.removeChallengeOverride('exposure', '123')).toBe(false);
            expect(settings.getChallengeOverrides('123')).toEqual({ exposure: 70, exposureTarget: 80 });
        });

        test('manual profile Apply replaces the automatic profile baseline', () => {
            settings.rememberChallengeTitles([{ id: 100, title: 'Weekly Theme' }]);
            settings.saveChallengeProfile('Reset', {});

            expect(settings.applyChallengeProfile('Reset', '100')).toBe(true);
            expect(settings.getChallengeOverrides('100')).toEqual({});
            expect(settings.getEffectiveSetting('autoFill', '100')).toBe(false);
            expect(settings.getTitleProfile('Weekly Theme', '100')).toEqual({
                name: 'Recurring Tactic',
                values: { exposure: 80, autoFill: true },
                suppressed: true,
            });
        });

        test('atomic form save can suppress and later restore automatic inheritance', () => {
            settings.rememberChallengeTitles([{ id: 100, title: 'Weekly Theme' }]);

            expect(settings.replaceChallengeOverrides('100', { exposure: 70 }, true)).toBe(true);
            expect(settings.getEffectiveSetting('exposure', '100')).toBe(70);
            expect(settings.getEffectiveSetting('autoFill', '100')).toBe(false);

            expect(settings.replaceChallengeOverrides('100', {}, false)).toBe(true);
            expect(settings.getEffectiveSetting('exposure', '100')).toBe(80);
            expect(settings.getEffectiveSetting('autoFill', '100')).toBe(true);
        });

        test('rejects an automatic profile assignment that conflicts with existing manual values', () => {
            settings.setGlobalDefault('exposure', 50);
            settings.saveChallengeProfile('Strict', { exposure: 90, exposureTarget: 100 });
            settings.rememberChallengeTitles([{ id: 123, title: 'Strict Theme' }]);
            settings.setChallengeOverride('exposureTarget', '123', 80);

            expect(
                settings.setTitleRules([
                    { title: 'Strict Theme', profile: 'Strict', mustIncludeTags: [], shouldIncludeTags: [] },
                ]),
            ).toBe(false);
            expect(settings.getTitleRules().some((rule) => rule.title === 'Strict Theme')).toBe(false);
            expect(settings.getEffectiveSetting('exposure', '123')).toBe(50);
        });

        test('rejects a sparse profile when it invalidates an inherited dependent value', () => {
            settings.setGlobalDefault('exposure', 50);
            settings.setGlobalDefault('exposureTarget', 80);

            expect(settings.saveChallengeProfile('Too High', { exposure: 90 })).toBe(false);
            expect(settings.getChallengeProfiles()['Too High']).toBeUndefined();
        });

        test('rejects an assigned profile overwrite that would conflict with manual values', () => {
            settings.setGlobalDefault('exposure', 50);
            settings.saveChallengeProfile('Strict', { exposure: 50, exposureTarget: 100 });
            settings.setTitleRules([
                { title: 'Strict Theme', profile: 'Strict', mustIncludeTags: [], shouldIncludeTags: [] },
            ]);
            settings.rememberChallengeTitles([{ id: 123, title: 'Strict Theme' }]);
            settings.setChallengeOverride('exposureTarget', '123', 80);

            expect(settings.saveChallengeProfile('STRICT', { exposure: 90, exposureTarget: 100 })).toBe(false);
            expect(settings.getChallengeProfiles().Strict).toEqual({ exposure: 50, exposureTarget: 100 });
            expect(settings.getEffectiveSetting('exposure', '123')).toBe(50);
        });

        test('fails closed when an assigned profile is corrupt instead of applying a valid subset', () => {
            settings.rememberChallengeTitles([{ id: 100, title: 'Weekly Theme' }]);
            const raw = settings.loadSettings();
            raw.challengeSettings.profiles['Recurring Tactic'].exposure = 'corrupt';
            settings.saveSettings(raw);
            logger.withCategory.mockClear();

            expect(settings.getTitleProfile('Weekly Theme')).toBeNull();
            expect(settings.getEffectiveSetting('autoFill', '100')).toBe(false);
            expect(settings.getEffectiveSetting('exposure', '100')).toBe(100);
            expect(logger.withCategory).not.toHaveBeenCalled();
        });

        test('does not exact-match an over-length observed title to its 200-character prefix', () => {
            const prefix = 'x'.repeat(settings.MAX_TITLE_LENGTH);
            settings.saveChallengeProfile('Long', { autoFill: true });
            settings.setTitleRules([{ title: prefix, profile: 'Long', mustIncludeTags: [], shouldIncludeTags: [] }]);
            settings.rememberChallengeTitles([{ id: 100, title: `${prefix}-different-suffix` }]);

            expect(settings.getTitleProfile(`${prefix}-different-suffix`)).toBeNull();
            expect(settings.getEffectiveSetting('autoFill', '100')).toBe(false);
        });
    });
});
