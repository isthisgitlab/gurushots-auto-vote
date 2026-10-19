/**
 * The frozen 1.x load validation and prune, driven through the frozen pipeline: what a 1.x load kept, dropped or
 * reset, and what the obsolete-key prune then removed.
 */

import { interpretV1Settings } from '../../../src/ts/settings/importV1';
import { getV1Defaults } from '../../../src/ts/settings/importV1/defaults';
import {
    dropInvalidV1Values,
    isReservedChallengeId,
    mergeV1WithDefaults,
    pruneV1Obsolete,
} from '../../../src/ts/settings/importV1/loadValidation';
import { parseJsonObject } from '../../helpers/parseJson';

type Values = Record<string, unknown>;

const interpret = (parsed: object) => interpretV1Settings(parsed);
const settingsOf = (blob: Values) =>
    blob.challengeSettings as {
        globalDefaults: Values;
        perChallenge: Record<string, Values>;
        [key: string]: unknown;
    };

describe('merging over the defaults', () => {
    test('an empty file is the defaults', () => {
        expect(mergeV1WithDefaults({})).toEqual(getV1Defaults());
        expect(interpret({}).dropped).toEqual([]);
    });

    test('stored top-level values win, and a stored challengeSettings is completed with the missing containers', () => {
        const merged = mergeV1WithDefaults({
            theme: 'dark',
            challengeSettings: { perChallenge: { '1': { exposure: 90 } } },
        });
        expect(merged.theme).toBe('dark');
        expect(merged.challengeSettings.perChallenge).toEqual({ '1': { exposure: 90 } });
        expect(merged.challengeSettings.titleRules).toEqual([]);
        expect(merged.challengeSettings.globalDefaults).toEqual(getV1Defaults().challengeSettings.globalDefaults);
    });

    test('a challengeSettings that is not an object is kept as stored here, and replaced by the validation', () => {
        expect(mergeV1WithDefaults({ challengeSettings: 'junk' }).challengeSettings).toBe('junk');
        const { blob, dropped } = interpret({ challengeSettings: ['junk'] });
        expect(blob.challengeSettings).toEqual(getV1Defaults().challengeSettings);
        expect(dropped).toEqual(['challengeSettings']);
    });

    test('the mock default follows the environment, as in 1.x', () => {
        const previous = process.env.NODE_ENV;
        try {
            process.env.NODE_ENV = 'development';
            expect(getV1Defaults().mock).toBe(true);
            process.env.NODE_ENV = 'production';
            expect(getV1Defaults().mock).toBe(false);
        } finally {
            process.env.NODE_ENV = previous;
        }
    });

    test('each call gets its own default values', () => {
        const first = getV1Defaults();
        (first.challengeSettings.globalDefaults.ignoreTitleWords as string[]).push('changed');
        expect(getV1Defaults().challengeSettings.globalDefaults.ignoreTitleWords).not.toContain('changed');
    });
});

