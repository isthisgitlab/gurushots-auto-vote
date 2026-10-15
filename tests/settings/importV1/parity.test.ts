/**
 * The frozen 1.x pipeline against the live loader, as of the freeze: for representative 1.x files (one per migration's
 * legacy input among them) the frozen merge, migrations and load validation give what the live `loadSettings` returns
 * for the same text, and the frozen prune gives what its next read returns. The proof the snapshot is faithful when it
 * is taken; deleted together with the live pipeline it compares to.
 */

import { interpretV1Settings, parseV1Settings } from '../../../src/ts/settings/importV1';
import { pruneV1Obsolete } from '../../../src/ts/settings/importV1/loadValidation';
import { V1_SETTINGS_SCHEMA } from '../../../src/ts/settings/importV1/schema';
import { parseJsonObject } from '../../helpers/parseJson';
import type * as settingsModule from '../../../src/ts/settings';
import type * as liveSchemaModule from '../../../src/ts/settings/schema';
import type { AndroidHeadlessStore, AppSettings } from '../../../src/ts/types/settings';

// The live loader looks for an Electron app; none exists here, and the real package would try to fetch its binary.
jest.mock('electron', () => ({}));

type Values = Record<string, unknown>;

const g = globalThis as typeof globalThis & {
    __GS_HEADLESS__?: boolean;
    AndroidHeadlessStore?: AndroidHeadlessStore;
};

type Live = {
    first: AppSettings;
    second: AppSettings;
    recovery: ReturnType<typeof settingsModule.getSettingsRecovery>;
};

/**
 * What the live loader returns for `raw` read from an in-memory store: the first read (merged, migrated, validated),
 * and the second, after the once-per-process obsolete-key prune.
 */
const loadLive = (raw: string): Live => {
    let result: Live | null = null;
    jest.isolateModules(() => {
        let stored = raw;
        g.__GS_HEADLESS__ = true;
        g.AndroidHeadlessStore = {
            read: () => stored,
            write: (data) => {
                stored = data;
            },
        };
        const settings = require('../../../src/ts/settings') as typeof settingsModule;
        const first = settings.loadSettings();
        const second = settings.loadSettings();
        result = { first, second, recovery: settings.getSettingsRecovery() };
    });
    if (!result) throw new Error('the live loader did not run');
    return result;
};

const FLAGS = {
    _timeUnitMigratedV1: true,
    _emergencyFillTimeMigratedV1: true,
    _autoFillScheduleMigratedV1: true,
    _autoFillScheduleBoundsV1: true,
    _scheduledFillListsMigratedV1: true,
    _scheduledFillListBoundsV1: true,
    _finalWindowExposureRenamedV1: true,
    _challengeRulesOrderedV1: true,
};

const titled = (title: string, extra: Values = {}) => ({ title, mustIncludeTags: [], shouldIncludeTags: [], ...extra });

