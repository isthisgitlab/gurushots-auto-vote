/**
 * Fixtures for the layers a value comes from and how they stack: global defaults, rules, a rule's profile and inline
 * values, a challenge's own values, a profile suppression, the scenario assignment and its phase overlay, the keys
 * that exist only on a challenge, and the two zero sentinels.
 */

import { MODERN, PLAN_A, PLAN_B } from './types';

import type { Fixture } from './types';

const NIGHT = { exposure: 60, exposureTarget: 70, autoFill: true, boostTime: 900, autoJoinMaxCoins: 25 };

const PRECEDENCE: Fixture[] = [
    {
        name: 'an empty file',
        blob: { ...MODERN },
        check: (oracle) => {
            expect(oracle.effective('exposure', '101')).toBe(100);
            expect(oracle.autoJoinActive()).toBe(false);
        },
    },
    {
        name: 'global defaults, a rule, and a challenge value, each above the one before',
        blob: {
            ...MODERN,
            challengeSettings: {
                globalDefaults: { exposure: 80, exposureTarget: 90, boostTime: 1200, autoBoost: false },
                titleRules: [{ title: 'Macro World', mustIncludeTags: [], shouldIncludeTags: [], autoFill: true }],
                perChallenge: { '101': { boostTime: 600 }, '102': { exposure: 50 } },
            },
        },
        check: (oracle) => {
            expect(oracle.effective('boostTime', '101')).toBe(600);
            expect(oracle.effective('boostTime', '103')).toBe(1200);
            expect(oracle.effective('autoFill', '101')).toBe(true);
            expect(oracle.effective('autoFill', '103')).toBe(false);
            expect(oracle.effective('exposure', null)).toBe(80);
        },
    },
    {
        name: 'a suppression combined with an own scenario, a rule inline value and a profile',
        blob: {
            ...MODERN,
            challengeSettings: {
                globalDefaults: { exposure: 100, exposureTarget: 100 },
                profiles: { Night: NIGHT },
                titleRules: [
                    {
                        title: 'Macro World',
                        mustIncludeTags: [],
                        shouldIncludeTags: [],
                        profile: 'night',
                        autoJoin: true,
                        autoFill: false,
                        scenario: 'Plan A',
                    },
                    { title: 'Night Sky', profile: 'Night', scenario: 'plan b' },
                ],
                perChallenge: {
                    '101': { scenario: 'Plan B', exposure: 90, exposureTarget: 95 },
                    '102': { exposure: 55 },
                },
                titleProfileSuppressions: { '101': true, '102': true, '103': false },
                scenarios: { 'Plan A': PLAN_A, 'Plan B': PLAN_B },
            },
        },
        check: (oracle) => {
            // Suppressed: the rule's inline values stay, its profile goes.
            expect(oracle.effective('autoFill', '101')).toBe(false);
            expect(oracle.effective('boostTime', '101')).toBe(3600);
            expect(oracle.effective('scenario', '101')).toBe('Plan B');
            expect(oracle.effective('scenario', '102')).toBe('plan b');
            expect(oracle.effective('boostTime', '102')).toBe(3600);
            expect(oracle.customization('101', 'Macro World')).toBe('manual');
            expect(oracle.customization('102', 'Night Sky')).toBe('manual');
        },
    },
    {
        name: 'a scenario opt-out over a rule assignment',
        blob: {
            ...MODERN,
            challengeSettings: {
                titleRules: [
                    { title: 'Night Sky', scenario: 'Plan A' },
                    { title: 'Macro World', scenario: 'Plan A' },
                ],
                perChallenge: { '102': { scenario: '' } },
                scenarios: { 'Plan A': PLAN_A },
            },
        },
        check: (oracle) => {
            expect(oracle.effective('scenario', '102')).toBe('');
            expect(oracle.effective('scenario', '101')).toBe('Plan A');
            expect(oracle.scenarioStatus('102').scenario).toBeNull();
            expect(oracle.scenarioStatus('101').scenario).toBe('Plan A');
        },
    },
    {
        name: 'a scenario phase overlay above a challenge value, a rule and a profile',
        blob: {
            ...MODERN,
            challengeSettings: {
                globalDefaults: { exposure: 100, exposureTarget: 100 },
                profiles: { Night: NIGHT },
                titleRules: [{ title: 'Macro World', profile: 'Night', scenario: 'Plan A' }],
                perChallenge: { '101': { exposure: 75, exposureTarget: 85, boostTime: 120 } },
                scenarios: { 'Plan A': PLAN_A, 'Plan B': PLAN_B },
            },
        },
        check: (oracle) => {
            expect(oracle.effective('exposure', '101')).toBe(75);
            expect(oracle.scenarios()['Plan A'].phases.push).toContain('mustIncludeTags');
        },
    },
    {
        name: 'challengeOnly keys: a global scenario is ignored, and manualPhotosOnly is on-only in a rule and a profile',
        blob: {
            ...MODERN,
            challengeSettings: {
                globalDefaults: { scenario: 'Plan B', manualPhotosOnly: true },
                profiles: { Careful: { manualPhotosOnly: false, exposure: 70, exposureTarget: 80 } },
                titleRules: [
                    { title: 'Macro World', profile: 'Careful', manualPhotosOnly: false },
                    { title: 'Portrait Study', manualPhotosOnly: true },
                    { title: 'Night Sky', profile: 'Careful', manualPhotosOnly: true },
                ],
                perChallenge: { '103': { manualPhotosOnly: false }, '104': { manualPhotosOnly: true } },
                scenarios: { 'Plan B': PLAN_B },
            },
        },
        check: (oracle) => {
            expect(oracle.effective('scenario', null)).toBe('');
            expect(oracle.effective('manualPhotosOnly', null)).toBe(false);
            expect(oracle.effective('manualPhotosOnly', '101')).toBe(false);
            expect(oracle.effective('manualPhotosOnly', '103')).toBe(false);
            expect(oracle.effective('manualPhotosOnly', '104')).toBe(true);
            expect(oracle.effective('manualPhotosOnly', '102')).toBe(true);
            expect(oracle.ruleValues('Macro World').values).not.toHaveProperty('manualPhotosOnly');
        },
    },
    {
        name: 'an empty chosenPhotos list versus inherit',
        blob: {
            ...MODERN,
            challengeSettings: {
                globalDefaults: { chosenPhotos: ['g1', 'g2'], chosenPhotosOnly: true },
                titleRules: [
                    { title: 'Macro World', chosenPhotos: [] },
                    { title: 'Night Sky', chosenPhotos: '' },
                    { title: 'Portrait Study', chosenPhotos: null, chosenPhotosOnly: false },
                    { title: 'Brand New Theme', chosenPhotos: ['r1'], chosenPhotosInOrder: true },
                ],
                perChallenge: {
                    '103': { chosenPhotos: [] },
                    '901': { chosenPhotos: ['own'] },
                    '902': { chosenPhotos: [] },
                },
            },
        },
        check: (oracle) => {
            expect(oracle.effective('chosenPhotos', '101')).toEqual([]);
            expect(oracle.effective('chosenPhotos', '102')).toEqual(['g1', 'g2']);
            expect(oracle.effective('chosenPhotos', '103')).toEqual([]);
            expect(oracle.joinSetting('chosenPhotos', { id: '901', title: 'Macro World' })).toEqual(['own']);
            expect(oracle.joinSetting('chosenPhotos', { id: '902', title: 'Brand New Theme' })).toEqual([]);
            expect(oracle.joinSetting('chosenPhotos', { id: '903', title: 'Brand New Theme' })).toEqual(['r1']);
        },
    },
    {
        name: 'both sentinel families',
        blob: {
            ...MODERN,
            challengeSettings: {
                globalDefaults: {
                    exposure: 50,
                    exposureTarget: 0,
                    finalWindowExposure: 40,
                    finalWindowExposureTarget: 0,
                    useFinalWindowExposure: true,
                    boostTime: 0,
                    emergencyFill: 0,
                    keyUnlockedBoostTime: 0,
                },
                profiles: {
                    Zeroes: { exposure: 60, exposureTarget: 0, boostTime: 0 },
                    Nulls: { exposure: 60, exposureTarget: null },
                    Unset: { emergencyFill: 300, keyUnlockedBoostTime: 600, finalWindowExposureTarget: 45 },
                },
                titleRules: [
                    { title: 'Macro World', profile: 'Zeroes' },
                    { title: 'Night Sky', profile: 'Nulls' },
                    { title: 'Portrait Study', profile: 'Unset' },
                ],
                perChallenge: {
                    '104': { exposure: 30, exposureTarget: 0, boostTime: 0, emergencyFill: 120 },
                    '105': { finalWindowExposure: 35, finalWindowExposureTarget: 35, keyUnlockedBoostTime: 0 },
                },
            },
        },
        check: (oracle) => {
            expect(oracle.effective('exposureTarget', '101')).toBe(0);
            expect(oracle.effective('boostTime', '101')).toBe(0);
            // A profile holding a null target fails whole: nothing of it applies.
            expect(oracle.effective('exposure', '102')).toBe(50);
            expect(oracle.ruleProfile('Night Sky')).toBeNull();
            expect(oracle.effective('emergencyFill', '103')).toBe(300);
            expect(oracle.effective('emergencyFill', '104')).toBe(120);
            expect(oracle.effective('finalWindowExposureTarget', '105')).toBe(35);
        },
    },
];

export { PRECEDENCE };
