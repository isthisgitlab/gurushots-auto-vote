/**
 * Fixtures for the legacy input of each of the eight load-time migrations of a 1.x file, and for all of them at
 * once: a file the pipeline has to bring up to date before anything is resolved from it.
 */

import { parseJsonObject } from '../../../helpers/parseJson';

import type { Fixture } from './types';

const base = { mustIncludeTags: [], shouldIncludeTags: [] };

const LEGACY: Fixture[] = [
    {
        name: 'migration 1: boost and turbo times written as minutes',
        blob: {
            challengeSettings: {
                globalDefaults: { boostTime: 60, turboTime: 180 },
                perChallenge: { '101': { boostTime: 30, turboTime: 7200 }, '102': { boostTime: 0.5 } },
            },
        },
        check: (oracle) => {
            expect(oracle.effective('boostTime', '103')).toBe(3600);
            expect(oracle.effective('turboTime', '103')).toBe(10800);
            expect(oracle.effective('boostTime', '101')).toBe(1800);
            expect(oracle.effective('turboTime', '101')).toBe(7200);
            expect(oracle.effective('boostTime', '102')).toBe(30);
        },
    },
    {
        name: 'migration 2: emergencyFill written as minutes before close',
        blob: {
            _timeUnitMigratedV1: true,
            challengeSettings: {
                globalDefaults: { emergencyFill: 5 },
                perChallenge: {
                    '101': { emergencyFill: 59 },
                    '102': { emergencyFill: 0 },
                    '103': { emergencyFill: 60 },
                },
            },
        },
        check: (oracle) => {
            expect(oracle.effective('emergencyFill', '104')).toBe(300);
            expect(oracle.effective('emergencyFill', '101')).toBe(3540);
            expect(oracle.effective('emergencyFill', '102')).toBe(0);
            expect(oracle.effective('emergencyFill', '103')).toBe(60);
        },
    },
    {
        name: 'migration 3: the legacy autoFillIntervalMinutes becomes a schedule',
        blob: {
            challengeSettings: {
                globalDefaults: { autoFillIntervalMinutes: 15 },
                perChallenge: {
                    '101': { autoFillIntervalMinutes: 90 },
                    '102': { autoFillIntervalMinutes: 0.5, autoFillSchedule: [{ count: 2, seconds: 5 }] },
                    '103': { autoFillIntervalMinutes: 'x' },
                },
            },
        },
        check: (oracle) => {
            expect(oracle.effective('autoFillSchedule', '104')).toEqual([
                { count: 2, seconds: 2700 },
                { count: 3, seconds: 1800 },
                { count: 4, seconds: 900 },
            ]);
            expect(oracle.effective('autoFillSchedule', '101')).toEqual([
                { count: 2, seconds: 10800 },
                { count: 3, seconds: 7200 },
                { count: 4, seconds: 3600 },
            ]);
            expect(oracle.effective('autoFillSchedule', '102')).toEqual([{ count: 2, seconds: 5 }]);
        },
    },
    {
        name: 'migration 4: an autoFillSchedule outside its bounds is clamped',
        blob: {
            _autoFillScheduleMigratedV1: true,
            challengeSettings: {
                globalDefaults: {
                    autoFillSchedule: [
                        { count: 4, seconds: 10 },
                        { count: 20, seconds: 5 },
                        { count: 2, seconds: 60 },
                    ],
                },
                perChallenge: {
                    '101': { autoFillSchedule: [{ count: 9, seconds: 1 }] },
                    '102': { autoFillSchedule: [{ count: 2, seconds: 60, extra: 1 }] },
                },
            },
        },
        check: (oracle) => {
            expect(oracle.effective('autoFillSchedule', '103')).toEqual([
                { count: 2, seconds: 60 },
                { count: 4, seconds: 10 },
            ]);
            expect(oracle.effective('autoFillSchedule', '101')).toEqual([]);
        },
    },
    {
        name: 'migration 5: scheduled-fill scalars, off sentinels and corrupt scalars in every scope',
        blob: {
            challengeSettings: {
                globalDefaults: { scheduledFillTime: '09:00', scheduledFillBeforeEnd: 7200 },
                perChallenge: {
                    '101': { scheduledFillTime: '', scheduledFillBeforeEnd: 0 },
                    '102': { scheduledFillTime: 'later', scheduledFillBeforeEnd: -3 },
                    '103': { scheduledFillTime: ['10:00'] },
                    '104': { scheduledFillTime: '07:30', scheduledFillBeforeEnd: 600 },
                },
                profiles: parseJsonObject(
                    '{"Night":{"scheduledFillTime":"03:00","scheduledFillBeforeEnd":600},"Off":{"scheduledFillTime":""},"Junk":"x","constructor":{"scheduledFillTime":"01:00"}}',
                ),
                titleRules: [
                    { ...base, title: 'Macro World', profile: 'Night' },
                    { ...base, title: 'Night Sky', profile: 'Off' },
                ],
            },
        },
        check: (oracle) => {
            expect(oracle.effective('scheduledFillTime', '105')).toEqual(['09:00']);
            expect(oracle.effective('scheduledFillBeforeEnd', '105')).toEqual([7200]);
            expect(oracle.effective('scheduledFillTime', '103')).toEqual(['10:00']);
            expect(oracle.effective('scheduledFillTime', '101')).toEqual([]);
            // A corrupt scalar is deleted; the rule's profile holds the explicit off.
            expect(oracle.effective('scheduledFillTime', '102')).toEqual([]);
            expect(oracle.effective('scheduledFillTime', '104')).toEqual(['07:30']);
            expect(oracle.ruleProfile('Macro World')?.values.scheduledFillTime).toEqual(['03:00']);
            expect(oracle.ruleProfile('Night Sky')?.values.scheduledFillTime).toEqual([]);
        },
    },
    {
        name: 'migration 6: scheduled-fill lists out of bounds are deduped, sorted and capped',
        blob: {
            _scheduledFillListsMigratedV1: true,
            challengeSettings: {
                globalDefaults: {
                    scheduledFillTime: ['23:00', '08:00', '08:00'],
                    scheduledFillBeforeEnd: [9, 8, 7, 6, 5, 4, 3, 2, 1],
                },
                perChallenge: {
                    '101': { scheduledFillTime: ['07:00', '06:00', '05:00', '04:00', '03:00', '02:00', '01:00'] },
                },
                profiles: { P: { scheduledFillBeforeEnd: [30, 10, 10] } },
                titleRules: [{ ...base, title: 'Night Sky', profile: 'P' }],
            },
        },
        check: (oracle) => {
            expect(oracle.effective('scheduledFillTime', '103')).toEqual(['08:00', '23:00']);
            expect(oracle.effective('scheduledFillTime', '101')).toEqual([
                '01:00',
                '02:00',
                '03:00',
                '04:00',
                '05:00',
                '06:00',
            ]);
            expect(oracle.effective('scheduledFillBeforeEnd', '102')).toEqual([10, 30]);
        },
    },
    {
        name: 'migration 7: the last-hour exposure keys become the final-window keys',
        blob: {
            challengeSettings: {
                globalDefaults: {
                    useLastHourExposure: true,
                    lastHourExposure: 80,
                    lastHourExposureTarget: 90,
                    voteBeforeLastHour: true,
                    voteBeforeLastHourLeadMin: 20,
                },
                perChallenge: { '101': { lastHourExposure: 70, finalWindowExposure: 60 } },
                profiles: { P: { voteBeforeLastHour: true, useLastHourExposure: true } },
                titleRules: [{ ...base, title: 'Night Sky', profile: 'P' }],
            },
        },
        check: (oracle) => {
            expect(oracle.effective('useFinalWindowExposure', '103')).toBe(true);
            expect(oracle.effective('finalWindowExposure', '103')).toBe(80);
            expect(oracle.effective('finalWindowExposureTarget', '103')).toBe(90);
            expect(oracle.effective('finalWindowExposure', '101')).toBe(60);
            expect(oracle.effective('voteBeforeFinalWindow', '102')).toBe(true);
        },
    },
    {
        name: 'migration 8: category rules become title-less rules below the title rules, which are put in order',
        blob: {
            challengeSettings: {
                titleRules: [
                    { ...base, title: 'portrait', match: 'contains', autoJoinWithinHoursOfEnd: 11, autoFill: true },
                    { ...base, title: 'Portrait Study', autoJoinWithinHoursOfEnd: 22 },
                    { ...base, title: 'night', match: 'starts', challengeTag: 'No comm', profile: 'Night' },
                    { ...base, titles: ['a', 'b'], titleMatchModes: ['contains', 'exact'], pics: 4 },
                    { ...base, title: 'x', closesAtTimes: ['10:00', ' ', '11:00'], minHours: 2 },
                    { ...base, closesAt: '08:00' },
                    { ...base, challengeTag: 'Comm', maxHours: 5000 },
                    { ...base, type: 'flash', autoFill: true },
                    'junk',
                    null,
                ],
                categoryRules: [
                    { type: 'flash', autoJoinWithinHoursOfEnd: 6, extra: 1 },
                    { pics: 4, type: 'default', autoJoinAfterPercentElapsed: 50 },
                    { pics: 2 },
                    5,
                ],
                profiles: { Night: { exposure: 60, exposureTarget: 70, autoFill: true } },
            },
        },
        check: (oracle) => {
            expect(oracle.effective('autoJoinWithinHoursOfEnd', '103')).toBe(22);
            expect(oracle.effective('autoJoinAfterPercentElapsed', '103')).toBe(50);
            expect(oracle.effective('autoJoinWithinHoursOfEnd', '102')).toBe(6);
            expect(oracle.ruleValues({ title: 'Night Sky', tags: ['No comm'] }).profile).toMatchObject({
                name: 'Night',
            });
        },
    },
    {
        name: 'every legacy input at once',
        blob: {
            challengeSettings: {
                globalDefaults: {
                    boostTime: 60,
                    emergencyFill: 5,
                    autoFillIntervalMinutes: 15,
                    scheduledFillTime: '09:00',
                    lastHourExposure: 80,
                },
                perChallenge: {
                    '101': { turboTime: 30, scheduledFillBeforeEnd: 600, useLastHourExposure: true },
                    '102': { emergencyFill: 59, boostTime: 90 },
                },
                titleRules: [
                    { ...base, title: 'b', match: 'contains', autoFill: true },
                    { ...base, title: 'Macro World', autoJoinWithinHoursOfEnd: 5 },
                ],
                categoryRules: [{ type: 'flash' }],
            },
        },
    },
];

export { LEGACY };
