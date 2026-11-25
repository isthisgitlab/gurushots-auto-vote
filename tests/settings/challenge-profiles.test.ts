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
 * Drives the in-memory headless-store seam (same one title-tag-rules.test.ts
 * uses) so the facade's loadSettings/saveSettings round-trip without touching fs.
 */

import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import type { MemoryStore } from '../helpers/headlessStore';
import settings = require('../../src/ts/core/settings');
import loggerModule = require('../../src/ts/core/logger');
import { isPlainObject } from '../../src/ts/core/plainObject';
import { evaluateVotingDecision } from '../../src/ts/core/services/VotingLogic';
import { buildChallenge } from '../helpers/challengeFixtures';
const logger = jest.mocked(loggerModule);

/** One stored profile of a loaded configuration, to edit it behind the facade's back. */
const profileOf = (config: ReturnType<typeof settings.loadSettings>, name: string): Record<string, unknown> => {
    const profile = config.profiles[name];
    if (!isPlainObject(profile)) throw new Error(`no stored profile ${name}`);
    return profile;
};

jest.mock('../../src/ts/core/logger', () => ({
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
    let store: MemoryStore;

    beforeEach(() => {
        store = installHeadlessStore();
        settings.rememberChallengeTitles([]);
    });

    afterEach(() => {
        removeHeadlessStore();
    });

    describe('saveChallengeProfile / getChallengeProfiles', () => {
        test('defaults to an empty map', () => {
            expect(settings.getChallengeProfiles()).toEqual({});
        });

        test('round-trips a saved profile', () => {
            expect(settings.saveChallengeProfile('2-pic tactic', { exposure: 80, autoSubmit: true })).toBe(true);
            expect(settings.getChallengeProfiles()).toEqual({
                '2-pic tactic': { exposure: 80, autoSubmit: true },
            });
        });

        test('saves a sparse trigger above the inherited target', () => {
            expect(settings.setGlobalDefault('exposure', 70)).toBe(true);
            expect(settings.setGlobalDefault('exposureTarget', 70)).toBe(true);
            expect(settings.saveChallengeProfile('Higher exposure', { exposure: 90 })).toBe(true);
            expect(settings.getChallengeProfiles()['Higher exposure']).toEqual({ exposure: 90 });
            expect(settings.getGlobalDefault('exposureTarget')).toBe(70);
        });

        test('round-trips Auto-Submit clock settings in a profile', () => {
            expect(
                settings.saveChallengeProfile('clocked', {
                    autoSubmitTime: ['08:00', '20:00'],
                    autoSubmitWindowMinutes: 60,
                }),
            ).toBe(true);
            expect(settings.getChallengeProfiles()).toEqual({
                clocked: { autoSubmitTime: ['08:00', '20:00'], autoSubmitWindowMinutes: 60 },
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

        test('keeps the raw profile pair and raises the target when applied', () => {
            expect(settings.saveChallengeProfile('p', { exposure: 90, exposureTarget: 50 })).toBe(true);
            expect(settings.getChallengeProfiles().p).toEqual({ exposure: 90, exposureTarget: 50 });
            expect(settings.applyChallengeProfile('p', '123')).toBe(true);
            expect(settings.getEffectiveSetting('exposure', '123')).toBe(90);
            expect(settings.getEffectiveSetting('exposureTarget', '123')).toBe(90);
        });

        test('strips a hand-injected stale key from the read view without rewriting storage', () => {
            settings.saveChallengeProfile('p', { exposure: 80 });
            const raw = settings.loadSettings();
            profileOf(raw, 'p').removedLegacyKey = 'stale';
            settings.saveSettings(raw);

            expect(settings.getChallengeProfiles()).toEqual({ p: { exposure: 80 } });
            // Storage still carries the stale key — reads never rewrite.
            expect(profileOf(settings.loadSettings(), 'p').removedLegacyKey).toBe('stale');
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
            settings.setChallengeOverride('autoSubmit', '123', true);
            settings.setChallengeOverride('autoSubmitTime', '123', ['08:00']);
            settings.setChallengeOverride('autoSubmitWindowMinutes', '123', 75);
            expect(settings.getChallengeOverrides('123')).toEqual({
                exposure: 80,
                autoSubmit: true,
                autoSubmitTime: ['08:00'],
                autoSubmitWindowMinutes: 75,
            });
            expect(settings.getChallengeOverrides('456')).toEqual({});
        });
    });

    describe('applyChallengeProfile', () => {
        const voteAt = (exposure: number, closeIn: number) => {
            const now = Math.floor(Date.now() / 1000);
            const challenge = buildChallenge({
                id: '123',
                type: 'regular',
                start_time: now - 3600,
                close_time: now + closeIn,
                member: { ranking: { exposure: { exposure_factor: exposure } } },
            });
            return evaluateVotingDecision(challenge, now);
        };

        test('voting uses the resolved trigger for eligibility and the target for its ceiling', () => {
            expect(settings.setGlobalDefault('exposure', 70)).toBe(true);
            expect(settings.setGlobalDefault('exposureTarget', 95)).toBe(true);
            expect(settings.saveChallengeProfile('Normal', { exposure: 80 })).toBe(true);
            expect(settings.applyChallengeProfile('Normal', '123')).toBe(true);
            expect(voteAt(79, 7200)).toMatchObject({ shouldVote: true, targetExposure: 95 });
            expect(voteAt(80, 7200).shouldVote).toBe(false);

            expect(
                settings.setChallengeOverrides('123', {
                    finalWindowExposure: 65,
                    finalWindowExposureTarget: 50,
                }),
            ).toBe(true);
            expect(settings.getChallengeOverrides('123')).toMatchObject({
                finalWindowExposure: 65,
                finalWindowExposureTarget: 50,
            });
            expect(voteAt(79, 1800)).toMatchObject({ shouldVote: true, targetExposure: 95 });
            expect(settings.setChallengeOverride('useFinalWindowExposure', '123', true)).toBe(true);
            expect(voteAt(64, 1800)).toMatchObject({ shouldVote: true, targetExposure: 65 });
            expect(voteAt(65, 1800).shouldVote).toBe(false);
        });

        test('zero targets remain stored on the profile and follow each trigger in voting', () => {
            expect(
                settings.saveChallengeProfile('Follow', {
                    exposure: 85,
                    exposureTarget: 0,
                    useFinalWindowExposure: true,
                    finalWindowExposure: 60,
                    finalWindowExposureTarget: 0,
                }),
            ).toBe(true);
            expect(settings.getChallengeProfiles().Follow).toMatchObject({
                exposureTarget: 0,
                finalWindowExposureTarget: 0,
            });
            expect(settings.applyChallengeProfile('Follow', '123')).toBe(true);
            expect(voteAt(40, 7200).targetExposure).toBe(85);
            expect(voteAt(40, 1800).targetExposure).toBe(60);
        });

        test('applies a stored profile after the inherited target falls below its trigger', () => {
            expect(settings.setGlobalDefault('exposure', 70)).toBe(true);
            expect(settings.setGlobalDefault('exposureTarget', 95)).toBe(true);
            expect(settings.saveChallengeProfile('Higher exposure', { exposure: 90 })).toBe(true);
            expect(settings.setGlobalDefault('exposureTarget', 70)).toBe(true);

            expect(settings.applyChallengeProfile('Higher exposure', '123')).toBe(true);
            expect(settings.getEffectiveSetting('exposure', '123')).toBe(90);
            expect(settings.getEffectiveSetting('exposureTarget', '123')).toBe(90);
            expect(settings.getChallengeOverrides('123')).toEqual({ exposure: 90 });
            expect(settings.getChallengeProfiles()['Higher exposure']).toEqual({ exposure: 90 });
            expect(settings.getGlobalDefault('exposureTarget')).toBe(70);
        });

        test('saves a challenge draft with a trigger above the inherited target', () => {
            expect(settings.setGlobalDefault('exposure', 70)).toBe(true);
            expect(settings.setGlobalDefault('exposureTarget', 70)).toBe(true);

            expect(settings.replaceChallengeOverrides('123', { exposure: 90 }, true)).toBe(true);
            expect(settings.getEffectiveSetting('exposure', '123')).toBe(90);
            expect(settings.getEffectiveSetting('exposureTarget', '123')).toBe(90);
            expect(settings.getChallengeOverrides('123')).toEqual({ exposure: 90 });
            expect(settings.getGlobalDefault('exposureTarget')).toBe(70);
            expect(settings.setChallengeOverride('exposureTarget', '123', -1)).toBe(false);
            expect(settings.getChallengeOverrides('123')).toEqual({ exposure: 90 });
        });

        test('a higher-priority final-window trigger raises inherited normal exposure and both targets', () => {
            expect(settings.setGlobalDefault('exposure', 70)).toBe(true);
            expect(settings.setGlobalDefault('exposureTarget', 75)).toBe(true);
            expect(settings.setGlobalDefault('finalWindowExposure', 40)).toBe(true);
            expect(settings.setGlobalDefault('finalWindowExposureTarget', 60)).toBe(true);
            expect(
                settings.saveChallengeProfile('High final window', {
                    useFinalWindowExposure: true,
                    finalWindowExposure: 90,
                }),
            ).toBe(true);
            expect(settings.applyChallengeProfile('High final window', '123')).toBe(true);
            for (const key of ['exposure', 'exposureTarget', 'finalWindowExposure', 'finalWindowExposureTarget']) {
                expect(settings.getEffectiveSetting(key, '123')).toBe(90);
            }
        });

        test('requires a challenge id and an existing profile', () => {
            settings.saveChallengeProfile('p', { exposure: 80 });
            expect(settings.applyChallengeProfile('p', '')).toBe(false);
            expect(settings.applyChallengeProfile('p', null)).toBe(false);
            expect(settings.applyChallengeProfile('ghost', '123')).toBe(false);
        });

        test('persists nothing when the challenge layer refuses the replace (the safety net after sanitizing)', () => {
            settings.saveChallengeProfile('p', { exposure: 80 });
            const before = store.value;
            let isolated: typeof settings | undefined;
            jest.isolateModules(() => {
                jest.doMock('../../src/ts/core/settings/challengeOverrides', () => ({
                    ...jest.requireActual<typeof import('../../src/ts/core/settings/challengeOverrides')>(
                        '../../src/ts/core/settings/challengeOverrides',
                    ),
                    replaceChallengeOverridesInSettings: () => false,
                }));
                isolated = require('../../src/ts/core/settings') as typeof settings;
            });
            jest.dontMock('../../src/ts/core/settings/challengeOverrides');
            // The first load of a fresh module graph runs its once-per-process cleanup: let it, then count writes.
            isolated!.loadSettings();
            const settled = store.value;
            store.write.mockClear();

            expect(isolated!.applyChallengeProfile('p', '123')).toBe(false);

            expect(store.write).not.toHaveBeenCalled();
            expect(store.value).toBe(settled);
            expect(before).not.toBeNull();
        });

        test('sets listed keys and removes unlisted ones atomically', () => {
            settings.setChallengeOverride('autoSubmit', '123', true);
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
            // Applying a profile stands it in for the rule's: the challenge keeps that, and no values of its own.
            expect(settings.loadSettings().challenges['123']).toEqual({ suppressRuleProfile: true });
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
            // Order carries no meaning, and nothing re-sorts the lists: they come back as saved.
            expect(settings.getChallengeOverrides('123')).toEqual({
                useScheduledFill: true,
                scheduledFillTime: ['21:30', '09:00'],
                scheduledFillBeforeEnd: [14400, 36000],
                scheduledFillReplaces: true,
            });
            expect(settings.getEffectiveSetting('scheduledFillTime', '123')).toEqual(['21:30', '09:00']);
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
            profileOf(raw, 'was-fine').scheduledFillTime = ['25:99'];
            settings.saveSettings(raw);
            expect(settings.applyChallengeProfile('was-fine', '123')).toBe(false);
            expect(settings.getChallengeOverrides('123')).toEqual({});
        });

        test('writes nothing when a stored value has become invalid (schema drift)', () => {
            settings.setChallengeOverride('autoSubmit', '123', true);
            settings.saveChallengeProfile('p', { exposure: 80 });
            const raw = settings.loadSettings();
            profileOf(raw, 'p').exposure = 999; // corrupt in place
            settings.saveSettings(raw);

            expect(settings.applyChallengeProfile('p', '123')).toBe(false);
            // Pre-existing override untouched — no partial write.
            expect(settings.getChallengeOverrides('123')).toEqual({ autoSubmit: true });
        });
    });

    describe('automatic title profile inheritance', () => {
        beforeEach(() => {
            settings.saveChallengeProfile('Recurring Tactic', { exposure: 80, autoSubmit: true });
            settings.setTitleRules([
                {
                    title: 'Weekly Theme',
                    profile: 'Recurring Tactic',
                    mustIncludeTags: [],
                    shouldIncludeTags: [],
                },
            ]);
        });

        test('a challenge can enable final-window adjustment over an explicitly disabled title profile', () => {
            const profile = {
                exposure: 80,
                useFinalWindowExposure: false,
                finalWindowExposure: 70,
                finalWindowExposureTarget: 60,
            };
            expect(settings.saveChallengeProfile('Final Window Off', profile)).toBe(true);
            expect(settings.setTitleRules([{ title: 'A Window', profile: 'Final Window Off' }])).toBe(true);
            settings.rememberChallengeTitles([{ id: 123, title: 'A Window' }]);
            expect(settings.getEffectiveSetting('useFinalWindowExposure', '123')).toBe(false);
            expect(settings.getEffectiveSetting('finalWindowExposureTarget', '123')).toBe(60);

            expect(settings.setChallengeOverride('useFinalWindowExposure', '123', true)).toBe(true);
            expect(settings.getEffectiveSetting('useFinalWindowExposure', '123')).toBe(true);
            expect(settings.getEffectiveSetting('finalWindowExposureTarget', '123')).toBe(70);
            expect(settings.getChallengeProfiles()['Final Window Off']).toEqual(profile);
        });

        test('inherits profile values for the current id and a rotated id with the same title', () => {
            settings.rememberChallengeTitles([{ id: 100, title: 'Weekly Theme' }]);
            expect(settings.getEffectiveSetting('exposure', '100')).toBe(80);
            expect(settings.getEffectiveSetting('autoSubmit', '100')).toBe(true);

            settings.rememberChallengeTitles([{ id: 999, title: 'weekly theme' }]);
            expect(settings.getEffectiveSetting('exposure', '999')).toBe(80);
        });

        test('keeps manual per-challenge overrides above the automatic profile', () => {
            settings.rememberChallengeTitles([{ id: 100, title: 'Weekly Theme' }]);
            expect(settings.setChallengeOverride('exposure', '100', 65)).toBe(true);
            expect(settings.getEffectiveSetting('exposure', '100')).toBe(65);
            expect(settings.getEffectiveSetting('autoSubmit', '100')).toBe(true);
        });

        test('clears a redundant manual value against the profile baseline, not the global default', () => {
            settings.rememberChallengeTitles([{ id: 100, title: 'Weekly Theme' }]);
            settings.setChallengeOverride('exposure', '100', 65);

            expect(settings.setChallengeOverride('exposure', '100', 80)).toBe(true);
            expect(settings.getChallengeOverrides('100')).toEqual({});
            expect(settings.getEffectiveSetting('exposure', '100')).toBe(80);
        });

        test('preserves a manual target and lowers the inherited profile trigger', () => {
            settings.saveChallengeProfile('Strict', { exposure: 90, exposureTarget: 100 });
            settings.setTitleRules([
                { title: 'Strict Theme', profile: 'Strict', mustIncludeTags: [], shouldIncludeTags: [] },
            ]);
            settings.rememberChallengeTitles([{ id: 123, title: 'Strict Theme' }]);

            expect(settings.setChallengeOverride('exposureTarget', '123', 80)).toBe(true);
            expect(settings.getChallengeOverrides('123')).toEqual({ exposureTarget: 80 });
            expect(settings.getEffectiveSetting('exposureTarget', '123')).toBe(80);
            expect(settings.getEffectiveSetting('exposure', '123')).toBe(80);
        });

        test('an explicit target equal to the global target still outranks the title profile', () => {
            expect(settings.setGlobalDefault('exposure', 70)).toBe(true);
            expect(settings.setGlobalDefault('exposureTarget', 80)).toBe(true);
            expect(settings.saveChallengeProfile('High', { exposure: 90 })).toBe(true);
            expect(settings.saveChallengeProfile('Later', { exposureTarget: 95 })).toBe(true);
            expect(
                settings.setTitleRules([
                    { title: 'Strict Theme', profile: 'High' },
                    { title: 'Strict', match: 'starts', profile: 'Later' },
                ]),
            ).toBe(true);
            settings.rememberChallengeTitles([{ id: 123, title: 'Strict Theme' }]);
            expect(settings.getEffectiveSetting('exposureTarget', '123')).toBe(90);
            expect(settings.setChallengeOverride('exposureTarget', '123', 80)).toBe(true);
            expect(settings.getChallengeOverrides('123')).toEqual({ exposureTarget: 80 });
            expect(settings.getEffectiveSetting('exposure', '123')).toBe(80);
        });

        test('preserves a manual trigger and raises the inherited profile target', () => {
            settings.saveChallengeProfile('Strict', { exposure: 50, exposureTarget: 80 });
            settings.setTitleRules([
                { title: 'Strict Theme', profile: 'Strict', mustIncludeTags: [], shouldIncludeTags: [] },
            ]);
            settings.rememberChallengeTitles([{ id: 123, title: 'Strict Theme' }]);

            expect(settings.setChallengeOverride('exposure', '123', 90)).toBe(true);
            expect(settings.getChallengeOverrides('123')).toEqual({ exposure: 90 });
            expect(settings.getEffectiveSetting('exposure', '123')).toBe(90);
            expect(settings.getEffectiveSetting('exposureTarget', '123')).toBe(90);
        });

        test('batch override rejects an out-of-range field without partially saving sibling values', () => {
            settings.saveChallengeProfile('Strict', { exposure: 50, exposureTarget: 80, autoSubmit: true });
            settings.setTitleRules([
                { title: 'Strict Theme', profile: 'Strict', mustIncludeTags: [], shouldIncludeTags: [] },
            ]);
            settings.rememberChallengeTitles([{ id: 123, title: 'Strict Theme' }]);

            expect(settings.setChallengeOverrides('123', { exposure: 101, autoSubmit: false })).toBe(false);
            expect(settings.getChallengeOverrides('123')).toEqual({});
            expect(settings.getEffectiveSetting('autoSubmit', '123')).toBe(true);
        });

        test('clears the trigger and resolves the inherited trigger against the remaining target', () => {
            settings.saveChallengeProfile('Strict', { exposure: 90, exposureTarget: 100 });
            settings.setTitleRules([
                { title: 'Strict Theme', profile: 'Strict', mustIncludeTags: [], shouldIncludeTags: [] },
            ]);
            settings.rememberChallengeTitles([{ id: 123, title: 'Strict Theme' }]);
            settings.setChallengeOverride('exposure', '123', 70);
            settings.setChallengeOverride('exposureTarget', '123', 80);

            expect(settings.removeChallengeOverride('exposure', '123')).toBe(true);
            expect(settings.getChallengeOverrides('123')).toEqual({ exposureTarget: 80 });
            expect(settings.getEffectiveSetting('exposure', '123')).toBe(80);
            expect(settings.removeChallengeOverride('exposureTarget', '123')).toBe(true);
            expect(settings.getEffectiveSetting('exposure', '123')).toBe(90);
            expect(settings.getEffectiveSetting('exposureTarget', '123')).toBe(100);
        });

        test('manual profile Apply replaces the automatic profile baseline', () => {
            settings.rememberChallengeTitles([{ id: 100, title: 'Weekly Theme' }]);
            settings.saveChallengeProfile('Reset', {});

            expect(settings.applyChallengeProfile('Reset', '100')).toBe(true);
            expect(settings.getChallengeOverrides('100')).toEqual({});
            expect(settings.getEffectiveSetting('autoSubmit', '100')).toBe(false);
            expect(settings.getTitleProfile('Weekly Theme', '100')).toMatchObject({
                profile: { name: 'Recurring Tactic', values: { exposure: 80, autoSubmit: true } },
                suppressed: true,
            });
        });

        test('atomic form save can suppress and later restore automatic inheritance', () => {
            settings.rememberChallengeTitles([{ id: 100, title: 'Weekly Theme' }]);

            expect(settings.replaceChallengeOverrides('100', { exposure: 70 }, true)).toBe(true);
            expect(settings.getEffectiveSetting('exposure', '100')).toBe(70);
            expect(settings.getEffectiveSetting('autoSubmit', '100')).toBe(false);

            expect(settings.replaceChallengeOverrides('100', {}, false)).toBe(true);
            expect(settings.getEffectiveSetting('exposure', '100')).toBe(80);
            expect(settings.getEffectiveSetting('autoSubmit', '100')).toBe(true);
        });

        test('assigns a profile and preserves higher-priority manual exposure values', () => {
            settings.setGlobalDefault('exposure', 50);
            settings.saveChallengeProfile('Strict', { exposure: 90, exposureTarget: 100 });
            settings.rememberChallengeTitles([{ id: 123, title: 'Strict Theme' }]);
            settings.setChallengeOverride('exposureTarget', '123', 80);

            expect(
                settings.setTitleRules([
                    { title: 'Strict Theme', profile: 'Strict', mustIncludeTags: [], shouldIncludeTags: [] },
                ]),
            ).toBe(true);
            expect(settings.getEffectiveSetting('exposure', '123')).toBe(80);
            expect(settings.getEffectiveSetting('exposureTarget', '123')).toBe(80);
            expect(settings.getChallengeOverrides('123')).toEqual({ exposureTarget: 80 });
            expect(settings.getChallengeProfiles().Strict).toEqual({ exposure: 90, exposureTarget: 100 });
        });

        test('overwrites an assigned profile while preserving higher-priority manual exposure values', () => {
            settings.setGlobalDefault('exposure', 50);
            settings.saveChallengeProfile('Strict', { exposure: 50, exposureTarget: 100 });
            settings.setTitleRules([
                { title: 'Strict Theme', profile: 'Strict', mustIncludeTags: [], shouldIncludeTags: [] },
            ]);
            settings.rememberChallengeTitles([{ id: 123, title: 'Strict Theme' }]);
            settings.setChallengeOverride('exposureTarget', '123', 80);

            expect(settings.saveChallengeProfile('STRICT', { exposure: 90, exposureTarget: 100 })).toBe(true);
            expect(settings.getChallengeProfiles().STRICT).toEqual({ exposure: 90, exposureTarget: 100 });
            expect(settings.getChallengeOverrides('123')).toEqual({ exposureTarget: 80 });
            expect(settings.getEffectiveSetting('exposure', '123')).toBe(80);
            expect(settings.getEffectiveSetting('exposureTarget', '123')).toBe(80);
        });

        test('fails closed when an assigned profile is corrupt instead of applying a valid subset', () => {
            settings.rememberChallengeTitles([{ id: 100, title: 'Weekly Theme' }]);
            const raw = settings.loadSettings();
            profileOf(raw, 'Recurring Tactic').exposure = 'corrupt';
            settings.saveSettings(raw);
            logger.withCategory.mockClear();

            expect(settings.getTitleProfile('Weekly Theme').profile).toBeNull();
            expect(settings.getEffectiveSetting('autoSubmit', '100')).toBe(false);
            expect(settings.getEffectiveSetting('exposure', '100')).toBe(100);
            expect(logger.withCategory).not.toHaveBeenCalled();
        });

        test('does not exact-match an over-length observed title to its 200-character prefix', () => {
            const prefix = 'x'.repeat(settings.MAX_TITLE_LENGTH);
            settings.saveChallengeProfile('Long', { autoSubmit: true });
            settings.setTitleRules([{ title: prefix, profile: 'Long', mustIncludeTags: [], shouldIncludeTags: [] }]);
            settings.rememberChallengeTitles([{ id: 100, title: `${prefix}-different-suffix` }]);

            expect(settings.getTitleProfile(`${prefix}-different-suffix`).profile).toBeNull();
            expect(settings.getEffectiveSetting('autoSubmit', '100')).toBe(false);
        });
    });
});

/**
 * Scenario assignments move only at a safe boundary (settings/scenarioLifecycle.ts): a progress record in the middle of a
 * step holds every write that would move the scenario it names, and nothing is written for a refused one.
 */
describe('settings facade — profiles of a scenario assignment', () => {
    let store: MemoryStore;
    const plan = (name: string) => ({
        name,
        version: 1,
        start: 'main',
        phases: { main: { rules: [{ id: 'fill', do: [{ type: 'fillExposure' }] }] } },
    });
    // Challenge 7 runs Plan, with a spend that may have landed.
    const busy = (key = '7') => {
        const { scenarioStateLedger, initialState } =
            require('../../src/ts/core/scenarioStateStore') as typeof import('../../src/ts/core/scenarioStateStore');
        scenarioStateLedger.change(key, () => ({
            ...initialState('Plan', 'main', 1),
            inFlight: { ruleId: 'fill', actionIndex: 0, pending: 'fillExposure' },
        }));
    };
    const idle = () => {
        const { scenarioStateLedger, initialState } =
            require('../../src/ts/core/scenarioStateStore') as typeof import('../../src/ts/core/scenarioStateStore');
        scenarioStateLedger.change('7', () => initialState('Plan', 'main', 1));
    };

    beforeEach(async () => {
        store = installHeadlessStore();
        const storage =
            require('../../src/ts/core/settings/storage') as typeof import('../../src/ts/core/settings/storage');
        await storage.discardPendingWrites();
        storage.resumeWrites();
        settings.rememberChallengeTitles([{ id: 7, title: 'Big show', type: 'exhibition' }]);
        settings.saveScenario(plan('Plan'));
        settings.saveScenario(plan('Next'));
        settings.setChallengeOverride('scenario', '7', 'Plan');
    });

    afterEach(() => {
        removeHeadlessStore();
        settings.rememberChallengeTitles([]);
    });

    test('a profile that holds a scenario cannot move it, or go, while a plan that uses it is in the middle of a step', () => {
        expect(settings.saveChallengeProfile('Tactic', { scenario: 'Plan' })).toBe(true);
        expect(settings.setTitleRules([{ type: 'exhibition', profile: 'Tactic' }])).toBe(true);
        busy();
        const before = store.value;
        expect(settings.saveChallengeProfile('Tactic', { scenario: 'Next' })).toBe(false);
        expect(settings.saveChallengeProfile('Tactic', {})).toBe(false);
        expect(settings.deleteChallengeProfile('Tactic')).toBe(false);
        expect(store.value).toBe(before);
        expect(Object.keys(settings.getChallengeProfiles())).toEqual(['Tactic']);
    });

    test('once the step is over the same writes go through', () => {
        settings.saveChallengeProfile('Tactic', { scenario: 'Plan' });
        idle();
        expect(settings.saveChallengeProfile('Tactic', { scenario: 'Next' })).toBe(true);
        expect(settings.getChallengeProfiles().Tactic).toEqual({ scenario: 'Next' });
        expect(settings.deleteChallengeProfile('Tactic')).toBe(true);
    });

    test('a profile without a scenario is written without the gate, whatever any plan is doing', () => {
        busy();
        expect(settings.saveChallengeProfile('Plain', { autoSubmit: true })).toBe(true);
        expect(settings.saveChallengeProfile('Plain', { autoSubmit: false })).toBe(true);
        expect(settings.deleteChallengeProfile('Plain')).toBe(true);
    });

    test('applying a profile that moves the challenge scenario is held; one that leaves it alone is not', () => {
        settings.saveChallengeProfile('Tactic', { scenario: 'Next' });
        settings.saveChallengeProfile('Same', { scenario: 'Plan', autoSubmit: true });
        settings.saveChallengeProfile('Plain', { autoSubmit: true });
        busy();
        expect(settings.applyChallengeProfile('Tactic', '7')).toBe(false);
        expect(settings.applyChallengeProfile('Plain', '7')).toBe(false);
        expect(settings.getEffectiveSetting('scenario', '7')).toBe('Plan');
        expect(settings.applyChallengeProfile('Same', '7')).toBe(true);
        idle();
        expect(settings.applyChallengeProfile('Tactic', '7')).toBe(true);
        expect(settings.getEffectiveSetting('scenario', '7')).toBe('Next');
    });

    test('a profile that cannot be found, or that fails to sanitize, is as it was', () => {
        busy();
        expect(settings.applyChallengeProfile('Missing', '7')).toBe(false);
        expect(settings.deleteChallengeProfile('Missing')).toBe(false);
        expect(settings.saveChallengeProfile('Bad', { exposure: 'x' })).toBe(false);
    });
});