describe('dropping what a read would misreport', () => {
    test('a top-level value of the wrong type goes back to its default', () => {
        const { blob, dropped } = interpret({
            theme: 5,
            timezone: null,
            customTimezones: ['Europe/Riga', 4],
            stayLoggedIn: 'yes',
            token: 7,
            windowBounds: 'wide',
            apiHeaders: 'not a map',
        });
        const defaults = getV1Defaults();
        expect(blob).toMatchObject({
            theme: defaults.theme,
            timezone: defaults.timezone,
            customTimezones: [],
            stayLoggedIn: false,
            token: '',
        });
        expect(dropped).toEqual(
            expect.arrayContaining(['theme', 'timezone', 'customTimezones', 'stayLoggedIn', 'token']),
        );
        // The map-shaped defaults are left to their owners.
        expect(blob.windowBounds).toBe('wide');
        expect(blob.apiHeaders).toBe('not a map');
    });

    test('a number outside its range goes back to its default', () => {
        const { blob, dropped } = interpret({
            apiTimeout: 0,
            apiMaxRetries: 2.5,
            apiRetryBaseDelayMs: 50,
            checkFrequencyMin: 61,
            checkFrequencyMax: Infinity,
        });
        expect(blob).toMatchObject({
            apiTimeout: 30,
            apiMaxRetries: 3,
            apiRetryBaseDelayMs: 1000,
            checkFrequencyMin: 3,
            checkFrequencyMax: 3,
        });
        expect(dropped).toEqual(
            expect.arrayContaining([
                'apiTimeout',
                'apiMaxRetries',
                'apiRetryBaseDelayMs',
                'checkFrequencyMin',
                'checkFrequencyMax',
            ]),
        );
        expect(interpret({ apiTimeout: 300, apiMaxRetries: 10, checkFrequencyMin: 1 }).dropped).toEqual([]);
    });

    test('a top-level app-state value its schema entry rejects is removed', () => {
        const { blob, dropped } = interpret({
            autovoteRunning: 'yes',
            noticeAcknowledgedVersion: -1,
            skipUpdateVersion: '2.0',
        });
        expect(blob).not.toHaveProperty('autovoteRunning');
        expect(blob).not.toHaveProperty('noticeAcknowledgedVersion');
        expect(blob.skipUpdateVersion).toBe('2.0');
        expect(dropped).toEqual(['autovoteRunning', 'noticeAcknowledgedVersion']);
    });

    test.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
        'a stored %s key is removed from the top level',
        (key) => {
            const { blob, dropped } = interpret(parseJsonObject(`{"theme":"dark","${key}":{"polluted":true}}`));
            expect(Object.hasOwn(blob, key)).toBe(false);
            expect(blob.theme).toBe('dark');
            expect(dropped).toEqual([key]);
            expect(Object.keys(Object.prototype)).toEqual([]);
        },
    );

    test.each(['constructor', '__proto__', 'prototype'])(
        'a per-challenge map under the reserved id %s is removed',
        (id) => {
            const parsed = parseJsonObject(
                `{"challengeSettings":{"perChallenge":{"${id}":{"exposure":90},"7":{"exposure":80}}}}`,
            );
            const { blob, dropped } = interpret(parsed);
            expect(Object.hasOwn(settingsOf(blob).perChallenge, id)).toBe(false);
            expect(settingsOf(blob).perChallenge['7']).toEqual({ exposure: 80 });
            expect(dropped).toEqual([`challengeSettings.perChallenge.${id}`]);
        },
    );

    test('a challengeSettings container of the wrong kind is replaced; a missing one is added silently', () => {
        const { blob, dropped } = interpret({
            challengeSettings: {
                globalDefaults: [],
                perChallenge: 'x',
                titleRules: {},
                titleProfileSuppressions: null,
            },
        });
        const settings = settingsOf(blob);
        expect(settings.globalDefaults).toEqual(getV1Defaults().challengeSettings.globalDefaults);
        expect(settings.perChallenge).toEqual({});
        expect(settings.titleRules).toEqual([]);
        expect(settings.titleProfileSuppressions).toEqual({});
        expect(settings.entryPins).toEqual({});
        // A titleRules that is no list was already made one by the category-rule migration.
        expect(dropped).toEqual([
            'challengeSettings.globalDefaults',
            'challengeSettings.perChallenge',
            'challengeSettings.titleProfileSuppressions',
        ]);
    });

    test('schema values their validator rejects are removed; valid and unknown keys stay until the prune', () => {
        const { blob, dropped } = interpret({
            challengeSettings: {
                globalDefaults: { exposure: 500, autoJoin: 'yes', exposureTarget: 95, mystery: 1 },
                perChallenge: { '1': { exposure: 0, onlyBoost: true, mystery: 2 }, '2': 'junk', '3': 5, '4': [1] },
            },
        });
        const settings = settingsOf(blob);
        expect(settings.globalDefaults).toEqual({ exposureTarget: 95, mystery: 1 });
        expect(settings.perChallenge).toEqual({ '1': { onlyBoost: true, mystery: 2 } });
        expect(dropped).toEqual([
            'challengeSettings.globalDefaults.exposure',
            'challengeSettings.globalDefaults.autoJoin',
            'challengeSettings.perChallenge.1.exposure',
            'challengeSettings.perChallenge.2',
            'challengeSettings.perChallenge.3',
            'challengeSettings.perChallenge.4',
        ]);
    });
});

describe('the prune', () => {
    test('removes boostConfig, unknown global and per-challenge keys, and per-challenge maps left empty', () => {
        const { blob } = interpret({
            boostConfig: { old: true },
            challengeSettings: {
                globalDefaults: { exposure: 90, mystery: 1, autoFillIntervalMinutes: 5 },
                perChallenge: { '1': { mystery: 2 }, '2': { exposure: 80, mystery: 3 }, '3': {} },
            },
        });
        expect(pruneV1Obsolete(blob)).toBe(true);
        expect(blob).not.toHaveProperty('boostConfig');
        expect(settingsOf(blob).globalDefaults).toEqual({
            exposure: 90,
            autoFillSchedule: expect.any(Array),
        });
        expect(settingsOf(blob).perChallenge).toEqual({ '2': { exposure: 80 } });
        expect(pruneV1Obsolete(blob)).toBe(false);
    });

    test('keeps every renamed-away key of the frozen schema (the prune uses the frozen key list)', () => {
        const { blob } = interpret({
            challengeSettings: { globalDefaults: { autoFill: true, notifyOnAutoFill: true } },
        });
        expect(pruneV1Obsolete(blob)).toBe(false);
        expect(settingsOf(blob).globalDefaults).toEqual({ autoFill: true, notifyOnAutoFill: true });
    });

    test('a prototype-named key is not a schema key', () => {
        const blob = getV1Defaults();
        blob.challengeSettings.globalDefaults = parseJsonObject('{"__proto__":1,"exposure":90}');
        expect(pruneV1Obsolete(blob)).toBe(true);
        expect(Object.keys(blob.challengeSettings.globalDefaults)).toEqual(['exposure']);
    });
});

describe('dropInvalidV1Values on a blob', () => {
    test('a clean blob drops nothing', () => {
        expect(dropInvalidV1Values(getV1Defaults())).toEqual([]);
    });

    test('isReservedChallengeId names the three prototype members', () => {
        expect(['__proto__', 'constructor', 'prototype', 'toString', '123'].map(isReservedChallengeId)).toEqual([
            true,
            true,
            true,
            false,
            false,
        ]);
    });
});