const BLOBS: Record<string, Values> = {
    'an empty file': {},
    'a modern file with every container filled and no migration left': {
        ...FLAGS,
        theme: 'dark',
        language: 'lv',
        timezone: 'Europe/London',
        customTimezones: ['Europe/London'],
        token: 'tok',
        lastUsername: 'me',
        apiHeaders: { 'x-a': 'b' },
        chosenPhotosMemberId: 'm-1',
        autovoteRunning: true,
        notifyOnAutoFill: true,
        windowBounds: { login: { width: 1, height: 2 }, main: { x: 5, y: 6, width: 3, height: 4 } },
        challengeSettings: {
            globalDefaults: { exposure: 80, autoFill: true, emergencyFill: 600, scenario: 'Plan' },
            perChallenge: { '1': { exposure: 70, boostFillNew: true }, '2': { scenario: 'Plan' } },
            titleRules: [titled('Macro', { profile: 'Night', autoFill: true }), { type: 'flash', autoJoin: true }],
            titleProfileSuppressions: { '1': true, '2': false },
            entryPins: { '1': { boost: 'e1' } },
            profiles: { Night: { exposure: 60, autoFill: true } },
            seededProfiles: ['night'],
            scenarios: {
                Plan: { name: 'Plan', version: 1, start: 'a', phases: { a: { settings: { autoFill: true } } } },
            },
            titlePins: { '1': 'Macro' },
        },
    },
    'legacy minute-encoded boost and turbo times': {
        challengeSettings: {
            globalDefaults: { boostTime: 60, turboTime: 180 },
            perChallenge: { '1': { boostTime: 30, turboTime: 7200 } },
        },
    },
    'legacy minute-encoded emergencyFill': {
        _timeUnitMigratedV1: true,
        challengeSettings: {
            globalDefaults: { emergencyFill: 5 },
            perChallenge: { '1': { emergencyFill: 59 }, '2': { emergencyFill: 0 } },
        },
    },
    'legacy autoFillIntervalMinutes': {
        challengeSettings: {
            globalDefaults: { autoFillIntervalMinutes: 15 },
            perChallenge: {
                '1': { autoFillIntervalMinutes: 90 },
                '2': { autoFillIntervalMinutes: 0.5, autoFillSchedule: [{ count: 2, seconds: 5 }] },
            },
        },
    },
    'autoFillSchedule outside the bounds': {
        _autoFillScheduleMigratedV1: true,
        challengeSettings: {
            globalDefaults: {
                autoFillSchedule: [
                    { count: 4, seconds: 10 },
                    { count: 20, seconds: 5 },
                    { count: 2, seconds: 60 },
                ],
            },
            perChallenge: { '1': { autoFillSchedule: [{ count: 9, seconds: 1 }] } },
        },
    },
    'legacy scheduled-fill scalars, off sentinels and corrupt scalars in every scope': {
        challengeSettings: {
            globalDefaults: { scheduledFillTime: '09:00', scheduledFillBeforeEnd: 7200 },
            perChallenge: {
                '1': { scheduledFillTime: '', scheduledFillBeforeEnd: 0 },
                '2': { scheduledFillTime: 'later', scheduledFillBeforeEnd: -3 },
                '3': { scheduledFillTime: ['10:00'] },
            },
            profiles: parseJsonObject(
                '{"Night":{"scheduledFillTime":"03:00","scheduledFillBeforeEnd":600},"Off":{"scheduledFillTime":""},"Junk":"x","constructor":{"scheduledFillTime":"01:00"}}',
            ),
        },
    },
    'scheduled-fill lists out of bounds': {
        _scheduledFillListsMigratedV1: true,
        challengeSettings: {
            globalDefaults: {
                scheduledFillTime: ['23:00', '08:00', '08:00'],
                scheduledFillBeforeEnd: [9, 8, 7, 6, 5, 4, 3, 2, 1],
            },
            perChallenge: {
                '1': { scheduledFillTime: ['07:00', '06:00', '05:00', '04:00', '03:00', '02:00', '01:00'] },
            },
            profiles: { P: { scheduledFillBeforeEnd: [30, 10, 10] } },
        },
    },
    'last-hour exposure keys': {
        challengeSettings: {
            globalDefaults: {
                useLastHourExposure: true,
                lastHourExposure: 80,
                lastHourExposureTarget: 90,
                voteBeforeLastHour: true,
                voteBeforeLastHourLeadMin: 20,
            },
            perChallenge: { '1': { lastHourExposure: 70, finalWindowExposure: 60 } },
            profiles: { P: { voteBeforeLastHour: true } },
        },
    },
    'category rules and unordered title rules': {
        challengeSettings: {
            titleRules: [
                titled('portrait', { match: 'contains' }),
                titled('Macro', { closesAt: '10:00' }),
                titled('night', { match: 'starts', challengeTag: 'Exhibition', profile: 'Night' }),
                { titles: ['a', 'b'], titleMatchModes: ['contains', 'exact'], pics: 4 },
                { title: 'x', closesAtTimes: ['10:00', ' ', '11:00'], minHours: 2 },
                { title: 'y', closesAtTimes: 'not a list' },
                { closesAt: '08:00' },
                { challengeTag: 'Comm', maxHours: 5000 },
                { type: 'flash', autoFill: true },
                { title: 'q', titleMatchModes: ['weird', 4], pics: '' },
                { title: 'p', pics: 99 },
                'junk',
                null,
            ],
            categoryRules: [
                { type: 'flash', autoJoinWithinHoursOfEnd: 6, extra: 1 },
                { pics: 4, type: 'default' },
                { pics: 2 },
                5,
            ],
            profiles: { Night: { autoFill: true } },
        },
    },
    'every legacy input at once': {
        challengeSettings: {
            globalDefaults: {
                boostTime: 60,
                emergencyFill: 5,
                autoFillIntervalMinutes: 15,
                scheduledFillTime: '09:00',
                lastHourExposure: 80,
            },
            perChallenge: { '1': { turboTime: 30, scheduledFillBeforeEnd: 600, useLastHourExposure: true } },
            titleRules: [titled('b'), titled('a', { match: 'contains' })],
            categoryRules: [{ type: 'flash' }],
        },
    },
    'values the load validation drops': {
        ...FLAGS,
        theme: 5,
        timezone: null,
        customTimezones: ['Europe/Riga', 4],
        stayLoggedIn: 'yes',
        token: 7,
        apiTimeout: 0,
        apiMaxRetries: 2.5,
        apiRetryBaseDelayMs: 50,
        checkFrequencyMin: 61,
        checkFrequencyMax: Infinity,
        autovoteRunning: 'yes',
        noticeAcknowledgedVersion: -1,
        challengeSettings: {
            globalDefaults: { exposure: 500, autoJoin: 'yes', exposureTarget: 95 },
            perChallenge: { '1': { exposure: 0, onlyBoost: true }, '2': 'junk', '3': 5, '4': [1] },
        },
    },
    'containers of the wrong kind': {
        ...FLAGS,
        challengeSettings: { globalDefaults: [], perChallenge: 'x', titleRules: {}, titleProfileSuppressions: null },
    },
    'a challengeSettings that is not an object': { ...FLAGS, challengeSettings: ['junk'] },
    'keys the 1.x schema does not define': {
        ...FLAGS,
        boostConfig: { old: true },
        futureKey: [1],
        challengeSettings: {
            globalDefaults: { exposure: 90, mystery: 1 },
            perChallenge: { '1': { mystery: 2 }, '2': { exposure: 80, mystery: 3 }, '3': {} },
        },
    },
    'keys named like prototype members': parseJsonObject(
        `{"theme":"dark","toString":1,"__proto__":{"polluted":true},"challengeSettings":{"perChallenge":{"constructor":{"exposure":90},"7":{"exposure":80}},"globalDefaults":{"__proto__":1,"exposure":90}}}`,
    ),
};

