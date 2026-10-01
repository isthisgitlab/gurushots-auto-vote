/**
 * Tests for services/missions.ts — recognising the join / fill / turbo
 * missions by name, what each still needs, the per-kind settings gate, the
 * change-only summary log, and counting a landed action down.
 */

jest.mock('../../src/ts/logger', () => {
    const level = { info: jest.fn(), warning: jest.fn() };
    return { withCategory: jest.fn(() => level), __level: level };
});
jest.mock('../../src/ts/settings', () => ({ getEffectiveSetting: jest.fn() }));

import type { Mission } from '../../src/ts/types/gurushots';
import type { CategoryLogger } from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';

type LoggerMock = typeof loggerModule & {
    __level: {
        info: jest.Mock<void, Parameters<CategoryLogger['info']>>;
        warning: jest.Mock<void, Parameters<CategoryLogger['warning']>>;
    };
};

import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(invalid<LoggerMock>(loggerModule));
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import type * as missionsModule from '../../src/ts/services/missions';
const {
    classifyMission,
    loadMissionNeeds,
    consumeMission,
    registerMissionNeeds,
    recordManualTurboWin,
    resetMissionLog,
} = require('../../src/ts/services/missions') as typeof missionsModule;

const NOW_MS = 1_790_514_858_000;
const NOW_SEC = NOW_MS / 1000;

const mission = (name: string, current: number, required: number, over: Partial<Mission> = {}) => ({
    id: name,
    name,
    progress: { current, required },
    expiration_timestamp: NOW_SEC + 3600,
    claim_state: 'DISABLED',
    ...over,
});

const enable = (...keys: string[]) =>
    settings.getEffectiveSetting.mockImplementation((key) => (keys.includes(key) ? true : undefined));
const ALL = ['missionJoinEarly', 'missionUseFills', 'missionSaveTurbos'];
const infoMessages = () => logger.__level.info.mock.calls.map((c) => c[0]);

beforeEach(() => {
    jest.clearAllMocks();
    resetMissionLog();
    enable(...ALL);
});

test('manual Turbo wins update only active missions for the same account', () => {
    const first = { join: 0, fill: 0, turbo: 2 };
    const second = { join: 0, fill: 0, turbo: 2 };
    const otherAccount = { join: 0, fill: 0, turbo: 1 };
    const stopFirst = registerMissionNeeds('tok', first);
    const stopSecond = registerMissionNeeds('tok', second);
    const stopOther = registerMissionNeeds('other', otherAccount);
    try {
        recordManualTurboWin('tok');
        expect([first.turbo, second.turbo, otherAccount.turbo]).toEqual([1, 1, 1]);
        stopFirst?.();
        recordManualTurboWin('tok');
        expect([first.turbo, second.turbo, otherAccount.turbo]).toEqual([1, 0, 1]);
    } finally {
        stopFirst?.();
        stopSecond?.();
        stopOther?.();
    }
    recordManualTurboWin('tok');
    expect(second.turbo).toBe(0);
});

test('nested registrations keep the same mission state active until both release it', () => {
    const needs = { join: 0, fill: 0, turbo: 2 };
    const stopOuter = registerMissionNeeds('tok', needs);
    const stopInner = registerMissionNeeds('tok', needs);
    try {
        stopInner?.();
        recordManualTurboWin('tok');
        expect(needs.turbo).toBe(1);
        stopInner?.();
        recordManualTurboWin('tok');
        expect(needs.turbo).toBe(0);
    } finally {
        stopInner?.();
        stopOuter?.();
    }
    needs.turbo = 1;
    recordManualTurboWin('tok');
    expect(needs.turbo).toBe(1);
});

describe('classifyMission', () => {
    test.each([
        ['Join 7 challenges', 'join'],
        ['Use Fill 3 times', 'fill'],
        ['Use 3 Autofills', 'fill'],
        ['Win Turbo 4 times', 'turbo'],
        ['Win 4 Turbos', 'turbo'],
        ['Play 6 Duels', null],
        ['Win 2 flash challenges', null],
        ['Get All Star', null],
        ['Join an All-Star challenge', null],
        ['Fulfill 3 votes', null],
    ])('%s → %s', (name, kind) => {
        expect(classifyMission({ id: 1, name })).toBe(kind);
    });

    test('falls back to the description and survives a missing name', () => {
        expect(classifyMission({ id: 1, description: 'Join 3 challenges' })).toBe('join');
        expect(classifyMission(invalid(null))).toBeNull();
    });
});

