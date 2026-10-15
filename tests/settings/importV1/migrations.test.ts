/**
 * The eight frozen 1.x migrations, each fed its legacy input through the frozen pipeline (merge over the defaults,
 * migrations, load validation). The same inputs run against the live loader in parity.test.ts.
 */

import { interpretV1Settings } from '../../../src/ts/settings/importV1';
import { V1_MIGRATION_FLAGS } from '../../../src/ts/settings/importV1/migrations';

type Values = Record<string, unknown>;

const run = (blob: Values) => interpretV1Settings(blob).blob;
const withSettings = (challengeSettings: Values, extra: Values = {}) => run({ challengeSettings, ...extra });
const globalsOf = (blob: Values) => (blob.challengeSettings as { globalDefaults: Values }).globalDefaults;
const perChallengeOf = (blob: Values) =>
    (blob.challengeSettings as { perChallenge: Record<string, Values> }).perChallenge;
const profilesOf = (blob: Values) => (blob.challengeSettings as { profiles: Record<string, Values> }).profiles;
const rulesOf = (blob: Values) => (blob.challengeSettings as { titleRules: unknown[] }).titleRules;

describe('every pass sets its flag and a second run changes nothing', () => {
    test('a blob with legacy input migrates once', () => {
        const first = run({ challengeSettings: { globalDefaults: { boostTime: 60 } } });
        expect(V1_MIGRATION_FLAGS.every((flag) => first[flag] === true)).toBe(true);
        const again = interpretV1Settings(first).blob;
        expect(again).toEqual(first);
    });
});

describe('minute-encoded boost and turbo times', () => {
    test('global and per-challenge values below 1440 become seconds; seconds-range values stay', () => {
        const blob = withSettings({
            globalDefaults: { boostTime: 60, turboTime: 180 },
            perChallenge: { '1': { boostTime: 30, turboTime: 7200 }, '2': { boostTime: 3600 } },
        });
        expect(globalsOf(blob)).toMatchObject({ boostTime: 3600, turboTime: 10800 });
        expect(perChallengeOf(blob)['1']).toEqual({ boostTime: 1800, turboTime: 7200 });
        expect(perChallengeOf(blob)['2']).toEqual({ boostTime: 3600 });
    });

    test('a pass already done leaves the values alone', () => {
        const blob = withSettings(
            { globalDefaults: { boostTime: 60 }, perChallenge: { '1': { boostTime: 30 } } },
            { _timeUnitMigratedV1: true },
        );
        expect(globalsOf(blob).boostTime).toBe(60);
        expect(perChallengeOf(blob)['1'].boostTime).toBe(30);
    });

    test('missing containers are tolerated', () => {
        expect(() => withSettings({ globalDefaults: null, perChallenge: null })).not.toThrow();
        expect(() => run({ challengeSettings: 'junk' })).not.toThrow();
    });
});

describe('minute-encoded emergencyFill', () => {
    test('values in (0, 60) become seconds; 0 and seconds-range values stay', () => {
        const blob = withSettings({
            globalDefaults: { emergencyFill: 5 },
            perChallenge: { '1': { emergencyFill: 59 }, '2': { emergencyFill: 0 }, '3': { emergencyFill: 300 } },
        });
        expect(globalsOf(blob).emergencyFill).toBe(300);
        expect(perChallengeOf(blob)['1'].emergencyFill).toBe(3540);
        expect(perChallengeOf(blob)['2'].emergencyFill).toBe(0);
        expect(perChallengeOf(blob)['3'].emergencyFill).toBe(300);
    });

    test('a pass already done leaves the values alone', () => {
        const blob = withSettings({ globalDefaults: { emergencyFill: 5 } }, { _emergencyFillTimeMigratedV1: true });
        expect(globalsOf(blob).emergencyFill).toBe(5);
    });
});

