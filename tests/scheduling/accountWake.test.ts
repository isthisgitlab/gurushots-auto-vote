/**
 * The Node resolvers of the account's own scheduling boundaries and of a phase's resolved schedule
 * (src/ts/core/scheduling/nodeResolvers.ts), over the real settings facade, the real progress ledger and the in-memory
 * headless store; only the evidence caches (the claim throttle, the last mission read) are stood in for.
 */

jest.mock('../../src/ts/core/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        api: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        challengeTag: jest.fn((c: { id?: string | number } | null | undefined) => `[${c?.id}]`),
        withCategory: jest.fn(() => category),
    };
});
jest.mock('../../src/ts/core/settings', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/core/settings')>('../../src/ts/core/settings'),
}));
jest.mock('../../src/ts/core/services/autoClaim', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/core/services/autoClaim')>(
        '../../src/ts/core/services/autoClaim',
    ),
    getAutoClaimStatus: jest.fn(() => ({ enabled: false, nextClaimAt: 0 })),
}));
jest.mock('../../src/ts/core/services/missions', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/core/services/missions')>('../../src/ts/core/services/missions'),
    getNextMissionExpiry: jest.fn(() => null),
}));

import settings = require('../../src/ts/core/settings');
import storageModule = require('../../src/ts/core/settings/storage');
import autoClaim = require('../../src/ts/core/services/autoClaim');
import missions = require('../../src/ts/core/services/missions');
import type * as nodeResolversModule from '../../src/ts/core/scheduling/nodeResolvers';
import type * as scenarioStateStoreModule from '../../src/ts/core/scenarioStateStore';
import type * as openChallengeCacheModule from '../../src/ts/core/services/openChallengeCache';
import type { DiscoverChallenge } from '../../src/ts/core/types/gurushots';
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import { invalid } from '../helpers/invalid';

const { resolveAccountWake, resolveAutoSubmitSchedule } =
    require('../../src/ts/core/scheduling/nodeResolvers') as typeof nodeResolversModule;
const { scenarioStateLedger, initialState } =
    require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule;
const { rememberOpenChallenges, clearOpenChallenges } =
    require('../../src/ts/core/services/openChallengeCache') as typeof openChallengeCacheModule;

const NOW = Math.floor(Date.now() / 1000);

const installation = {
    name: 'Inst',
    version: 1,
    scope: 'installation',
    start: 'main',
    phases: {
        main: {
            rules: [
                {
                    id: 'r',
                    if: [{ type: 'dailyWindow', from: '03:30', to: '04:30' }],
                    do: [{ type: 'notify', message: 'x' }],
                },
            ],
        },
    },
};
const preJoin = {
    name: 'Early',
    version: 1,
    start: 'main',
    phases: {
        main: {
            rules: [{ id: 'r', stages: ['preJoin'], if: [{ type: 'beforeEnd', max: '2h' }], do: [{ type: 'join' }] }],
        },
    },
};
const candidate = (id: number, patch: Record<string, unknown> = {}) =>
    invalid<DiscoverChallenge>({ id, title: `C${id}`, start_time: NOW + 1000, close_time: NOW + 90_000, ...patch });

beforeEach(async () => {
    installHeadlessStore();
    await storageModule.discardPendingWrites();
    storageModule.resumeWrites();
    clearOpenChallenges();
    jest.mocked(autoClaim.getAutoClaimStatus).mockReturnValue({ enabled: false, nextClaimAt: 0 });
    jest.mocked(missions.getNextMissionExpiry).mockReturnValue(null);
});

afterEach(() => {
    jest.restoreAllMocks();
    removeHeadlessStore();
});

