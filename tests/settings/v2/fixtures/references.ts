/**
 * Fixtures for references and values that do not resolve or do not validate: a profile, a scenario or a rule that
 * names something missing, reserved names, a profile that fails as a whole, a rule with an invalid inline value, a
 * renamed challenge read through its title pin, and containers of the wrong kind.
 */

import { CHALLENGES, MODERN, PLAN_A, PLAN_B } from './types';

import type { Fixture } from './types';

const reservedNames = `{
    ${Object.keys(MODERN)
        .map((flag) => `"${flag}": true`)
        .join(', ')},
    "challengeSettings": {
        "profiles": {
            "__proto__": { "exposure": 70, "exposureTarget": 80 },
            "constructor": { "exposure": 65, "exposureTarget": 75 },
            "Night": { "exposure": 60, "exposureTarget": 70 }
        },
        "titleRules": [
            { "title": "Macro World", "profile": "__proto__", "autoJoin": true },
            { "title": "Night Sky", "profile": " Constructor " },
            { "title": "Portrait Study", "profile": "prototype" },
            { "title": "Street Life", "profile": "NIGHT" }
        ],
        "scenarios": {
            "__proto__": { "name": "Evil", "version": 1, "start": "a", "phases": { "a": {} } },
            "Plan B": { "name": "Plan B", "version": 1, "start": "only", "phases": { "only": { "settings": { "onlyBoost": true } } } }
        },
        "perChallenge": {
            "constructor": { "exposure": 11 },
            "101": { "scenario": "__proto__" },
            "102": { "scenario": "plan b" }
        },
        "titleProfileSuppressions": { "__proto__": true, "104": true },
        "entryPins": { "constructor": { "boost": "x" }, "101": { "boost": "e1" } },
        "titlePins": { "__proto__": "Macro World", "106": "Macro World" }
    }
}`;

const overlongTitle = 'x'.repeat(201);