describe('autoFillIntervalMinutes becomes autoFillSchedule', () => {
    test('derives the schedule from the stored interval, in every scope, and drops the legacy key', () => {
        const blob = withSettings({
            globalDefaults: { autoFillIntervalMinutes: 15 },
            perChallenge: { '1': { autoFillIntervalMinutes: 90 }, '2': { autoFillIntervalMinutes: 0.5 } },
        });
        expect(globalsOf(blob).autoFillSchedule).toEqual([
            { count: 2, seconds: 2700 },
            { count: 3, seconds: 1800 },
            { count: 4, seconds: 900 },
        ]);
        expect(perChallengeOf(blob)['1'].autoFillSchedule).toEqual([
            { count: 2, seconds: 10800 },
            { count: 3, seconds: 7200 },
            { count: 4, seconds: 3600 },
        ]);
        expect(perChallengeOf(blob)['2']).toEqual({});
        expect(globalsOf(blob)).not.toHaveProperty('autoFillIntervalMinutes');
    });

    test('an existing schedule is kept over the legacy interval', () => {
        const schedule = [{ count: 2, seconds: 100 }];
        const blob = withSettings({ globalDefaults: { autoFillIntervalMinutes: 15, autoFillSchedule: schedule } });
        expect(globalsOf(blob).autoFillSchedule).toEqual(schedule);
    });

    test('a pass already done leaves the legacy key alone', () => {
        const blob = withSettings(
            { globalDefaults: { autoFillIntervalMinutes: 15 } },
            { _autoFillScheduleMigratedV1: true },
        );
        expect(globalsOf(blob)).toHaveProperty('autoFillIntervalMinutes', 15);
    });
});

describe('autoFillSchedule bounds', () => {
    test('rows outside the bounds are healed, in every scope', () => {
        const blob = withSettings(
            {
                globalDefaults: {
                    autoFillSchedule: [
                        { count: 4, seconds: 10 },
                        { count: 20, seconds: 5 },
                        { count: 2, seconds: 60 },
                    ],
                },
                perChallenge: { '1': { autoFillSchedule: [{ count: 9, seconds: 1 }] }, '2': { exposure: 90 } },
            },
            { _autoFillScheduleMigratedV1: true },
        );
        expect(globalsOf(blob).autoFillSchedule).toEqual([
            { count: 2, seconds: 60 },
            { count: 4, seconds: 10 },
        ]);
        expect(perChallengeOf(blob)['1'].autoFillSchedule).toEqual([]);
        expect(perChallengeOf(blob)['2']).toEqual({ exposure: 90 });
    });

    test('a pass already done leaves the rows alone', () => {
        const rows = [{ count: 20, seconds: 5 }];
        const blob = withSettings(
            { globalDefaults: { autoFillSchedule: rows } },
            { _autoFillScheduleMigratedV1: true, _autoFillScheduleBoundsV1: true },
        );
        // Load validation then drops the row set the validator rejects; the bounds pass did not heal it.
        expect(globalsOf(blob)).not.toHaveProperty('autoFillSchedule');
    });
});

