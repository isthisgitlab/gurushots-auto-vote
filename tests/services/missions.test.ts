/**
 * Tests for services/missions.ts — recognising the join / fill / turbo / boost / vote
 * missions by name, what each still needs, the per-kind settings gate, the
 * change-only summary log, and counting a landed action down.
 */

jest.mock('../../src/ts/logger', () => {
    const level = { info: jest.fn(), warning: jest.fn() };
    return { withCategory: jest.fn(() => level), __level: level };
});
jest.mock('../../src/ts/settings', () => ({ getEffectiveSetting: jest.fn() }));

import type { Challenge, Mission } from '../../src/ts/types/gurushots';
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
    neediestFillMission,
    isMissionVoteCandidate,
    missionVoteQuota,
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
const ALL = ['missionJoinEarly', 'missionUseFills', 'missionSaveTurbos', 'missionUseBoosts', 'missionVote'];
const infoMessages = () => logger.__level.info.mock.calls.map((c) => c[0]);

beforeEach(() => {
    jest.clearAllMocks();
    resetMissionLog();
    enable(...ALL);
});

test('manual Turbo wins update only active missions for the same account', () => {
    const first = { join: 0, fill: 0, turbo: 2, boost: 0, vote: 0 };
    const second = { join: 0, fill: 0, turbo: 2, boost: 0, vote: 0 };
    const otherAccount = { join: 0, fill: 0, turbo: 1, boost: 0, vote: 0 };
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
    const needs = { join: 0, fill: 0, turbo: 2, boost: 0, vote: 0 };
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
        ['Vote on 400 photos', 'vote'],
        ['Vote on photos', 'vote'],
        ['Vote for 20 photos', 'vote'],
        ['Vote on 1,000 photos', 'vote'],
        ['Vote on 1 000 photos', 'vote'],
        ['Vote on 1\u00a0000 photos', 'vote'],
        ['Vote on 1.000 photos', 'vote'],
        ['Get 500 votes', null],
        ['Receive a vote for your photo', null],
        // The count never matters: the keyword does.
        ['Use 1 fill', 'fill'],
        ['Use 2 fills', 'fill'],
        ['Win 1 turbo', 'turbo'],
        ['Win 3 turbos', 'turbo'],
        ['Use a boost', 'boost'],
        ['Use 2 boosts', 'boost'],
        ['Join 1 challenge', 'join'],
        ['Vote on 1 photo', 'vote'],
        // A flash vote mission moves through the normal flash voting, not the vote spread.
        ['Vote on 30 photos in Flash', null],
    ])('%s → %s', (name, kind) => {
        expect(classifyMission({ id: 1, name })).toBe(kind);
    });

    test('a vote mission whose description names flash is not a vote mission', () => {
        expect(
            classifyMission({ id: 1, name: 'Vote on 30 photos', description: 'Vote in Flash challenges' }),
        ).toBeNull();
        expect(classifyMission({ id: 1, description: 'Vote on 30 photos in Flash' })).toBeNull();
        expect(classifyMission({ id: 1, name: 'Vote on 30 photos', description: 'Vote in any challenge' })).toBe(
            'vote',
        );
    });

    test('an all-star mission that mentions boosts is not a boost mission', () => {
        expect(classifyMission({ id: 1, name: 'Get All Star', description: 'Use a boost to get there' })).toBeNull();
    });

    test('falls back to the description and survives a missing name', () => {
        expect(classifyMission({ id: 1, description: 'Join 3 challenges' })).toBe('join');
        expect(classifyMission(invalid(null))).toBeNull();
    });

    test.each([
        // The action the mission asks for is the first keyword, not the reward it goes on to name.
        ['Join 3 challenges and get 2 fills', 'join'],
        ['Join 3 challenges to win 2 Turbos', 'join'],
        ['Use Fill 3 times to get a free join', 'fill'],
        ['Win Turbo 4 times and join a challenge', 'turbo'],
        ['Get 2 fills for joining 3 challenges', 'fill'],
        ['Win Turbo 3 times to boost your photo', 'turbo'],
    ])('%s → %s', (name, kind) => {
        expect(classifyMission({ id: 1, name })).toBe(kind);
    });

    test('the name says what is asked for, the description is only its fallback', () => {
        expect(classifyMission({ id: 1, name: 'Join 3 challenges', description: 'Reward: get 2 fills' })).toBe('join');
        expect(classifyMission({ id: 1, name: 'Daily mission', description: 'Join 3 challenges, get 2 fills' })).toBe(
            'join',
        );
        expect(classifyMission({ id: 1, name: 'Daily mission', description: 'Reach the top' })).toBeNull();
    });
});

