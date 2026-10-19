/**
 * Fixtures for which rules match a challenge: every kind of condition, and the close-time matcher read in the app's
 * timezone (the shared challenges close at 12:00 UTC, 12:30 UTC and 06:00 UTC).
 */

import { at, CHALLENGES, MODERN } from './types';

import type { Fixture } from './types';

const base = { mustIncludeTags: [], shouldIncludeTags: [] };

const closeTimeRules = (...times: string[]) => [
    { title: 'Macro World', closesAt: times[0], autoFill: true },
    { challengeTag: 'Exhibition', closesAtTimes: [times[1], times[0]], autoJoinWithinHoursOfEnd: 111 },
    { type: 'special', closesAtTimes: [' ', ''], closesAt: times[2], autoJoinAfterPercentElapsed: 55 },
    { title: 'Night Sky', closesAt: '25:00', autoJoin: true },
    { title: 'Portrait Study', closesAtTimes: 'x', autoJoin: true },
    { title: 'Street Life', closesAtTimes: ['12:30', 5], autoJoin: true },
];

const MATCHERS: Fixture[] = [
    {
        name: 'close times in Asia/Kolkata (17:30 and 18:00 local)',
        blob: {
            ...MODERN,
            timezone: 'Asia/Kolkata',
            challengeSettings: { titleRules: closeTimeRules('17:30', '18:00', '18:00') },
        },
        check: (oracle) => {
            expect(oracle.effective('autoFill', '101')).toBe(true);
            expect(oracle.effective('autoJoinWithinHoursOfEnd', '101')).toBe(111);
            expect(oracle.effective('autoJoinWithinHoursOfEnd', '103')).toBe(0);
            expect(oracle.effective('autoJoinWithinHoursOfEnd', '104')).toBe(111);
            expect(oracle.effective('autoJoinAfterPercentElapsed', '104')).toBe(55);
            expect(oracle.effective('autoJoin', '102')).toBe(false);
            expect(oracle.effective('autoJoin', '103')).toBe(false);
            expect(oracle.effective('autoJoin', '104')).toBe(false);
        },
    },
    {
        name: 'close times in America/New_York (08:00 and 08:30 local)',
        blob: {
            ...MODERN,
            timezone: 'America/New_York',
            challengeSettings: { titleRules: closeTimeRules('08:00', '08:30', '08:30') },
        },
        check: (oracle) => {
            expect(oracle.effective('autoFill', '101')).toBe(true);
            expect(oracle.effective('autoJoinWithinHoursOfEnd', '101')).toBe(111);
            expect(oracle.effective('autoJoinWithinHoursOfEnd', '104')).toBe(111);
        },
    },
    {
        name: 'close times with the default timezone (Riga, 15:00 and 15:30 local) and with an empty timezone setting',
        blob: { ...MODERN, timezone: '', challengeSettings: { titleRules: closeTimeRules('15:00', '15:30', '15:30') } },
        check: (oracle) => {
            expect(oracle.effective('autoFill', '101')).toBe(true);
            expect(oracle.effective('autoJoinWithinHoursOfEnd', '104')).toBe(111);
        },
    },
    {
        name: 'close times in UTC, and the minute a close time falls on',
        blob: {
            ...MODERN,
            timezone: 'UTC',
            challengeSettings: {
                titleRules: [
                    { challengeTag: 'Exhibition', closesAt: '12:00', autoFill: true },
                    { title: 'Street Life', closesAt: '12:30', autoJoinWithinHoursOfEnd: 90 },
                    { title: 'Anonymous', closesAt: '00:00', autoJoin: true },
                ],
            },
        },
        challenges: [...CHALLENGES, { id: '106', title: 'Anonymous', close_time: at(0) }],
        check: (oracle) => {
            expect(oracle.effective('autoFill', '101')).toBe(true);
            expect(oracle.effective('autoFill', '104')).toBe(false);
            expect(oracle.effective('autoJoinWithinHoursOfEnd', '104')).toBe(90);
            expect(oracle.effective('autoJoin', '106')).toBe(true);
        },
    },
    {
        name: 'close times in a zone no clock knows read as UTC',
        blob: {
            ...MODERN,
            timezone: 'Nowhere/Land',
            challengeSettings: {
                titleRules: [
                    { title: 'Macro World', closesAt: '12:00', autoFill: true },
                    { title: 'Night Sky', closesAt: '06:00', autoFill: true },
                ],
            },
        },
        // v2 reads an unknown zone as UTC everywhere, while 1.x read close times in it on the device clock.
        oracleTimezone: 'UTC',
        golden: false,
        check: (oracle) => {
            expect(oracle.effective('autoFill', '101')).toBe(true);
            expect(oracle.effective('autoFill', '102')).toBe(true);
        },
    },
    {
        name: 'every kind of condition: title modes, tag, type, photo count, runtime',
        blob: {
            ...MODERN,
            challengeSettings: {
                titleRules: [
                    { ...base, titles: ['macro', 'night'], titleMatchModes: ['starts', 'contains'], autoFill: true },
                    { ...base, title: 'portrait', match: 'contains', autoJoinWithinHoursOfEnd: 11 },
                    { ...base, title: 'Portrait Study', autoJoinWithinHoursOfEnd: 22 },
                    {
                        ...base,
                        title: 'street life',
                        match: 'starts',
                        challengeTag: 'exhibition',
                        autoJoinAfterPercentElapsed: 33,
                    },
                    { ...base, type: 'FLASH', pics: 2, autoJoinAfterPercentElapsed: 77, chosenPhotosOnly: true },
                    { ...base, pics: 4, minHours: 48, maxHours: 100, chosenPhotosInOrder: true },
                    { ...base, minHours: 1, maxHours: 3, autoJoin: true },
                    { ...base, maxHours: 30, manualPhotosOnly: true },
                    { ...base, pics: 99, autoJoin: true },
                    { ...base, title: '   ', autoJoin: true },
                    {
                        ...base,
                        titles: ['Macro World', 3, null],
                        titleMatchModes: ['weird', 4, 5],
                        autoJoinWithinHoursOfEnd: 44,
                    },
                    { ...base, challengeTag: 'junk', type: '', autoFill: false },
                    {},
                ],
            },
        },
        check: (oracle) => {
            expect(oracle.effective('autoFill', '101')).toBe(true);
            expect(oracle.effective('manualPhotosOnly', '101')).toBe(true);
            expect(oracle.effective('autoJoinWithinHoursOfEnd', '101')).toBe(44);
            expect(oracle.effective('chosenPhotosInOrder', '101')).toBe(false);
            expect(oracle.effective('autoFill', '102')).toBe(true);
            expect(oracle.effective('autoJoinAfterPercentElapsed', '102')).toBe(77);
            expect(oracle.effective('chosenPhotosOnly', '102')).toBe(true);
            expect(oracle.effective('autoJoin', '102')).toBe(true);
            expect(oracle.effective('autoJoinWithinHoursOfEnd', '103')).toBe(11);
            expect(oracle.effective('chosenPhotosInOrder', '103')).toBe(true);
            expect(oracle.effective('autoJoin', '103')).toBe(false);
            expect(oracle.effective('autoJoinAfterPercentElapsed', '104')).toBe(33);
            expect(oracle.effective('manualPhotosOnly', '104')).toBe(true);
            expect(oracle.effective('autoFill', '105')).toBe(false);
        },
    },
    {
        name: 'rule order is precedence: the first matching rule that sets a key wins, per key',
        blob: {
            ...MODERN,
            challengeSettings: {
                profiles: { First: { boostTime: 1, autoFill: true }, Second: { boostTime: 2, autoSwap: true } },
                titleRules: [
                    { ...base, title: 'macro', match: 'contains', profile: 'Second', autoJoin: true },
                    {
                        ...base,
                        title: 'Macro World',
                        profile: 'First',
                        autoFill: false,
                        autoJoinAfterPercentElapsed: 61,
                    },
                    {
                        ...base,
                        challengeTag: 'Exhibition',
                        mustIncludeTags: ['ex'],
                        shouldIncludeTags: ['s1'],
                        autoJoin: false,
                    },
                    { ...base, type: 'default', mustIncludeTags: ['ex', 'def'], shouldIncludeTags: [] },
                ],
            },
        },
        check: (oracle) => {
            expect(oracle.ruleValues('Macro World').profile).toMatchObject({ name: 'Second' });
            expect(oracle.effective('boostTime', '101')).toBe(2);
            expect(oracle.effective('autoFill', '101')).toBe(false);
            expect(oracle.effective('autoJoinAfterPercentElapsed', '101')).toBe(61);
            expect(oracle.effective('autoJoin', '101')).toBe(true);
            expect(
                oracle.ruleTags('mustIncludeTags', { id: '101', title: 'Macro World', tags: ['Exhibition'] }),
            ).toEqual(['ex']);
        },
    },
    {
        name: 'photo tags and ignore words: the base list, a rule list unioned on it, a challenge value',
        blob: {
            ...MODERN,
            challengeSettings: {
                globalDefaults: { mustIncludeTags: ['base', 'dup'], ignoreTitleWords: [] },
                titleRules: [
                    { ...base, title: 'Macro World', mustIncludeTags: ['dup', 'macro'], shouldIncludeTags: ['soft'] },
                    { ...base, title: 'Night Sky', mustIncludeTags: [] },
                ],
                perChallenge: { '103': { mustIncludeTags: ['own'], ignoreTitleWords: ['study'] } },
            },
        },
        check: (oracle) => {
            expect(oracle.ruleTags('mustIncludeTags', CHALLENGES[0])).toEqual(['base', 'dup', 'macro']);
            expect(oracle.ruleTags('mustIncludeTags', CHALLENGES[1])).toEqual(['base', 'dup']);
            expect(oracle.ruleTags('shouldIncludeTags', CHALLENGES[0])).toEqual(['soft']);
            expect(oracle.ruleTags('mustIncludeTags', CHALLENGES[2])).toEqual(['own']);
            expect(oracle.ignoreTitleWords(CHALLENGES[0])).toBeNull();
            expect(oracle.ignoreTitleWords(CHALLENGES[2])).toEqual(['study']);
        },
    },
    {
        name: 'auto-join: arming through a rule or its profile, and the opt-in that bypasses the type filter',
        blob: {
            ...MODERN,
            challengeSettings: {
                globalDefaults: { autoJoinTypes: 'flash', autoJoinExcludeTypes: 'special' },
                profiles: {
                    Joiner: { autoJoin: true, autoJoinWithinHoursOfEnd: 6 },
                    Quiet: { exposure: 60, exposureTarget: 70 },
                },
                titleRules: [
                    { ...base, type: 'default', profile: 'Quiet' },
                    { ...base, title: 'Macro World', profile: 'Quiet', autoJoinMaxCoins: 40 },
                    { ...base, challengeTag: 'Comm', autoJoinWithinHoursOfEnd: 12 },
                    { ...base, title: 'Brand New Theme', profile: 'Joiner' },
                    { ...base, title: 'night sky', autoJoin: false, profile: 'Joiner' },
                ],
                perChallenge: { '901': { manualPhotosOnly: true, chosenPhotosOnly: true } },
            },
        },
        check: (oracle) => {
            expect(oracle.anyRuleEnablesAutoJoin()).toBe(true);
            expect(oracle.autoJoinActive()).toBe(true);
            expect(oracle.ruleJoinOptIn({ title: 'Macro World' })).toBe(true);
            expect(oracle.ruleJoinOptIn({ title: 'Anonymous', type: 'default' })).toBe(false);
            expect(oracle.ruleJoinOptIn({ title: 'Brand New Theme' })).toBe(true);
            expect(oracle.joinSetting('autoJoinWithinHoursOfEnd', { title: 'Brand New Theme' })).toBe(6);
            expect(oracle.joinSetting('manualPhotosOnly', { id: '901', title: 'x' })).toBe(true);
        },
    },
];

export { MATCHERS };