describe('scheduled-fill scalars become lists', () => {
    test('valid scalars become one-entry lists in every scope, profiles included', () => {
        const blob = withSettings({
            globalDefaults: { scheduledFillTime: '09:00', scheduledFillBeforeEnd: 7200 },
            perChallenge: { '1': { scheduledFillTime: '21:30', scheduledFillBeforeEnd: 600 } },
            profiles: { Night: { scheduledFillTime: '03:00' }, Broken: 'junk', Listy: ['x'] },
        });
        expect(globalsOf(blob)).toMatchObject({ scheduledFillTime: ['09:00'], scheduledFillBeforeEnd: [7200] });
        expect(perChallengeOf(blob)['1']).toEqual({ scheduledFillTime: ['21:30'], scheduledFillBeforeEnd: [600] });
        expect(profilesOf(blob).Night).toEqual({ scheduledFillTime: ['03:00'] });
        expect(profilesOf(blob).Broken).toBe('junk');
    });

    test('an off sentinel is dropped globally and kept as an explicit empty list elsewhere', () => {
        const blob = withSettings({
            globalDefaults: { scheduledFillTime: '', scheduledFillBeforeEnd: 0 },
            perChallenge: { '1': { scheduledFillTime: '', scheduledFillBeforeEnd: 0 } },
            profiles: { Off: { scheduledFillTime: '', scheduledFillBeforeEnd: 0 } },
        });
        expect(globalsOf(blob)).not.toHaveProperty('scheduledFillTime');
        expect(globalsOf(blob)).not.toHaveProperty('scheduledFillBeforeEnd');
        expect(perChallengeOf(blob)['1']).toEqual({ scheduledFillTime: [], scheduledFillBeforeEnd: [] });
        expect(profilesOf(blob).Off).toEqual({ scheduledFillTime: [], scheduledFillBeforeEnd: [] });
    });

    test('a corrupt scalar is deleted in every scope; an existing list is kept', () => {
        const blob = withSettings({
            globalDefaults: { scheduledFillTime: 'later', scheduledFillBeforeEnd: 1.5 },
            perChallenge: {
                '1': { scheduledFillTime: 'later', scheduledFillBeforeEnd: -4 },
                '2': { scheduledFillTime: ['10:00'] },
            },
        });
        expect(perChallengeOf(blob)['1']).toEqual({});
        expect(perChallengeOf(blob)['2']).toEqual({ scheduledFillTime: ['10:00'] });
        expect(globalsOf(blob)).not.toHaveProperty('scheduledFillTime');
        expect(globalsOf(blob)).not.toHaveProperty('scheduledFillBeforeEnd');
    });

    test('a profile named like a prototype member is skipped', () => {
        const profiles: unknown = JSON.parse(
            '{"constructor":{"scheduledFillTime":"01:00"},"__proto__":{"scheduledFillTime":"02:00"}}',
        );
        const blob = withSettings({ profiles });
        expect(Object.keys(profilesOf(blob))).toEqual(['constructor', '__proto__']);
        expect(profilesOf(blob).constructor).toEqual({ scheduledFillTime: '01:00' });
        expect(Object.getOwnPropertyDescriptor(profilesOf(blob), '__proto__')?.value).toEqual({
            scheduledFillTime: '02:00',
        });
    });

    test('a pass already done leaves the scalars alone (load validation then drops them)', () => {
        const blob = withSettings(
            { globalDefaults: { scheduledFillTime: '09:00' } },
            { _scheduledFillListsMigratedV1: true },
        );
        expect(globalsOf(blob)).not.toHaveProperty('scheduledFillTime');
    });
});

describe('scheduled-fill list bounds', () => {
    test('lists are deduped, sorted and capped in every scope', () => {
        const blob = withSettings(
            {
                globalDefaults: {
                    scheduledFillTime: ['23:00', '08:00', '08:00'],
                    scheduledFillBeforeEnd: [9, 8, 7, 6, 5, 4, 3, 2, 1],
                },
                perChallenge: {
                    '1': { scheduledFillTime: ['07:00', '06:00', '05:00', '04:00', '03:00', '02:00', '01:00'] },
                },
                profiles: { P: { scheduledFillBeforeEnd: [30, 10, 10] } },
            },
            { _scheduledFillListsMigratedV1: true },
        );
        expect(globalsOf(blob).scheduledFillTime).toEqual(['08:00', '23:00']);
        expect(globalsOf(blob).scheduledFillBeforeEnd).toEqual([1, 2, 3, 4, 5, 6]);
        expect(perChallengeOf(blob)['1'].scheduledFillTime).toEqual([
            '01:00',
            '02:00',
            '03:00',
            '04:00',
            '05:00',
            '06:00',
        ]);
        expect(profilesOf(blob).P.scheduledFillBeforeEnd).toEqual([10, 30]);
    });

    test('a pass already done leaves the lists alone (load validation drops what it rejects)', () => {
        const blob = withSettings(
            { globalDefaults: { scheduledFillTime: ['23:00', '08:00', '08:00'] } },
            { _scheduledFillListsMigratedV1: true, _scheduledFillListBoundsV1: true },
        );
        expect(globalsOf(blob)).not.toHaveProperty('scheduledFillTime');
    });
});

describe('last-hour exposure keys become final-window keys', () => {
    test('every scope is renamed; an existing new-key value wins over the legacy one', () => {
        const blob = withSettings({
            globalDefaults: {
                useLastHourExposure: true,
                lastHourExposure: 80,
                lastHourExposureTarget: 90,
                voteBeforeLastHour: true,
                voteBeforeLastHourLeadMin: 20,
            },
            perChallenge: { '1': { lastHourExposure: 70, finalWindowExposure: 60 } },
            profiles: { P: { voteBeforeLastHour: true } },
        });
        expect(globalsOf(blob)).toMatchObject({
            useFinalWindowExposure: true,
            finalWindowExposure: 80,
            finalWindowExposureTarget: 90,
            voteBeforeFinalWindow: true,
            voteBeforeFinalWindowLeadMin: 20,
        });
        expect(globalsOf(blob)).not.toHaveProperty('lastHourExposure');
        expect(perChallengeOf(blob)['1']).toEqual({ finalWindowExposure: 60 });
        expect(profilesOf(blob).P).toEqual({ voteBeforeFinalWindow: true });
    });

    test('a pass already done leaves the legacy keys alone', () => {
        const blob = withSettings(
            { globalDefaults: { lastHourExposure: 80 } },
            { _finalWindowExposureRenamedV1: true },
        );
        expect(globalsOf(blob)).toHaveProperty('lastHourExposure', 80);
    });
});