describe('the frozen pipeline against the live loader', () => {
    afterAll(() => {
        delete g.__GS_HEADLESS__;
        delete g.AndroidHeadlessStore;
    });

    test.each(Object.entries(BLOBS))('%s', (_name, blob) => {
        const raw = JSON.stringify(blob);
        const live = loadLive(raw);
        const parsed = parseV1Settings(raw);
        if (!parsed.ok) throw new Error(parsed.reason);

        const { blob: frozen } = interpretV1Settings(parsed.value);
        expect(live.recovery).toBeNull();
        expect(frozen).toEqual(live.first);

        pruneV1Obsolete(frozen);
        expect(frozen).toEqual(live.second);
        expect(Object.keys(Object.prototype)).toEqual([]);
    });

    test('a file a migration cannot handle fails in both', () => {
        const raw = JSON.stringify({ challengeSettings: { perChallenge: { '1': null } } });
        const parsed = parseV1Settings(raw);
        if (!parsed.ok) throw new Error(parsed.reason);
        expect(() => interpretV1Settings(parsed.value)).toThrow(TypeError);
        expect(loadLive(raw).recovery).toMatchObject({ code: 'settings-migration-failed' });
    });

    test.each([
        ['text that is not JSON', 'not json {'],
        ['an array root', '[1]'],
        ['a null root', 'null'],
    ])('%s is no settings object in both', (_name, raw) => {
        expect(parseV1Settings(raw).ok).toBe(false);
        expect(loadLive(raw).recovery?.code).toMatch(/^settings-(corrupt|unreadable)$/);
    });
});

describe('the frozen schema flags against the live schema', () => {
    const live = require('../../../src/ts/settings/schema') as typeof liveSchemaModule;
    const keys = Object.keys(V1_SETTINGS_SCHEMA);

    test.each(keys)('%s has the live resolver flags', (key) => {
        const frozen: { perChallenge: boolean; challengeOnly?: true; dependsOn?: readonly string[] } =
            V1_SETTINGS_SCHEMA[key as keyof typeof V1_SETTINGS_SCHEMA];
        const entry = live.schemaEntry(key);
        expect([key, frozen.perChallenge]).toEqual([key, entry?.perChallenge]);
        expect([key, frozen.challengeOnly === true]).toEqual([key, entry?.challengeOnly === true]);
        expect([key, frozen.dependsOn ?? []]).toEqual([key, entry?.dependsOn ?? []]);
    });

    test('the keys with a cross-field check are the keys with dependencies', () => {
        const withCheck = keys.filter((key) => live.schemaEntry(key)?.contextValidation !== undefined);
        const withDependencies = keys.filter(
            (key) => 'dependsOn' in V1_SETTINGS_SCHEMA[key as keyof typeof V1_SETTINGS_SCHEMA],
        );
        expect(withCheck).toEqual(withDependencies);
    });
});