describe('resolveAccountWake', () => {
    test('an account with no installation scenario, no candidate and nothing to claim has no boundary', () => {
        expect(resolveAccountWake()).toEqual({
            installation: null,
            candidates: [],
            claimAt: null,
            missionExpiry: null,
        });
    });

    test('the installation scenario this runtime owns, in the installation zone, looking ahead to the discover horizon', () => {
        expect(settings.saveScenario(invalid(installation)).ok).toBe(true);
        expect(settings.setInstallationScenario('Inst', 'android-service', 0).ok).toBe(true);
        const wake = resolveAccountWake();
        expect(wake?.installation).toMatchObject({
            state: { scenario: 'Inst', phase: 'main' },
            timezone: expect.any(String),
        });
        expect(wake?.installation?.scenario.name).toBe('Inst');
        const hours = settings.getEffectiveSetting('discoverUpcomingHours', 'global');
        expect(Math.abs(wake!.installation!.horizon - (NOW + hours * 3600))).toBeLessThanOrEqual(2);
    });

    test('an installation scenario another runtime owns is not this runtime to wake for', () => {
        expect(settings.saveScenario(invalid(installation)).ok).toBe(true);
        expect(settings.setInstallationScenario('Inst', 'electron', 0).ok).toBe(true);
        expect(resolveAccountWake().installation).toBeNull();
    });

    test('progress of another scenario is not this scenario’s state: it starts from the beginning', () => {
        expect(settings.saveScenario(invalid(installation)).ok).toBe(true);
        expect(settings.setInstallationScenario('Inst', 'android-service', 0).ok).toBe(true);
        const changed = scenarioStateLedger.change('@installation', (current) => ({
            ...(current ?? initialState('Other', 'main', NOW)),
            scenario: 'Other',
        }));
        expect(changed.ok).toBe(true);
        expect(resolveAccountWake().installation).toMatchObject({ state: null });
    });

    test('an installation whose generation has moved on (a former owner’s) is not woken for', () => {
        expect(settings.saveScenario(invalid(installation)).ok).toBe(true);
        expect(settings.setInstallationScenario('Inst', 'android-service', 0).ok).toBe(true);
        expect(resolveAccountWake().installation).not.toBeNull();
        jest.spyOn(settings, 'installationGeneration').mockReturnValue(9);
        expect(resolveAccountWake().installation).toBeNull();
    });

    test('a time zone that cannot be read leaves out what needs it, and the saved zone takes no place', () => {
        expect(settings.saveScenario(invalid(installation)).ok).toBe(true);
        expect(settings.setInstallationScenario('Inst', 'android-service', 0).ok).toBe(true);
        rememberOpenChallenges([candidate(1)]);
        jest.spyOn(settings, 'captureInstallationSettings').mockReturnValue({
            ok: false,
            key: 'timezone',
            reason: 'expired',
        });
        expect(resolveAccountWake()).toMatchObject({ installation: null, candidates: [] });
    });

    test('a candidate whose scenario has pre-join rules is listed with it; the rest are not', () => {
        expect(settings.saveScenario(invalid(preJoin)).ok).toBe(true);
        expect(settings.setChallengeOverride('scenario', '1', 'Early')).toBe(true);
        rememberOpenChallenges([candidate(1), candidate(2), candidate(3, { close_time: NOW - 5 }), candidate(4)]);
        expect(settings.setChallengeOverride('scenario', '3', 'Early')).toBe(true);
        const found = resolveAccountWake().candidates;
        expect(found.map((c) => c.challenge.id)).toEqual([1]);
        expect(found[0]).toMatchObject({ scenario: { name: 'Early' }, timezone: expect.any(String) });
    });

    test('the claim throttle, only while claiming is on and the next claim is known; and the last mission expiry', () => {
        jest.mocked(autoClaim.getAutoClaimStatus).mockReturnValue({
            enabled: true,
            nextClaimAt: (NOW + 3600) * 1000 + 400,
        });
        jest.mocked(missions.getNextMissionExpiry).mockReturnValue(NOW + 900);
        expect(resolveAccountWake()).toMatchObject({ claimAt: NOW + 3601, missionExpiry: NOW + 900 });
        // Due on the first cycle (0), or claiming off: no boundary.
        jest.mocked(autoClaim.getAutoClaimStatus).mockReturnValue({ enabled: true, nextClaimAt: 0 });
        expect(resolveAccountWake().claimAt).toBeNull();
        jest.mocked(autoClaim.getAutoClaimStatus).mockReturnValue({ enabled: false, nextClaimAt: (NOW + 60) * 1000 });
        expect(resolveAccountWake().claimAt).toBeNull();
    });
});

describe('resolveAutoSubmitSchedule: a phase’s resolved schedule', () => {
    const submit = { alignment: 'end' as const, rows: [{ state: 'known' as const, count: 2, at: NOW + 500 }] };

    test('carries what the owner published while the phase holds it; none: the saved schedule only', () => {
        jest.spyOn(settings, 'getPhaseSchedules').mockReturnValue({ kind: 'resolved', schedules: { submit } });
        expect(resolveAutoSubmitSchedule('1')).toMatchObject({ resolved: submit });
        jest.spyOn(settings, 'getPhaseSchedules').mockReturnValue({ kind: 'resolved', schedules: {} });
        expect(resolveAutoSubmitSchedule('1')).not.toHaveProperty('resolved');
        jest.spyOn(settings, 'getPhaseSchedules').mockReturnValue({ kind: 'none' });
        expect(resolveAutoSubmitSchedule('1')).not.toHaveProperty('resolved');
    });

    test('a schedule that cannot be read gives no deadline: the saved one never takes its place', () => {
        expect(settings.setGlobalDefault('autoSubmit', true)).toBe(true);
        jest.spyOn(settings, 'getPhaseSchedules').mockReturnValue({ kind: 'none' });
        expect(resolveAutoSubmitSchedule('1').enabled).toBe(true);
        jest.spyOn(settings, 'getPhaseSchedules').mockReturnValue({ kind: 'unavailable', reason: 'expired' });
        expect(resolveAutoSubmitSchedule('1').enabled).toBe(false);
    });
});