describe('category rules move into the challenge rules', () => {
    const titled = (title: string, extra: Values = {}) => ({
        title,
        mustIncludeTags: [],
        shouldIncludeTags: [],
        ...extra,
    });

    test('title rules are put in the default order and category rules follow as title-less rules', () => {
        const blob = withSettings({
            titleRules: [
                titled('portrait', { match: 'contains' }),
                titled('Macro'),
                titled('night', { match: 'starts', challengeTag: 'Exhibition' }),
                { title: '', type: 'flash' },
                'junk',
                null,
            ],
            categoryRules: [
                { type: 'flash', autoJoinWithinHoursOfEnd: 6, ignored: true },
                { pics: 4, type: 'default' },
                { pics: 2 },
                5,
                null,
            ],
        });
        expect(rulesOf(blob)).toEqual([
            titled('night', { match: 'starts', challengeTag: 'Exhibition' }),
            titled('Macro'),
            titled('portrait', { match: 'contains' }),
            { title: '', type: 'flash' },
            { title: '', mustIncludeTags: [], shouldIncludeTags: [], pics: 4, type: 'default' },
            { title: '', mustIncludeTags: [], shouldIncludeTags: [], type: 'flash', autoJoinWithinHoursOfEnd: 6 },
            { title: '', mustIncludeTags: [], shouldIncludeTags: [], pics: 2 },
        ]);
        expect(blob.challengeSettings).not.toHaveProperty('categoryRules');
    });

    test('rules with several titles, modes and class conditions sort by specificity', () => {
        const rules = [
            { titles: ['a', 'b'], titleMatchModes: ['contains', 'exact'] },
            { title: 'x', closesAt: '10:00', minHours: 2 },
            { title: 'x', closesAtTimes: ['10:00', ' ', '11:00'], pics: 4 },
            { title: 'y', closesAtTimes: 'not a list' },
            { title: 'z', titleMatchModes: 'bad', match: 'weird' },
            { title: 'w', closesAt: '25:99', maxHours: 5000 },
            { title: 'v', closesAtTimes: [1] },
            { title: 'u', closesAtTimes: ['bad'] },
            { title: 'q', titleMatchModes: ['weird', 4], pics: '' },
            { title: 'p', pics: 99 },
            { type: 'flash' },
            { challengeTag: 'Comm' },
            { pics: '3', maxHours: 10 },
            { closesAt: '08:00' },
            { title: '  ' },
        ];
        const sorted = rulesOf(withSettings({ titleRules: rules }));
        expect(sorted).toHaveLength(rules.length);
        expect(sorted).toEqual(expect.arrayContaining(rules));
        // Titled rules come first; a rule with no condition is last.
        expect(sorted[sorted.length - 1]).toEqual({ title: '  ' });
    });

    test('without a titleRules or categoryRules list there is just an empty rule list', () => {
        const blob = withSettings({ titleRules: 'junk', categoryRules: 'junk' });
        expect(rulesOf(blob)).toEqual([]);
    });

    test('a pass already done leaves the rules and the category list alone', () => {
        const rules = [titled('b'), titled('a', { match: 'contains' })];
        const blob = withSettings(
            { titleRules: rules, categoryRules: [{ type: 'flash' }] },
            { _challengeRulesOrderedV1: true },
        );
        expect(rulesOf(blob)).toEqual(rules);
        expect(blob.challengeSettings).toHaveProperty('categoryRules');
    });

    test('a challengeSettings that is not an object is left to load validation', () => {
        expect(rulesOf(run({ challengeSettings: 'junk' }))).toEqual([]);
    });
});

describe('a blob a pass cannot handle', () => {
    test('throws, as the 1.x loader did', () => {
        expect(() => withSettings({ perChallenge: { '1': null } })).toThrow(TypeError);
    });
});