describe('loadMissionNeeds', () => {
    const deps = (list: Mission[]) => ({ getMyMissions: jest.fn(async () => list) });

    test('reads what each active mission still needs', async () => {
        const d = deps([
            mission('Join 7 challenges', 2, 7),
            mission('Use Fill 3 times', 1, 3),
            mission('Win Turbo 4 times', 0, 4),
            mission('Vote on 400 photos', 100, 400),
            mission('Play 6 Duels', 0, 6),
        ]);
        await expect(loadMissionNeeds('tok', NOW_MS, d)).resolves.toEqual({
            join: 0,
            fill: 2,
            turbo: 4,
            boost: 0,
            vote: 300,
            turboRequirements: [{ remaining: 4, expiresAtSec: NOW_SEC + 3600 }],
            fillMissions: [{ id: 'Use Fill 3 times', required: 3, current: 1, remaining: 2, spentThisPass: 0 }],
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
        expect(needs).toEqual({ join: 0, fill: 0, turbo: 0, boost: 0, vote: 0 });
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
            boost: 0,
            vote: 0,
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
            boost: 0,
            vote: 0,
            turboRequirements: [{ remaining: 4, expiresAtSec: NOW_SEC + 3600 }],
        });
    });

    test('a boost need is only read while Use Boosts for Missions is on', async () => {
        const list = deps([mission('Use 2 boosts', 1, 3)]);
        enable('missionUseBoosts');
        await expect(loadMissionNeeds('tok', NOW_MS, list)).resolves.toEqual({
            join: 0,
            fill: 0,
            turbo: 0,
            boost: 2,
            vote: 0,
        });
        enable('missionJoinEarly');
        await expect(loadMissionNeeds('tok', NOW_MS, list)).resolves.toEqual({
            join: 0,
            fill: 0,
            turbo: 0,
            boost: 0,
            vote: 0,
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
            boost: 0,
            vote: 0,
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
            boost: 0,
            vote: 0,
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

describe('isMissionVoteCandidate', () => {
    const open = (over: Record<string, unknown> = {}) =>
        invalid<Challenge>({
            id: 1,
            type: 'regular',
            start_time: NOW_SEC - 100,
            close_time: NOW_SEC + 100,
            member: { ranking: { exposure: { exposure_factor: 40 } } },
            ...over,
        });

    test('a started, open, non-flash challenge below 100% is a candidate', () => {
        expect(isMissionVoteCandidate(open(), NOW_SEC)).toBe(true);
        expect(isMissionVoteCandidate(open({ member: {} }), NOW_SEC)).toBe(true);
    });

    test.each([
        ['flash', { type: 'flash' }],
        ['not started', { start_time: NOW_SEC }],
        ['closed', { close_time: NOW_SEC }],
        ['full', { member: { ranking: { exposure: { exposure_factor: 100 } } } }],
    ])('%s is not', (_name, over) => {
        expect(isMissionVoteCandidate(open(over), NOW_SEC)).toBe(false);
    });

    test('a null or malformed challenge is not, and never throws', () => {
        expect(isMissionVoteCandidate(invalid(null), NOW_SEC)).toBe(false);
        expect(isMissionVoteCandidate(invalid(undefined), NOW_SEC)).toBe(false);
        expect(isMissionVoteCandidate(invalid({}), NOW_SEC)).toBe(false);
        expect(isMissionVoteCandidate(open({ member: { ranking: null } }), NOW_SEC)).toBe(true);
    });
});

describe('missionVoteQuota', () => {
    const challenge = (id: number, over: Record<string, unknown> = {}) =>
        invalid<Challenge>({ id, type: 'regular', start_time: NOW_SEC - 100, close_time: NOW_SEC + 100, ...over });
    const never = () => false;

    test('nothing remaining is 0 before any challenge is looked at', () => {
        const isBlocked = jest.fn(never);
        const list = [challenge(1)];
        expect(missionVoteQuota(0, list, NOW_SEC, isBlocked)).toBe(0);
        expect(missionVoteQuota(-3, list, NOW_SEC, isBlocked)).toBe(0);
        expect(missionVoteQuota(NaN, list, NOW_SEC, isBlocked)).toBe(0);
        expect(isBlocked).not.toHaveBeenCalled();
    });

    test('splits what is left over the eligible challenges, rounding up', () => {
        expect(missionVoteQuota(400, [challenge(1), challenge(2), challenge(3)], NOW_SEC, never)).toBe(134);
        expect(missionVoteQuota(2, [challenge(1), challenge(2), challenge(3)], NOW_SEC, never)).toBe(1);
        expect(missionVoteQuota(7, [challenge(1)], NOW_SEC, never)).toBe(7);
    });

    test('a blocked challenge is left out of the split', () => {
        const isBlocked = (c: Challenge) => c.id === 2;
        expect(missionVoteQuota(100, [challenge(1), challenge(2)], NOW_SEC, isBlocked)).toBe(100);
    });

    test('a challenge that is not a candidate is never asked about being blocked', () => {
        const isBlocked = jest.fn(never);
        const flash = challenge(2, { type: 'flash' });
        expect(missionVoteQuota(10, [challenge(1), flash], NOW_SEC, isBlocked)).toBe(10);
        expect(isBlocked).toHaveBeenCalledTimes(1);
    });

    test('a throwing isBlocked makes only that challenge ineligible', () => {
        const isBlocked = (c: Challenge) => {
            if (c.id === 2) throw new Error('malformed');
            return false;
        };
        expect(missionVoteQuota(10, [challenge(1), challenge(2)], NOW_SEC, isBlocked)).toBe(10);
    });

    test('nothing eligible is 0', () => {
        expect(missionVoteQuota(10, [], NOW_SEC, never)).toBe(0);
        expect(missionVoteQuota(10, [challenge(1)], NOW_SEC, () => true)).toBe(0);
        expect(missionVoteQuota(10, [challenge(1, { type: 'flash' })], NOW_SEC, never)).toBe(0);
    });
});

describe('consumeMission', () => {
    test('counts a landed action down, never below 0, and ignores null', () => {
        const needs = { join: 1, fill: 0, turbo: 2, boost: 1, vote: 0 };
        consumeMission(needs, 'turbo');
        consumeMission(needs, 'join');
        consumeMission(needs, 'join');
        consumeMission(needs, 'fill');
        consumeMission(needs, 'boost');
        consumeMission(needs, 'boost');
        expect(needs).toEqual({ join: 0, fill: 0, turbo: 1, boost: 0, vote: 0 });
        expect(() => consumeMission(null, 'join')).not.toThrow();
    });

    test('a fill counts toward every "Use Fill" mission, never below what it needs', () => {
        const mission = (id: string, remaining: number) => ({
            id,
            required: 5,
            current: 0,
            remaining,
            spentThisPass: 0,
        });
        const needs = {
            join: 0,
            fill: 2,
            turbo: 0,
            boost: 0,
            vote: 0,
            fillMissions: [mission('a', 2), mission('b', 1)],
        };
        consumeMission(needs, 'fill');
        expect(needs.fillMissions.map((m) => m.remaining)).toEqual([1, 0]);
        consumeMission(needs, 'fill');
        consumeMission(needs, 'fill');
        expect(needs.fillMissions.map((m) => m.remaining)).toEqual([0, 0]);
        expect(needs.fill).toBe(0);
    });
});

describe('neediestFillMission', () => {
    const mission = (id: string, remaining: number) => ({ id, required: 5, current: 0, remaining, spentThisPass: 0 });

    test('is the "Use Fill" mission that still needs the most, and none when none does', () => {
        const needs = {
            join: 0,
            fill: 3,
            turbo: 0,
            boost: 0,
            vote: 0,
            fillMissions: [mission('a', 1), mission('b', 3), mission('c', 0)],
        };
        expect(neediestFillMission(needs)?.id).toBe('b');
        needs.fillMissions = [mission('c', 0)];
        expect(neediestFillMission(needs)).toBeNull();
        expect(neediestFillMission({ join: 0, fill: 0, turbo: 0, boost: 0, vote: 0 })).toBeNull();
        expect(neediestFillMission(null)).toBeNull();
    });
});
