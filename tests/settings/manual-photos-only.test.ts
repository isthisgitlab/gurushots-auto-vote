/**
 * Manual Only (`manualPhotosOnly`): a challengeOnly boolean that, once on, stops everything automatic on a
 * challenge. `false` lives only in a challenge's own override: rules and profiles hold "on" or nothing, a profile
 * apply keeps the challenge's value, a scenario phase may not set it, and an un-joined id's value is honoured by
 * the join and survives stale cleanup. Drives the in-memory headless-store seam so the facade round-trips.
 */

import settings = require('../../src/ts/settings');
import type * as settingsResolutionModule from '../../src/ts/services/joinChallenges/settingsResolution';
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import type { MemoryStore } from '../helpers/headlessStore';
import { hasPostJoinInlineValue, ruleHasBehaviour } from '../../src/ts/settings/ruleBehaviour';
import { isConfig } from '../helpers/storedShapes';
import { parseJsonAs } from '../helpers/parseJson';
const { resolveJoinSetting } =
    require('../../src/ts/services/joinChallenges/settingsResolution') as typeof settingsResolutionModule;

jest.mock('../../src/ts/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        withCategory: jest.fn(() => category),
    };
});

describe('Manual Only setting', () => {
    let store: MemoryStore;
    const blob = () => parseJsonAs(store.value!, isConfig);
    const writeBlob = (edit: (raw: ReturnType<typeof blob>) => void) => {
        const raw = blob();
        edit(raw);
        store.value = JSON.stringify(raw);
    };
    const effective = (id: string) => settings.getEffectiveSetting('manualPhotosOnly', id);

    beforeEach(() => {
        store = installHeadlessStore();
        settings.rememberChallengeTitles([]);
        settings.setGlobalDefault('exposure', 90); // writes the blob
    });

    afterEach(() => {
        removeHeadlessStore();
    });

    describe('the schema entry', () => {
        test('is a per-challenge-only boolean, off by default', () => {
            const entry = settings.SETTINGS_SCHEMA.manualPhotosOnly;
            expect(entry).toMatchObject({ type: 'boolean', default: false, perChallenge: true, challengeOnly: true });
            expect(effective('7')).toBe(false);
        });

        test('a global value is refused, and a stored one is ignored', () => {
            expect(settings.setGlobalDefault('manualPhotosOnly', true)).toBe(false);
            writeBlob((raw) => {
                raw.defaults.manualPhotosOnly = true;
            });
            expect(effective('7')).toBe(false);
        });
    });

    describe('in a challenge rule', () => {
        test('"on" round-trips and a rule holding only it is kept', () => {
            expect(settings.TITLE_RULE_INLINE_KEYS).toContain('manualPhotosOnly');
            expect(settings.setTitleRules([{ title: 'Big show', manualPhotosOnly: true }])).toBe(true);
            expect(settings.getTitleRules()).toEqual([expect.objectContaining({ manualPhotosOnly: true })]);
        });

        test('"" inherits, so a rule holding nothing else is dropped', () => {
            expect(settings.setTitleRules([{ title: 'Big show', manualPhotosOnly: '' }])).toBe(true);
            expect(settings.getTitleRules()).toEqual([]);
        });

        test('`false` is dropped: it never reaches storage, and it alone does not keep the rule', () => {
            expect(settings.setTitleRules([{ title: 'Big show', manualPhotosOnly: false }])).toBe(true);
            expect(settings.getTitleRules()).toEqual([]);
            expect(settings.setTitleRules([{ title: 'Big show', autoJoin: true, manualPhotosOnly: false }])).toBe(true);
            const [rule] = settings.getTitleRules();
            expect(rule).toEqual(expect.objectContaining({ autoJoin: true }));
            expect(rule).not.toHaveProperty('manualPhotosOnly');
        });

        test('a hand-edited stored `false` contributes nothing, so a later rule\'s "on" still applies', () => {
            expect(
                settings.setTitleRules([
                    { title: 'Big', match: 'contains', autoJoin: true },
                    { title: 'Big show', manualPhotosOnly: true },
                ]),
            ).toBe(true);
            writeBlob((raw) => {
                raw.rules[0].manualPhotosOnly = false;
            });
            expect(settings.resolveRuleSetting('manualPhotosOnly', 'Big show')).toEqual({ value: true });
        });

        test('the editor-side judgments agree: only "on" is behaviour, and it still matters after the join', () => {
            expect(ruleHasBehaviour({ manualPhotosOnly: true })).toBe(true);
            expect(ruleHasBehaviour({ manualPhotosOnly: false })).toBe(false);
            expect(hasPostJoinInlineValue({ manualPhotosOnly: true })).toBe(true);
        });

        test("a challenge's own `false` beats the rule's `true`, and is kept", () => {
            settings.setTitleRules([{ title: 'Big show', manualPhotosOnly: true }]);
            settings.rememberChallengeTitles([
                { id: '7', title: 'Big show' },
                { id: '8', title: 'Big show' },
            ]);
            expect(effective('7')).toBe(true);
            expect(settings.setChallengeOverride('manualPhotosOnly', '7', false)).toBe(true);
            expect(effective('7')).toBe(false);
            expect(effective('8')).toBe(true);
            expect(blob().challenges['7'].values).toEqual({ manualPhotosOnly: false });
        });
    });

    describe('in a profile', () => {
        test('"on" is kept', () => {
            expect(settings.saveChallengeProfile('Locked', { manualPhotosOnly: true, exposure: 50 })).toBe(true);
            expect(settings.getChallengeProfiles().Locked).toEqual({ manualPhotosOnly: true, exposure: 50 });
        });

        test("`false` is dropped on save (a profile saved from a challenge's overrides), not refused", () => {
            expect(settings.saveChallengeProfile('Plain', { manualPhotosOnly: false, exposure: 50 })).toBe(true);
            expect(settings.getChallengeProfiles().Plain).toEqual({ exposure: 50 });
        });

        test('a hand-edited stored `false` is dropped on read', () => {
            writeBlob((raw) => {
                raw.profiles = { Edited: { manualPhotosOnly: false, exposure: 50 } };
            });
            expect(settings.getChallengeProfiles().Edited).toEqual({ exposure: 50 });
        });

        test("applying a profile keeps the challenge's own value", () => {
            settings.setTitleRules([{ title: 'Big show', manualPhotosOnly: true }]);
            settings.rememberChallengeTitles([{ id: '7', title: 'Big show' }]);
            settings.saveChallengeProfile('Plain', { exposure: 50 });
            settings.setChallengeOverride('manualPhotosOnly', '7', false);
            expect(settings.applyChallengeProfile('Plain', '7')).toBe(true);
            expect(settings.getChallengeOverride('manualPhotosOnly', '7')).toBe(false);
            expect(settings.getChallengeOverride('exposure', '7')).toBe(50);
        });

        test("a profile that turns the switch on wins over the challenge's own `false`", () => {
            settings.setTitleRules([{ title: 'Big show', manualPhotosOnly: true }]);
            settings.rememberChallengeTitles([{ id: '7', title: 'Big show' }]);
            settings.saveChallengeProfile('Locked', { manualPhotosOnly: true });
            settings.setChallengeOverride('manualPhotosOnly', '7', false);
            expect(settings.getChallengeOverride('manualPhotosOnly', '7')).toBe(false);
            expect(settings.applyChallengeProfile('Locked', '7')).toBe(true);
            expect(effective('7')).toBe(true);
        });

        test("the challenge's own `true` is kept when the profile does not set the key", () => {
            settings.saveChallengeProfile('Plain', { exposure: 50 });
            settings.setChallengeOverride('manualPhotosOnly', '7', true);
            expect(settings.applyChallengeProfile('Plain', '7')).toBe(true);
            expect(settings.getChallengeOverride('manualPhotosOnly', '7')).toBe(true);
            expect(settings.getChallengeOverride('exposure', '7')).toBe(50);
        });

        test('applying one replaces the other overrides, and takes the profile\'s "on" when the challenge has no value', () => {
            settings.saveChallengeProfile('Locked', { manualPhotosOnly: true });
            settings.setChallengeOverride('exposure', '7', 40);
            expect(settings.applyChallengeProfile('Locked', '7')).toBe(true);
            expect(settings.getChallengeOverride('exposure', '7')).toBeNull();
            expect(settings.getChallengeOverride('manualPhotosOnly', '7')).toBe(true);
        });
    });

    describe('for an un-joined challenge', () => {
        test("the join's per-id read honours the value saved for that id", () => {
            expect(resolveJoinSetting('manualPhotosOnly', { id: 55, title: 'Fresh' })).toBe(false);
            settings.setChallengeOverride('manualPhotosOnly', '55', true);
            expect(resolveJoinSetting('manualPhotosOnly', { id: 55, title: 'Fresh' })).toBe(true);
            expect(resolveJoinSetting('manualPhotosOnly', { id: 56, title: 'Fresh' })).toBe(false);
        });

        test('a rule decides when no value is saved for the id', () => {
            settings.setTitleRules([{ title: 'Fresh', manualPhotosOnly: true }]);
            expect(resolveJoinSetting('manualPhotosOnly', { id: 57, title: 'Fresh' })).toBe(true);
        });

        test('stale cleanup keeps the entry of a challenge that can still be joined, and prunes a gone one', () => {
            settings.setChallengeOverride('manualPhotosOnly', '60', true);
            settings.setChallengeOverride('manualPhotosOnly', '61', true);
            settings.rememberChallengeTitles([{ id: '999', title: 'Elsewhere' }]);
            settings.rememberOpenChallengeIds([60]);
            settings.rememberUpcomingChallenges([]);
            expect(settings.cleanupStaleChallengeSetting([])).toBe(true);
            expect(Object.keys(blob().challenges)).toEqual(['60']);
        });
    });

    describe('in a scenario', () => {
        const scenario = (phaseSettings: Record<string, unknown>) => ({
            name: 'Plan',
            version: 1,
            start: 'main',
            phases: { main: { settings: phaseSettings } },
        });

        test('a phase that sets it is refused with its own message, whatever the value', () => {
            for (const value of [true, false]) {
                expect(settings.saveScenario(scenario({ manualPhotosOnly: value }))).toEqual({
                    ok: false,
                    issues: [
                        {
                            path: 'phases.main.settings.manualPhotosOnly',
                            message: 'A phase cannot change Manual Only',
                        },
                    ],
                });
            }
        });

        test('a hand-edited stored scenario whose phase sets it is dropped on read', () => {
            expect(settings.saveScenario(scenario({ exposure: 50, exposureTarget: 60 })).ok).toBe(true);
            expect(settings.getScenario('Plan')).not.toBeNull();
            writeBlob((raw) => {
                const stored = raw.scenarios as Record<string, { phases: { main: { settings: object } } }>;
                stored.Plan.phases.main.settings = { manualPhotosOnly: false };
            });
            expect(settings.getScenario('Plan')).toBeNull();
            expect(Object.keys(settings.getScenarios())).toEqual([]);
        });
    });
});
