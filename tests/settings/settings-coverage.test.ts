/**
 * Settings facade edge cases: corrupt persisted configurations (missing or wrong-kind containers), rejection paths of
 * the mutation helpers, reset helpers, title-pin fallbacks and the named-profile guards.
 *
 * Drives the in-memory headless-store seam (tests/helpers/headlessStore.ts) so loadSettings/saveSettings round-trip
 * without touching fs. `seed()` writes a raw persisted configuration (and the title pins, a store of their own);
 * `saved()` reads back what the facade last persisted.
 */

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

import settings = require('../../src/ts/settings');
import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(loggerModule);
import type * as node_fsModule from 'node:fs';
import type { CategoryLogger } from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';
import { isConfig } from '../helpers/storedShapes';
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import { parseJsonAs, parseJsonObject } from '../helpers/parseJson';
import type { MemoryStore } from '../helpers/headlessStore';

const PINS_KEY = 'gs_title_pins';

/** The shared category logger the logger mock above exposes as `__cat`. */
type CatDouble = jest.Mocked<Pick<CategoryLogger, 'info' | 'error' | 'debug' | 'success' | 'warning'>>;

const cat = invalid<typeof logger & { __cat: CatDouble }>(logger).__cat;

describe('settings facade — edge cases', () => {
    let store: MemoryStore;
    // Seed a raw configuration (and the title pins), then let one load run so a test's write assertions only see the
    // call under test.
    const seed = (obj: unknown, pins: Record<string, unknown> = {}) => {
        store.value = JSON.stringify(obj);
        store.keys.set(PINS_KEY, JSON.stringify(pins));
        settings.loadSettings();
        store.write.mockClear();
    };
    const saved = () => parseJsonAs(store.value!, isConfig);
    const savedPins = () => parseJsonObject(store.keys.get(PINS_KEY) ?? '{}');

    beforeEach(() => {
        store = installHeadlessStore();
        settings.rememberChallengeTitles([]);
        jest.clearAllMocks();
    });

    afterAll(() => {
        removeHeadlessStore();
    });

    describe('load / save', () => {
        test('a corrupt configuration in the background service falls back to defaults, is left alone and refuses saves', () => {
            store.value = '{not json';
            const loaded = settings.loadSettings();
            expect(loaded).toEqual(settings.getDefaultSettings());
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('settings-unreadable'));
            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-unreadable',
                path: 'gurushots-config',
            });
            expect(settings.saveAppSettings({ theme: 'dark' })).toBe(false);
            expect(store.value).toBe('{not json');
        });

        test('saveAppSettings reports false instead of throwing on an unserializable value', () => {
            seed({ app: { theme: 'dark' } });
            expect(settings.saveAppSettings({ big: 1n })).toBe(false);
            expect(cat.error).toHaveBeenCalledWith('Error saving settings:', expect.any(TypeError));
            expect(settings.loadSettings().app.theme).toBe('dark');
        });

        test('a non-object stored profile is kept as stored, and read as unusable', () => {
            seed({ profiles: { Broken: 5, Ok: { exposure: 70 } } });
            const loaded = settings.loadSettings();
            expect(loaded.profiles.Broken).toBe(5);
            expect(loaded.profiles.Ok).toEqual({ exposure: 70 });
            expect(settings.getChallengeProfiles()).toEqual({ Broken: {}, Ok: { exposure: 70 } });
        });

        test('getSetting / setSetting round-trip an app key and an auth key', () => {
            seed({});
            expect(settings.setSetting('theme', 'dark')).toBe(true);
            expect(settings.getSetting('theme')).toBe('dark');
            expect(saved().app.theme).toBe('dark');
            expect(settings.setSetting('token', 'tok')).toBe(true);
            expect(settings.getSetting('token')).toBe('tok');
            expect(saved().auth.token).toBe('tok');
        });

        test('setSetting refuses a value its key does not allow, and an auth value that is not a string', () => {
            seed({});
            expect(settings.setSetting('apiTimeout', -1)).toBe(false);
            expect(settings.setSetting('token', 5)).toBe(false);
            expect(settings.setSetting('apiHeaders', { a: 1 })).toBe(false);
            expect(settings.setSetting('apiHeaders', { a: 'b' })).toBe(true);
            expect(store.write).toHaveBeenCalledTimes(1);
            expect(cat.error).toHaveBeenCalledWith('Invalid setting not saved: apiTimeout', null);
        });

        test('saveSettings refuses an auth key that is none, and a version is always 2', () => {
            seed({});
            expect(settings.saveSettings(invalid({ auth: { ...settings.getDefaultSettings().auth, nope: 'x' } }))).toBe(
                false,
            );
            expect(settings.saveSettings({ version: invalid(7) })).toBe(true);
            expect(saved().version).toBe(2);
        });

        test('saveAppSettings merges onto what is stored now', () => {
            seed({ app: { theme: 'dark', language: 'lv' } });
            expect(settings.saveAppSettings({ theme: 'light' })).toBe(true);
            expect(saved().app).toEqual(expect.objectContaining({ theme: 'light', language: 'lv' }));
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
            seed({ app: { windowBounds: null } });
            const bounds = { x: 1, y: 2, width: 300, height: 400 };
            expect(settings.saveWindowBounds('main', bounds)).toBe(true);
            expect(saved().app.windowBounds).toEqual({ main: bounds });
            expect(settings.getWindowBounds('main')).toEqual(bounds);

            // An existing container keeps the other window's bounds.
            const login = { x: 5, y: 6, width: 700, height: 800 };
            expect(settings.saveWindowBounds('login', login)).toBe(true);
            expect(saved().app.windowBounds).toEqual({ main: bounds, login });
        });

        test('getWindowBounds falls back to the default for a missing container or window', () => {
            const defaults = settings.getDefaultSettings().app.windowBounds;
            seed({ app: { windowBounds: null } });
            expect(settings.getWindowBounds('login')).toEqual(defaults.login);
            seed({ app: { windowBounds: { main: { width: 1 } } } });
            expect(settings.getWindowBounds('login')).toEqual(defaults.login);
        });
    });

    describe('global defaults', () => {
        test('getGlobalDefault falls back to the schema default when the container is missing', () => {
            seed({ defaults: null });
            expect(settings.getGlobalDefault('exposure')).toBe(100);
            seed({ defaults: { exposure: 70 } });
            expect(settings.getGlobalDefault('exposure')).toBe(70);
            expect(settings.getGlobalDefault('exposureTarget')).toBe(0);
            expect(settings.getGlobalDefault('noSuchKey')).toBeUndefined();
        });

        test('setGlobalDefault rejects unknown keys and invalid values without writing', () => {
            seed({ defaults: { exposure: 70 } });
            expect(settings.setGlobalDefault('noSuchKey', 1)).toBe(false);
            expect(settings.setGlobalDefault('exposure', 500)).toBe(false);
            // Context validation: target below the stored trigger.
            expect(settings.setGlobalDefault('exposureTarget', 50)).toBe(false);
            expect(store.write).not.toHaveBeenCalled();
            expect(cat.error).toHaveBeenCalledWith('Invalid setting key: noSuchKey', null);
        });

        test('setGlobalDefault saves into a configuration stored without its defaults', () => {
            seed({ defaults: null });
            expect(settings.setGlobalDefault('exposure', 80)).toBe(true);
            expect(saved().defaults.exposure).toBe(80);
            expect(saved().challenges).toEqual({});

            seed({ challenges: {} });
            expect(settings.setGlobalDefault('exposure', 60)).toBe(true);
            expect(saved().defaults.exposure).toBe(60);
        });

        test('resetGlobalDefault restores the schema default and rejects unknown keys', () => {
            seed({ defaults: { exposure: 70 } });
            expect(settings.isGlobalDefaultModified('exposure')).toBe(true);
            expect(settings.resetGlobalDefault('exposure')).toBe(true);
            expect(saved().defaults.exposure).toBe(100);
            expect(settings.isGlobalDefaultModified('exposure')).toBe(false);
            expect(settings.resetGlobalDefault('noSuchKey')).toBe(false);
            expect(settings.isGlobalDefaultModified('noSuchKey')).toBe(false);
        });

        test('resetAllGlobalDefaults clears every stored global default, so each key reads as its schema default', () => {
            seed({ defaults: { exposure: 70, boostTime: 1200 } });
            expect(settings.resetAllGlobalDefaults()).toBe(true);
            expect(saved().defaults).toEqual({});
            for (const key of Object.keys(settings.SETTINGS_SCHEMA)) {
                expect(settings.getGlobalDefault(key)).toEqual(
                    settings.SETTINGS_SCHEMA[key as keyof typeof settings.SETTINGS_SCHEMA].default,
                );
            }
        });

        test('resetAllGlobalDefaults keeps per-challenge overrides', () => {
            seed({ defaults: { exposure: 70 }, challenges: { c1: { values: { exposure: 60 } } } });
            expect(settings.resetAllGlobalDefaults()).toBe(true);
            const config = saved();
            expect(config.defaults.exposure).toBeUndefined();
            expect(config.challenges).toEqual({ c1: { values: { exposure: 60 } } });
        });
    });

    describe('per-challenge overrides', () => {
        test('getChallengeOverride returns null when the challenges are missing', () => {
            seed({ challenges: null });
            expect(settings.getChallengeOverride('exposure', 'c1')).toBeNull();
        });

        test('setChallengeOverride rejects unknown and global-only keys', () => {
            seed({});
            expect(settings.setChallengeOverride('noSuchKey', 'c1', 1)).toBe(false);
            expect(settings.setChallengeOverride('lastMinuteCheckFrequency', 'c1', 2)).toBe(false);
            expect(store.write).not.toHaveBeenCalled();
        });

        test('setChallengeOverride rebuilds missing containers', () => {
            seed({ challenges: null });
            expect(settings.setChallengeOverride('exposure', 'c1', 70)).toBe(true);
            expect(saved().challenges.c1).toEqual({ values: { exposure: 70 } });

            seed({ defaults: {} });
            expect(settings.setChallengeOverride('exposure', 'c2', 60)).toBe(true);
            expect(saved().challenges).toEqual({ c2: { values: { exposure: 60 } } });
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
            seed({ challenges: null });
            expect(settings.setChallengeOverrides(' c1 ', { exposure: 70 })).toBe(true);
            expect(saved().challenges.c1.values).toEqual({ exposure: 70 });

            // exposureTarget must be 0 or >= exposure.
            expect(settings.setChallengeOverrides('c1', { exposureTarget: 50 })).toBe(false);
            expect(saved().challenges.c1.values).toEqual({ exposure: 70 });
        });

        test('removeChallengeOverride is a no-op when there is nothing to remove', () => {
            seed({ challenges: null });
            expect(settings.removeChallengeOverride('exposure', 'c1')).toBe(true);
            seed({ challenges: { c1: { values: { exposure: 70 } } } });
            expect(settings.removeChallengeOverride('exposureTarget', 'c1')).toBe(true);
            expect(store.write).not.toHaveBeenCalled();
        });

        test('removeChallengeOverride refuses a removal that would leave an invalid combination', () => {
            seed({
                defaults: { exposure: 50, exposureTarget: 60 },
                challenges: { c1: { values: { exposure: 40, exposureTarget: 45 } } },
            });
            // Dropping exposure would inherit 50 with the override target 45 < 50.
            expect(settings.removeChallengeOverride('exposure', 'c1')).toBe(false);
            expect(store.write).not.toHaveBeenCalled();
            // Dropping the target inherits 60 >= 40 — fine.
            expect(settings.removeChallengeOverride('exposureTarget', 'c1')).toBe(true);
            expect(saved().challenges.c1.values).toEqual({ exposure: 40 });
        });

        test('getEffectiveSetting guards unknown keys and missing containers', () => {
            seed({ challenges: null });
            expect(settings.getEffectiveSetting('noSuchKey', 'c1')).toBeUndefined();
            expect(settings.getEffectiveSetting('exposure')).toBe(100);
            seed({ challenges: {} });
            expect(settings.getEffectiveSetting('exposure', 'c1')).toBe(100);
        });

        test('getChallengeOverrides filters unknown keys and ignores non-object containers', () => {
            seed({
                challenges: {
                    c1: { values: { exposure: 70, bogus: 1, lastMinuteCheckFrequency: 2 } },
                    c2: { values: [1, 2] },
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
            seed({ challenges: null });
            expect(settings.replaceChallengeOverrides('c1', { exposure: 70, exposureTarget: 0 })).toBe(true);
            expect(saved().challenges.c1).toEqual({ values: { exposure: 70 } });
        });

        test('a record left with nothing in it is dropped, and one that still pins or suppresses is kept', () => {
            seed({
                defaults: {},
                challenges: {
                    a: { values: { exposure: 70 } },
                    b: { values: { exposure: 70 }, pins: { boost: 'img' } },
                    c: { values: { exposure: 70 }, suppressRuleProfile: true },
                },
            });
            expect(settings.removeChallengeOverride('exposure', 'a')).toBe(true);
            expect(settings.removeChallengeOverride('exposure', 'b')).toBe(true);
            expect(settings.removeChallengeOverride('exposure', 'c')).toBe(true);
            expect(saved().challenges).toEqual({ b: { pins: { boost: 'img' } }, c: { suppressRuleProfile: true } });
        });
    });

    describe('active challenge titles / tags cache', () => {
        const PROFILE_SETUP = {
            profiles: { P: { exposure: 70 } },
        };

        test('rememberChallengeTitles rejects a non-array', () => {
            expect(settings.rememberChallengeTitles(invalid('nope'))).toBe(false);
            expect(settings.rememberChallengeTitles(null)).toBe(false);
        });

        test('only bounded, first-seen observations enter the cache', () => {
            seed(
                {
                    ...PROFILE_SETUP,
                    rules: [
                        { title: 'Alpha', profile: 'P' },
                        { title: 'T', profile: 'P' },
                    ],
                },
                { c: 'Alpha' },
            );
            expect(
                settings.rememberChallengeTitles(
                    invalid([
                        { id: null, title: 'Alpha' },
                        { id: '', title: 'Alpha' },
                        { id: 'a', title: '  T  ' },
                        { id: 'a', title: 'Alpha' }, // duplicate id — first row wins
                        { id: 'b', title: 5 },
                        { id: 'c', title: 'y'.repeat(201) }, // over-length → explicit miss
                    ]),
                ),
            ).toBe(true);

            expect(settings.getEffectiveSetting('exposure', 'a')).toBe(70);
            expect(settings.getEffectiveSetting('exposure', 'b')).toBe(100);
            // The explicit miss must NOT fall back to the persisted pin.
            expect(settings.getEffectiveSetting('exposure', 'c')).toBe(100);
        });

        test('challenge tags are trimmed and bounded; junk entries are dropped', () => {
            seed({
                ...PROFILE_SETUP,
                rules: [{ challengeTag: 'exhibition', profile: 'P' }],
            });
            settings.rememberChallengeTitles(
                invalid([
                    { id: 'a', title: 'Whatever', tags: [5, '   ', 'x'.repeat(201), '  Exhibition '] },
                    { id: 'b', title: 'Other', tags: 'Exhibition' },
                ]),
            );
            expect(settings.getEffectiveSetting('exposure', 'a')).toBe(70);
            expect(settings.getEffectiveSetting('exposure', 'b')).toBe(100);
            expect(settings.getTitleProfile('Nope', 'a')).toMatchObject({
                profile: { name: 'P', values: { exposure: 70 } },
                suppressed: false,
            });
        });

        test('persisted title pins resolve a title profile for an id missing from the live cache', () => {
            seed(
                {
                    ...PROFILE_SETUP,
                    rules: [
                        { title: 'Alpha', profile: 'P' },
                        { title: 'z'.repeat(200), profile: 'P' },
                    ],
                },
                { c1: 'Alpha', c2: 5, c3: 'z'.repeat(200) },
            );
            expect(settings.getEffectiveSetting('exposure', 'c1')).toBe(70);
            // Non-string pin, boundary-length (possibly truncated) pin, unknown id.
            expect(settings.getEffectiveSetting('exposure', 'c2')).toBe(100);
            expect(settings.getEffectiveSetting('exposure', 'c3')).toBe(100);
            expect(settings.getEffectiveSetting('exposure', 'c4')).toBe(100);
        });
    });

    describe('title rules', () => {
        test('getTitleRules tolerates a non-array stored value', () => {
            seed({ rules: 'x' });
            expect(settings.getTitleRules()).toEqual([]);
        });

        test('a title-keyed rule never matches a challenge known only by tags; condition-less rules are ignored', () => {
            seed({
                rules: [
                    { autoJoin: true },
                    { title: 'Alpha', autoJoin: true },
                    { challengeTag: 'Exhibition', autoJoin: false },
                ],
            });
            expect(settings.resolveRuleSetting('autoJoin', { tags: ['exhibition'] })).toEqual({ value: false });
            expect(settings.resolveRuleSetting('autoJoin', { tags: ['comm'] })).toBeNull();
        });

        test('resolveRuleSetting re-validates a hand-edited inline value', () => {
            seed({ rules: [{ title: 'Alpha', autoJoin: 'yes' }] });
            expect(settings.resolveRuleSetting('autoJoin', 'Alpha')).toBeNull();
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
            seed({ rules: null });
            expect(
                settings.setTitleRules([{ title: 'Alpha', mustIncludeTags: 'not-a-list', shouldIncludeTags: ['b'] }]),
            ).toBe(true);
            expect(saved().rules).toEqual([{ title: 'Alpha', mustIncludeTags: [], shouldIncludeTags: ['b'] }]);
        });

        test('setTitleRules rejects a profile whose stored values are invalid', () => {
            seed({ profiles: { P: { exposure: 'bad' } } });
            expect(settings.setTitleRules([{ title: 'Alpha', profile: 'P' }])).toBe(false);
            expect(store.write).not.toHaveBeenCalled();
        });

        test('profile/override composition: missing, suppressed, unrelated and conflicting overrides', () => {
            const base = {
                profiles: { P: { exposure: 70 } },
            };
            const pins = { c1: 'Alpha' };
            // No challenges at all.
            seed({ ...base, challenges: null }, pins);
            expect(settings.setTitleRules([{ title: 'Alpha', profile: 'P' }])).toBe(true);

            // A conflicting override on a challenge the rule applies to fails closed.
            const conflicting = { exposureTarget: 60 };
            seed({ ...base, challenges: { c1: { values: conflicting } } }, pins);
            expect(settings.setTitleRules([{ title: 'Alpha', profile: 'P' }])).toBe(false);

            // ...unless that challenge suppresses its title profile.
            seed({ ...base, challenges: { c1: { values: conflicting, suppressRuleProfile: true } } }, pins);
            expect(settings.setTitleRules([{ title: 'Alpha', profile: 'P' }])).toBe(true);

            // Overrides on a challenge the rule does not reach are not checked.
            seed({ ...base, challenges: { c9: { values: conflicting } } }, pins);
            expect(settings.setTitleRules([{ title: 'Alpha', profile: 'P' }])).toBe(true);

            // A challenge that holds only a pin has no overrides to conflict.
            seed({ ...base, challenges: { c1: { pins: { boost: 'img' } } } }, pins);
            expect(settings.setTitleRules([{ title: 'Alpha', profile: 'P' }])).toBe(true);
        });

        test('getTitleProfile: non-array rules and a dangling profile reference resolve to null', () => {
            seed({ rules: null, profiles: { P: {} } });
            expect(settings.getTitleProfile('Alpha').profile).toBeNull();
            seed({ rules: [{ title: 'Alpha', profile: 'Missing' }] });
            expect(settings.getTitleProfile({ title: 'Alpha' }).profile).toBeNull();
        });

        test('getTitleProfile accepts a challenge object and reports suppression for an id', () => {
            seed({
                profiles: { P: { exposure: 70 } },
                rules: [{ title: 'Alpha', profile: 'P' }],
                challenges: { c1: { suppressRuleProfile: true } },
            });
            expect(settings.getTitleProfile({ title: 'Alpha', tags: [] })).toMatchObject({
                profile: { name: 'P', values: { exposure: 70 } },
                suppressed: false,
            });
            expect(settings.getTitleProfile({ title: 'Alpha' }, 'c1')).toMatchObject({
                profile: { name: 'P', values: { exposure: 70 } },
                suppressed: true,
            });
        });
    });

    describe('effective tag / ignore-word lists', () => {
        test('rule tags union onto the base list, skipping non-string entries', () => {
            seed({
                defaults: { mustIncludeTags: ['a', 'b'] },
                rules: [{ title: 'Alpha', mustIncludeTags: ['b', 5, 'c'], shouldIncludeTags: [] }],
            });
            expect(settings.getEffectiveTagSetting('mustIncludeTags', { title: 'Alpha' })).toEqual(['a', 'b', 'c']);
            // No rule tags → base passes through untouched.
            expect(settings.getEffectiveTagSetting('shouldIncludeTags', { title: 'Alpha' })).toEqual([]);
            // Non-tag key → plain effective value.
            expect(settings.getEffectiveTagSetting('exposure', { title: 'Alpha' })).toBe(100);
        });

        test('a stored null tag list is dropped on load; the rule tags still come through', () => {
            seed({
                defaults: { mustIncludeTags: null },
                rules: [{ title: 'Alpha', mustIncludeTags: ['x'] }],
            });
            expect(settings.getEffectiveTagSetting('mustIncludeTags', { id: 7, title: 'Alpha' })).toEqual(['x']);
        });

        test('getEffectiveIgnoreTitleWords returns the list, or null when empty', () => {
            seed({
                defaults: { ignoreTitleWords: ['epic'] },
                challenges: { 5: { values: { ignoreTitleWords: [] } } },
            });
            expect(settings.getEffectiveIgnoreTitleWords({ title: 'x' })).toEqual(['epic']);
            expect(settings.getEffectiveIgnoreTitleWords({ id: 5 })).toBeNull();
            expect(settings.getEffectiveIgnoreTitleWords(null)).toEqual(['epic']);
        });
    });

    describe('title pins', () => {
        test('mergeTitlePins drops corrupt stored pins', () => {
            seed({}, { x: '', y: 5, z: 'q'.repeat(200), ok: 'Ok' });
            expect(settings.mergeTitlePins({ b: 'B' })).toBe(true);
            expect(savedPins()).toEqual({ ok: 'Ok', b: 'B' });
        });

        test('the pin-cap warning fires once while the map stays saturated', () => {
            const pins: Record<string, string> = {};
            for (let i = 0; i < 500; i++) pins[`id${i}`] = `T${i}`;
            seed({}, pins);

            settings.mergeTitlePins({ extra1: 'E1' });
            settings.mergeTitlePins({ extra2: 'E2' });
            const capWarnings = cat.warning.mock.calls.filter(([msg]) => String(msg).includes('pin cap'));
            expect(capWarnings).toHaveLength(1);
            expect(capWarnings[0][0]).toContain('extra1');
            expect(Object.keys(savedPins())).toHaveLength(500);
            expect(savedPins().extra2).toBeUndefined();
        });
    });

    describe('named profiles', () => {
        test('getChallengeProfiles skips reserved names and drops invalid/oversized values silently', () => {
            const huge: Record<string, number> = {};
            for (let i = 0; i < 101; i++) huge[`k${i}`] = i;
            seed({
                profiles: { constructor: { exposure: 70 }, Good: { exposure: 70, exposureTarget: 5 }, Huge: huge },
            });
            expect(settings.getChallengeProfiles()).toEqual({ Good: { exposure: 70 }, Huge: {} });
        });

        test('saveChallengeProfile rejects an oversized payload', () => {
            seed({});
            const huge: Record<string, number> = {};
            for (let i = 0; i < 101; i++) huge[`k${i}`] = i;
            expect(settings.saveChallengeProfile('Big', huge)).toBe(false);
            expect(store.write).not.toHaveBeenCalled();
        });

        test('saveChallengeProfile rebuilds a null container and drops reserved stored names', () => {
            seed({ profiles: null });
            expect(settings.saveChallengeProfile('Mine', { exposure: 70 })).toBe(true);
            expect(saved().profiles).toEqual({ Mine: { exposure: 70 } });

            seed({ profiles: { constructor: { exposure: 1 }, A: {} } });
            expect(settings.saveChallengeProfile('B', {})).toBe(true);
            expect(Object.keys(saved().profiles)).toEqual(['A', 'B']);
        });

        test('overwriting a profile tolerates non-array rules and renames only its own assignments', () => {
            seed({ profiles: { A: {} }, rules: 'x' });
            expect(settings.saveChallengeProfile('a', { exposure: 70 })).toBe(true);
            expect(saved().profiles).toEqual({ a: { exposure: 70 } });

            seed({
                profiles: { A: {}, B: {} },
                rules: [
                    { title: 'X', profile: 'A', mustIncludeTags: [], shouldIncludeTags: [] },
                    { title: 'Y', profile: 'B', mustIncludeTags: [], shouldIncludeTags: [] },
                ],
            });
            expect(settings.saveChallengeProfile('a', { exposure: 70 })).toBe(true);
            expect(saved().rules.map((r) => r.profile)).toEqual(['a', 'B']);
        });

        test("deleteChallengeProfile skips reserved stored keys and keeps other profiles' rules", () => {
            seed({
                profiles: { constructor: {}, A: {}, B: {} },
                rules: [
                    { title: 'X', profile: 'A' },
                    { title: 'Y', profile: 'B' },
                ],
            });
            expect(settings.deleteChallengeProfile('a')).toBe(true);
            const config = saved();
            expect(config.profiles.A).toBeUndefined();
            expect(config.rules).toEqual([{ title: 'Y', profile: 'B' }]);

            seed({ profiles: { A: {} }, rules: null });
            expect(settings.deleteChallengeProfile('A')).toBe(true);
            expect(saved().profiles).toEqual({});
        });

        test('applyChallengeProfile rejects a blank or reserved profile name', () => {
            seed({ profiles: { A: {} } });
            expect(settings.applyChallengeProfile('', 'c1')).toBe(false);
            expect(settings.applyChallengeProfile('__proto__', 'c1')).toBe(false);
            expect(store.write).not.toHaveBeenCalled();
            expect(cat.error).toHaveBeenCalledWith('Invalid profile name: "__proto__"', null);
        });

        test('seedIntentProfiles marks an intent that cannot be saved on this install as seeded', () => {
            // Global final-window settings that are self-inconsistent make the one
            // intent that inherits them (Just Participate) fail validation.
            seed({
                defaults: {
                    useFinalWindowExposure: true,
                    finalWindowExposure: 90,
                    finalWindowExposureTarget: 50,
                },
            });
            expect(settings.seedIntentProfiles()).toBe(true);
            const config = saved();
            expect(config.profiles['Just Participate']).toBeUndefined();
            expect(config.profiles['Finish Strong']).toBeDefined();
            expect(config.seededProfiles).toContain('just participate');
            expect(cat.warning).toHaveBeenCalledWith(
                expect.stringContaining('Skipped seeding intent profile "Just Participate"'),
            );
        });
    });

    describe('cleanup', () => {
        test('cleanupStaleChallengeSetting: nothing to do without a container or stale ids', () => {
            seed({ challenges: null });
            expect(settings.cleanupStaleChallengeSetting(['c1'])).toBe(true);
            seed({ challenges: { c1: { values: { exposure: 70 } } } });
            expect(settings.cleanupStaleChallengeSetting(['c1'])).toBe(true);
            expect(store.write).not.toHaveBeenCalled();
        });

        test('cleanupStaleChallengeSetting prunes the whole record of a stale challenge', () => {
            settings.rememberChallengeTitles([{ id: 'other', title: 'Other' }]);
            seed({
                challenges: {
                    c1: { values: { exposure: 70 }, suppressRuleProfile: true },
                    old: { values: { exposure: 60 } },
                    gone: { suppressRuleProfile: true },
                    pinned: { pins: { boost: 'img' } },
                },
            });
            expect(settings.cleanupStaleChallengeSetting(['c1'])).toBe(true);
            expect(saved().challenges).toEqual({ c1: { values: { exposure: 70 }, suppressRuleProfile: true } });
        });

        test('cleanupStaleChallengeSetting handles records without values', () => {
            settings.rememberChallengeTitles([{ id: 'other', title: 'Other' }]);
            seed({ challenges: { gone: { suppressRuleProfile: true } } });
            expect(settings.cleanupStaleChallengeSetting([])).toBe(true);
            expect(saved().challenges).toEqual({});
        });
    });

    describe('reset / modified helpers', () => {
        test('resetSetting restores an app default and rejects unknown keys', () => {
            seed({ app: { theme: 'weird-theme' } });
            expect(settings.isSettingModified('theme')).toBe(true);
            expect(settings.resetSetting('theme')).toBe(true);
            expect(saved().app.theme).toBe(settings.getDefaultSettings().app.theme);
            expect(settings.isSettingModified('theme')).toBe(false);

            expect(settings.resetSetting('noSuchKey')).toBe(false);
            expect(settings.isSettingModified('noSuchKey')).toBe(false);
        });

        test('resetAllSettings keeps the sign-in state and the mock mode, and resets everything else', () => {
            seed({
                auth: { token: 'tok', apiHeaders: { a: '1' }, lastUsername: 'me', chosenPhotosMemberId: 'm' },
                app: { mock: true, theme: 'weird-theme' },
            });
            expect(settings.resetAllSettings()).toBe(true);
            const out = saved();
            expect(out.auth).toEqual({
                token: 'tok',
                apiHeaders: { a: '1' },
                lastUsername: 'me',
                chosenPhotosMemberId: 'm',
            });
            expect(out.app.mock).toBe(true);
            expect(out.app.theme).toBe(settings.getDefaultSettings().app.theme);
        });
    });

    describe('guards on hand-edited or unusual input', () => {
        test('a global-only key inside a stored override is ignored when composing a title profile', () => {
            seed(
                {
                    profiles: { P: { exposure: 70 } },
                    challenges: { c1: { values: { lastMinuteCheckFrequency: 'junk' } } },
                },
                { c1: 'Alpha' },
            );
            expect(settings.setTitleRules([{ title: 'Alpha', profile: 'P' }])).toBe(true);
        });

        test('a null challenge id never inherits a title profile through a pin keyed "null"', () => {
            seed(
                {
                    profiles: { P: { exposure: 70 } },
                    rules: [{ title: 'Alpha', profile: 'P' }],
                },
                { null: 'Alpha' },
            );
            settings.rememberChallengeTitles([{ id: 'null', title: 'Alpha', tags: ['x'] }]);
            // 70 differs from the (un-inherited) global 100, so it is stored rather
            // than cleared as "equal to the inherited profile value".
            expect(settings.setChallengeOverride('exposure', invalid(null), 70)).toBe(true);
            expect(saved().challenges.null.values).toEqual({ exposure: 70 });
        });
    });

    describe('persistence failures (fs transport)', () => {
        let fs: jest.MockedObject<typeof node_fsModule>;
        // A configuration as the facade last wrote it, so that a re-load performs no write of its own.
        const storedConfig = (obj: unknown) => {
            seed(obj);
            return store.value!;
        };
        const useFailingDisk = (blob: string) => {
            fs = jest.mocked(require('node:fs') as typeof node_fsModule);
            removeHeadlessStore();
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(blob);
            fs.readdirSync.mockReturnValue([]);
            fs.writeFileSync.mockImplementation(() => {
                throw new Error('EROFS');
            });
        };

        afterEach(() => {
            fs.existsSync.mockReset();
            fs.readFileSync.mockReset();
            fs.readdirSync.mockReset();
            fs.writeFileSync.mockReset();
        });

        test('resetAllSettings reports a failed save', () => {
            useFailingDisk(storedConfig({ defaults: { exposure: 70 } }));
            expect(settings.resetAllSettings()).toBe(false);
            expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
        });

        test('seedIntentProfiles reports the skipped profiles when every write fails', () => {
            const blob = storedConfig({});
            useFailingDisk(blob);
            expect(settings.seedIntentProfiles()).toBe(false);
            expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining('Skipped seeding intent profile'));
        });
    });
});