const REFERENCES: Fixture[] = [
    {
        name: 'references that do not resolve in each layer: profile, scenario, rule, challenge values',
        blob: {
            ...MODERN,
            challengeSettings: {
                globalDefaults: { scenario: 'Ghost' },
                profiles: {
                    Night: { exposure: 60, exposureTarget: 70, scenario: 'Ghost profile' },
                    Armed: { scenario: 'Plan B' },
                },
                titleRules: [
                    { title: 'Macro World', profile: 'Nobody' },
                    { title: 'Night Sky', profile: 'Night', scenario: 'Ghost rule' },
                    { title: 'Portrait Study', profile: 'Armed' },
                    { title: 'Street Life', scenario: 'plan b' },
                ],
                perChallenge: { '101': { scenario: 'Ghost challenge' }, '103': { scenario: ' Plan B ' } },
                scenarios: { 'Plan B': PLAN_B },
            },
        },
        check: (oracle) => {
            expect(oracle.effective('scenario', '101')).toBe('Ghost challenge');
            expect(oracle.scenarioStatus('101')).toMatchObject({ assigned: 'Ghost challenge', scenario: null });
            expect(oracle.ruleProfile('Macro World')).toBeNull();
            expect(oracle.effective('scenario', '102')).toBe('Ghost rule');
            expect(oracle.effective('scenario', '103')).toBe(' Plan B ');
            expect(oracle.scenarioStatus('103').scenario).toBe('Plan B');
            expect(oracle.scenarioStatus('104').scenario).toBe('Plan B');
        },
    },
    {
        name: 'reserved profile, scenario, challenge and pin names',
        blob: reservedNames,
        check: (oracle) => {
            expect(oracle.ruleProfile('Macro World')).toBeNull();
            expect(oracle.ruleProfile('Night Sky')).toBeNull();
            expect(oracle.ruleProfile('Street Life')).toMatchObject({ name: 'Night' });
            expect(oracle.effective('scenario', '102')).toBe('plan b');
            expect(oracle.scenarioStatus('101').scenario).toBeNull();
            expect(oracle.titleProfile('Street Life', '104')).toMatchObject({ suppressed: true });
        },
    },
    {
        name: 'profiles that fail as a whole: a conflict with an inherited value, a bad pair, a bad value, a big one',
        blob: {
            ...MODERN,
            challengeSettings: {
                globalDefaults: { exposure: 70, exposureTarget: 80, autoJoin: false },
                profiles: {
                    Conflict: { exposure: 90 },
                    BadPair: { exposure: 80, exposureTarget: 50 },
                    BadValue: { boostTime: -5, exposure: 60, exposureTarget: 65 },
                    Big: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, i])),
                    Fine: { exposure: 75, exposureTarget: 85, autoFill: true },
                    Armed: { autoJoin: true, exposure: 999 },
                    NotObject: 'junk',
                    AnArray: [1],
                    Foreign: { token: 'no', mock: true, exposure: 72, exposureTarget: 82 },
                },
                titleRules: [
                    { title: 'Macro World', profile: 'Conflict', autoFill: true },
                    { title: 'Night Sky', profile: 'BadPair' },
                    { title: 'Portrait Study', profile: 'BadValue' },
                    { title: 'Street Life', profile: 'Big' },
                    { title: 'Brand New Theme', profile: 'Fine' },
                    { type: 'flash', profile: 'Armed' },
                    { challengeTag: 'No comm', profile: 'NotObject' },
                    { challengeTag: 'Comm', profile: 'AnArray' },
                    { challengeTag: 'Exhibition', profile: 'Foreign' },
                ],
            },
        },
        check: (oracle) => {
            for (const title of ['Macro World', 'Night Sky', 'Portrait Study', 'Street Life']) {
                expect(oracle.ruleProfile(title)).toBeNull();
            }
            expect(oracle.ruleProfile('Brand New Theme')).toMatchObject({ name: 'Fine' });
            // The inline value of a rule whose profile fails still applies.
            expect(oracle.effective('autoFill', '101')).toBe(true);
            // Arming reads the profile's own valid values, so a profile that never applies still arms auto-join.
            expect(oracle.anyRuleEnablesAutoJoin()).toBe(true);
            expect(oracle.ruleProfile({ challengeTag: 'x' } as never)).toBeNull();
            expect(oracle.ruleValues({ tags: ['Exhibition'], title: 'x' }).profile).toMatchObject({ name: 'Foreign' });
        },
    },
    {
        name: 'a rule with an invalid inline value gives no inline values, its profile still applies',
        blob: {
            ...MODERN,
            challengeSettings: {
                profiles: { Night: { exposure: 60, exposureTarget: 70, autoJoin: true } },
                titleRules: [
                    { title: 'Night Sky', profile: 'Night', autoJoin: 'yes', autoFill: true, scenario: 'Plan B' },
                    { title: 'Macro World', autoJoin: true, autoJoinWithinHoursOfEnd: 9999, chosenPhotos: ['a b'] },
                    {
                        title: 'Portrait Study',
                        autoJoin: true,
                        autoJoinAfterPercentElapsed: 50,
                        scenario: 'x'.repeat(61),
                    },
                    { title: 'Street Life', autoJoin: false, mustIncludeTags: ['x'.repeat(60)] },
                ],
                scenarios: { 'Plan B': PLAN_B },
            },
        },
        check: (oracle) => {
            expect(oracle.ruleValues('Night Sky').values).toEqual({ exposure: 60, exposureTarget: 70, autoJoin: true });
            expect(oracle.ruleValues('Macro World').values).toEqual({});
            expect(oracle.ruleValues('Portrait Study').values).toEqual({});
            expect(oracle.ruleValues('Street Life').values).toEqual({ autoJoin: false });
        },
    },
    {
        name: 'a challenge renamed server-side: the title pin against the live title, an absent title, an id off the list',
        blob: {
            ...MODERN,
            challengeSettings: {
                titleRules: [
                    { title: 'Macro World', autoFill: true },
                    { title: 'Night Sky', autoJoin: true },
                    { title: 'Portrait Study', autoJoinAfterPercentElapsed: 60 },
                    { title: 'Street Life', autoJoinWithinHoursOfEnd: 77 },
                ],
                titlePins: {
                    '101': 'Macro World',
                    '102': 'Night Sky',
                    '103': 'Portrait Study',
                    '104': 'Street Life',
                    '106': 'Macro World',
                    '107': 'x'.repeat(200),
                    '108': '   ',
                    '109': 7,
                },
            },
        },
        offList: ['106', '107', '108', '109'],
        challenges: [
            { ...CHALLENGES[0], title: 'Macro World: Finals' },
            { ...CHALLENGES[1], title: null },
            { ...CHALLENGES[2], title: overlongTitle },
            CHALLENGES[3],
        ],
        check: (oracle) => {
            // The live title wins for a listed id, even over a pin that would match.
            expect(oracle.effective('autoFill', '101')).toBe(false);
            expect(oracle.effective('autoJoin', '102')).toBe(false);
            expect(oracle.effective('autoJoinAfterPercentElapsed', '103')).toBe(0);
            expect(oracle.effective('autoJoinWithinHoursOfEnd', '104')).toBe(77);
            // An id off the list is read through its pin.
            expect(oracle.effective('autoFill', '106')).toBe(true);
            expect(oracle.effective('autoFill', '107')).toBe(false);
            expect(['101', '102', '103', '106', '107', '108', '109'].map((id) => oracle.titleOf(id))).toEqual([
                'Macro World: Finals',
                '',
                '',
                'Macro World',
                '',
                '   ',
                '',
            ]);
        },
    },
    {
        name: 'entry pins and a stale pin for a challenge that is gone',
        blob: {
            ...MODERN,
            challengeSettings: {
                entryPins: {
                    '101': { boost: 'e1', turbo: 'e2' },
                    '102': { boost: 'bad id' },
                    '103': { turbo: 'e3', extra: 1 },
                    '104': 'junk',
                    ' 105 ': { boost: 'e5' },
                    '999': { boost: 'e9' },
                },
            },
        },
        check: (oracle) => {
            expect(oracle.entryPin('101')).toEqual({ boost: 'e1', turbo: 'e2' });
            expect(oracle.entryPin('102')).toEqual({ boost: null, turbo: null });
            expect(oracle.entryPin('103')).toEqual({ boost: null, turbo: 'e3' });
            expect(oracle.entryPin('999')).toEqual({ boost: 'e9', turbo: null });
        },
    },
    {
        name: 'containers of the wrong kind: profiles, scenarios, rules, suppressions, pins',
        blob: {
            ...MODERN,
            challengeSettings: {
                profiles: ['Night'],
                scenarios: 'Plan A',
                titleRules: [null, 'junk', 7, [], { title: 'Macro World', autoFill: true }, { profile: 'Night' }],
                titleProfileSuppressions: ['101'],
                entryPins: 'x',
                titlePins: { '101': 'Macro World' },
            },
        },
        check: (oracle) => {
            expect(oracle.effective('autoFill', '101')).toBe(true);
            expect(oracle.ruleProfile('Macro World')).toBeNull();
            expect(oracle.scenarios()).toEqual({});
        },
    },
    {
        name: 'a title-pin container that is an array is read by index',
        blob: {
            ...MODERN,
            challengeSettings: {
                titleRules: [{ title: 'Macro World', autoFill: true }],
                titlePins: ['Macro World'],
            },
        },
        challenges: [],
        offList: ['0'],
        check: (oracle) => {
            expect(oracle.effective('autoFill', '0')).toBe(true);
            expect(oracle.titleOf('0')).toBe('Macro World');
        },
    },
    {
        name: 'setting names of 2.x written into a 1.x file are inert: in a profile, a rule, a scenario phase, a challenge',
        blob: {
            ...MODERN,
            challengeSettings: {
                globalDefaults: { autoSubmit: true },
                profiles: {
                    P: { autoSubmit: true, protectUncertainAutoSubmits: false, exposure: 60, exposureTarget: 70 },
                },
                titleRules: [
                    { title: 'Macro World', profile: 'P', autoSubmit: true },
                    { title: 'Night Sky', autoSubmit: true, autoJoin: true },
                ],
                perChallenge: { '103': { autoSubmit: true, exposure: 80, exposureTarget: 90 } },
                scenarios: {
                    Inert: { name: 'Inert', version: 1, start: 'a', phases: { a: { settings: { autoSubmit: true } } } },
                },
            },
        },
        check: (oracle) => {
            expect(oracle.ruleProfile('Macro World')?.values).toEqual({ exposure: 60, exposureTarget: 70 });
            expect(oracle.ruleValues('Night Sky').values).toEqual({ autoJoin: true });
            expect(oracle.scenarios()).toEqual({});
            expect(oracle.challengeOverrides('103')).toEqual({ exposure: 80, exposureTarget: 90 });
        },
    },
    {
        name: 'a title-pin container that is a string is read by character',
        blob: {
            ...MODERN,
            challengeSettings: {
                titleRules: [{ title: 'b', autoFill: true }],
                titlePins: 'ab',
            },
        },
        challenges: [],
        offList: ['0', '1', '2'],
        check: (oracle) => {
            expect(['0', '1', '2'].map((id) => oracle.titleOf(id))).toEqual(['a', 'b', '']);
            expect(oracle.effective('autoFill', '1')).toBe(true);
            expect(oracle.effective('autoFill', '0')).toBe(false);
        },
    },
    {
        name: 'a stored scenario that does not validate runs nothing, however it is assigned',
        blob: {
            ...MODERN,
            challengeSettings: {
                titleRules: [{ title: 'Macro World', scenario: 'Broken' }],
                perChallenge: { '102': { scenario: 'Plan A' }, '103': { scenario: 'Phantom' } },
                scenarios: {
                    Broken: { name: 'Broken', version: 1, start: 'a', phases: { a: { settings: { scenario: 'x' } } } },
                    'Plan A': { ...PLAN_A, start: 'nowhere' },
                    Phantom: { name: 'Phantom', version: 2, start: 'a', phases: { a: {} } },
                    'Plan B': PLAN_B,
                },
            },
        },
        check: (oracle) => {
            expect(oracle.scenarios()).toEqual({
                'Plan B': { start: 'only', phases: { only: ['autoJoin', 'emergencyFill', 'onlyBoost'] } },
            });
            expect(oracle.scenarioStatus('101').scenario).toBeNull();
        },
    },
];

export { REFERENCES };