describe('loadMissionNeeds', () => {
    const deps = (list: Mission[]) => ({ getMyMissions: jest.fn(async () => list) });

    test('reads what each active mission still needs', async () => {
        const d = deps([
            mission('Join 7 challenges', 2, 7),
            mission('Use Fill 3 times', 1, 3),
            mission('Win Turbo 4 times', 0, 4),
            mission('Play 6 Duels', 0, 6),
        ]);
        await expect(loadMissionNeeds('tok', NOW_MS, d)).resolves.toEqual({
            join: 5,
            fill: 2,
            turbo: 4,
            turboRequirements: [{ remaining: 4, expiresAtSec: NOW_SEC + 3600 }],
        });
        expect(d.getMyMissions).toHaveBeenCalledWith('tok');
    });

    test('complete, claimable, expired and malformed missions need nothing', async () => {
        const needs = await loadMissionNeeds(
            'tok',
            NOW_MS,
            deps([
                mission('Join 7 challenges', 7, 7),
                mission('Use Fill 3 times', 1, 3, { claim_state: 'CLAIM' }),
                mission('Win Turbo 4 times', 0, 4, { expiration_timestamp: NOW_SEC }),
                mission('Win Turbo 2 times', 0, 2, invalid({ expiration_timestamp: undefined, progress: null })),
            ]),
        );
        expect(needs).toEqual({ join: 0, fill: 0, turbo: 0 });
    });

    test('a mission without an expiry stays active; the larger of two same-kind needs wins', async () => {
        const needs = await loadMissionNeeds(
            'tok',
            NOW_MS,
            deps([
                mission('Win Turbo 4 times', 3, 4, { expiration_timestamp: undefined }),
                mission('Win Turbo 3 times', 0, 3),
            ]),
        );
        expect(needs!.turbo).toBe(3);
        expect(needs!.turboRequirements).toEqual([
            { remaining: 1, expiresAtSec: null },
            { remaining: 3, expiresAtSec: NOW_SEC + 3600 },
        ]);
    });

    test('keeps each Turbo mission need paired with its deadline', async () => {
        const needs = await loadMissionNeeds(
            'tok',
            NOW_MS,
            deps([
                mission('Win Turbo 4 times', 0, 4, { expiration_timestamp: NOW_SEC + 4 * 3600 }),
                mission('Win Turbo 2 times', 0, 2, { expiration_timestamp: NOW_SEC + 2 * 3600 }),
            ]),
        );
        expect(needs).toEqual({
            join: 0,
            fill: 0,
            turbo: 4,
            turboRequirements: [
                { remaining: 4, expiresAtSec: NOW_SEC + 4 * 3600 },
                { remaining: 2, expiresAtSec: NOW_SEC + 2 * 3600 },
            ],
        });
    });

    test('only kinds whose setting is on are followed', async () => {
        enable('missionSaveTurbos');
        const needs = await loadMissionNeeds(
            'tok',
            NOW_MS,
            deps([mission('Join 7 challenges', 2, 7), mission('Win Turbo 4 times', 0, 4)]),
        );
        expect(needs).toEqual({
            join: 0,
            fill: 0,
            turbo: 4,
            turboRequirements: [{ remaining: 4, expiresAtSec: NOW_SEC + 3600 }],
        });
    });

    test('Join Early alone follows turbo missions too — joining brings turbos to win', async () => {
        enable('missionJoinEarly');
        const needs = await loadMissionNeeds(
            'tok',
            NOW_MS,
            deps([mission('Use Fill 3 times', 0, 3), mission('Win Turbo 4 times', 1, 4)]),
        );
        expect(needs).toEqual({
            join: 0,
            fill: 0,
            turbo: 3,
            turboRequirements: [{ remaining: 3, expiresAtSec: NOW_SEC + 3600 }],
        });
    });

    test('does not read missions when every setting is off or there is no token', async () => {
        const d = deps([]);
        enable();
        await expect(loadMissionNeeds('tok', NOW_MS, d)).resolves.toBeNull();
        enable(...ALL);
        await expect(loadMissionNeeds('', NOW_MS, d)).resolves.toBeNull();
        expect(d.getMyMissions).not.toHaveBeenCalled();
    });

    test('a non-array list reads as no missions; a throw is logged and yields null', async () => {
        await expect(loadMissionNeeds('tok', NOW_MS, deps(invalid(undefined)))).resolves.toEqual({
            join: 0,
            fill: 0,
            turbo: 0,
        });
        await expect(
            loadMissionNeeds('tok', NOW_MS, { getMyMissions: jest.fn().mockRejectedValue(new Error('down')) }),
        ).resolves.toBeNull();
        await expect(
            loadMissionNeeds('tok', NOW_MS, { getMyMissions: jest.fn().mockRejectedValue('nope') }),
        ).resolves.toBeNull();
        expect(logger.__level.warning.mock.calls.map((c) => c[0])).toEqual([
            'could not read missions: down',
            'could not read missions: nope',
        ]);
    });

    test('logs the summary only when it changes', async () => {
        const active = deps([mission('Win Turbo 4 times', 1, 4)]);
        await loadMissionNeeds('tok', NOW_MS, active);
        await loadMissionNeeds('tok', NOW_MS, active);
        await loadMissionNeeds('tok', NOW_MS, deps([]));
        expect(infoMessages()).toEqual(['🎯 Active missions: turbo 3 to go', 'No automatable mission active']);
        expect(logger.withCategory).toHaveBeenCalledWith('missions');
    });
});

describe('consumeMission', () => {
    test('counts a landed action down, never below 0, and ignores null', () => {
        const needs = { join: 1, fill: 0, turbo: 2 };
        consumeMission(needs, 'turbo');
        consumeMission(needs, 'join');
        consumeMission(needs, 'join');
        consumeMission(needs, 'fill');
        expect(needs).toEqual({ join: 0, fill: 0, turbo: 1 });
        expect(() => consumeMission(null, 'join')).not.toThrow();
    });
});
