/**
 * Tests for api/teams.ts — the team-match read: get_teams for the member's team,
 * then get_match for its match. `none` (no team, no match, an unreadable field)
 * is told apart from `failed` (a request came back null), and neither throws.
 * The match also carries the running flag and the signed-in member's standing,
 * counted from the rosters in vote-sorted positions.
 */

import type * as teamsModule from '../../src/ts/api/teams';
import type * as api_clientModule from '../../src/ts/api/api-client';
import type * as loggerModule from '../../src/ts/logger';
import type { CategoryLogger } from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';

type LoggerMock = typeof loggerModule & {
    __mockDebugFn: jest.MockedFunction<CategoryLogger['debug']>;
    __mockWarningFn: jest.MockedFunction<CategoryLogger['warning']>;
};

jest.mock('../../src/ts/api/api-client', () => ({
    makePostRequest: jest.fn(),
}));

jest.mock('../../src/ts/logger', () => {
    const mockDebugFn = jest.fn();
    const mockWarningFn = jest.fn();
    return {
        withCategory: jest.fn(() => ({ debug: mockDebugFn, warning: mockWarningFn })),
        __mockDebugFn: mockDebugFn,
        __mockWarningFn: mockWarningFn,
    };
});

const { fetchActiveTeamMatch, __resetMatchStatusForTests } = require('../../src/ts/api/teams') as typeof teamsModule;
const { makePostRequest } = jest.mocked(require('../../src/ts/api/api-client') as typeof api_clientModule);
const logger: LoggerMock = invalid(require('../../src/ts/logger'));
const token = 'tok-123';

const joined = (id: unknown = 111, meId?: unknown) => ({
    state: { status: 'STATUS_JOINED' },
    data: { teams: [{ id, ...(meId !== undefined ? { current_member: { id: meId } } : {}) }] },
});
const team = (id: unknown, name: unknown, totalVotes: unknown) => ({ id, name, total_votes: totalVotes });
const match = (teams: unknown, challengeId: unknown = 135938, status?: unknown) => ({
    ...(status !== undefined ? { state: { status } } : {}),
    data: { challenge_id: challengeId, teams },
});
const readWith = async (teamsBody: unknown, matchBody?: unknown) => {
    makePostRequest.mockResolvedValueOnce(invalid(teamsBody));
    if (matchBody !== undefined) makePostRequest.mockResolvedValueOnce(invalid(matchBody));
    return fetchActiveTeamMatch(token);
};
/** A read that must land on a match; hands back its teamMatch for the standing and running assertions. */
const teamMatchOf = async (teamsBody: unknown, matchBody: unknown) => {
    const result = await readWith(teamsBody, matchBody);
    if (result.kind !== 'match') throw new Error(`expected a match read, got ${result.kind}`);
    return result.teamMatch;
};

// Roster fixtures: five of ours, four of theirs, so four members per side count.
const member = (id: string, votes: number, rank = 0) => ({ id, rank, rank_data: { total: { votes } } });
const rosterTeam = (id: number, name: string, totalVotes: number, members: unknown) => ({
    id,
    name,
    total_votes: totalVotes,
    members,
});
const usFive = [member('a1', 1000), member('a2', 900), member('a3', 800), member('a4', 700), member('a5', 600)];
const themFour = [member('b1', 1500), member('b2', 900), member('b3', 850), member('b4', 10)];
const rosterMatch = (us: unknown, them: unknown, status?: unknown) =>
    match([rosterTeam(111, 'Home Team', 4000, us), rosterTeam(222, 'Poland Gurus', 3260, them)], 135938, status);

beforeEach(() => {
    jest.clearAllMocks();
    makePostRequest.mockReset();
    __resetMatchStatusForTests();
});

describe('fetchActiveTeamMatch', () => {
    test('maps a joined team and its match, with us/them told apart by our team id', async () => {
        const result = await readWith(joined(), match([team(222, 'Poland Gurus', 8258), team(111, 'Home Team', 7514)]));

        // No state in the body: no `running` key — unknown, not "not running" (the strict toEqual pins that).
        expect(result).toEqual({
            kind: 'match',
            challengeId: '135938',
            teamMatch: {
                us: { name: 'Home Team', votes: 7514 },
                them: { name: 'Poland Gurus', votes: 8258 },
                me: null,
            },
        });
    });

    test('we may be the first team of the match too', async () => {
        const result = await readWith(joined(), match([team(111, 'Home Team', 1), team(222, 'Poland Gurus', 2)]));

        expect(result).toEqual({
            kind: 'match',
            challengeId: '135938',
            teamMatch: {
                us: { name: 'Home Team', votes: 1 },
                them: { name: 'Poland Gurus', votes: 2 },
                me: null,
            },
        });
    });

    test('posts the documented endpoints and form bodies with WEB headers', async () => {
        await readWith(joined(), match([team(111, 'A', 1), team(222, 'B', 2)]));

        const [teamsCall, matchCall] = makePostRequest.mock.calls;
        expect(teamsCall[0]).toBe('https://api.gurushots.com/rest/get_teams');
        expect(teamsCall[1]).toEqual(expect.objectContaining({ 'x-env': 'WEB', 'x-token': token }));
        expect(teamsCall[2]).toBe('limit=1&start=0');
        expect(matchCall[0]).toBe('https://api.gurushots.com/rest/get_match');
        expect(matchCall[1]).toEqual(expect.objectContaining({ 'x-env': 'WEB', 'x-token': token }));
        expect(matchCall[2]).toBe('team_id=111');
    });

    test.each([
        ['an empty team list', { state: { status: 'STATUS_JOINED' }, data: { teams: [] } }],
        ['no state', { data: { teams: [{ id: 111 }] } }],
        [
            'a status other than joined, with a team listed',
            { state: { status: 'STATUS_PENDING' }, data: { teams: [{ id: 111 }] } },
        ],
        ['a non-string status', { state: { status: 3 }, data: { teams: [{ id: 111 }] } }],
        ['no data', { state: { status: 'STATUS_JOINED' } }],
        ['teams that is not a list', { state: { status: 'STATUS_JOINED' }, data: { teams: 'x' } }],
        ['a first team that is not an object', { state: { status: 'STATUS_JOINED' }, data: { teams: [7] } }],
        ['a non-integer team id', joined('111')],
    ])('no joined team (%s) is none, quietly, and get_match is never sent', async (_name, body) => {
        const result = await readWith(body);

        expect(result).toEqual({ kind: 'none' });
        expect(makePostRequest).toHaveBeenCalledTimes(1);
        expect(logger.__mockWarningFn).not.toHaveBeenCalled();
        expect(logger.__mockDebugFn).toHaveBeenCalledTimes(1);
    });

    test('the observed status is logged for diagnosis, nothing else from the body', async () => {
        await readWith({ state: { status: 'STATUS_PENDING' }, data: { teams: [{ id: 111, name: 'Secret roster' }] } });

        expect(logger.__mockDebugFn).toHaveBeenCalledWith('No joined team', { status: 'STATUS_PENDING' });
    });

    test('a failed get_teams is failed, with one warning that carries no body', async () => {
        const result = await readWith(null);

        expect(result).toEqual({ kind: 'failed' });
        expect(makePostRequest).toHaveBeenCalledTimes(1);
        expect(logger.__mockWarningFn).toHaveBeenCalledTimes(1);
        expect(logger.__mockWarningFn).toHaveBeenCalledWith(expect.any(String), { requestFailed: true });
    });

    test('a failed get_match is failed, with one warning that carries no body', async () => {
        const result = await readWith(joined(), null);

        expect(result).toEqual({ kind: 'failed' });
        expect(logger.__mockWarningFn).toHaveBeenCalledTimes(1);
        expect(logger.__mockWarningFn).toHaveBeenCalledWith(expect.any(String), { requestFailed: true });
    });

    const two = [team(111, 'A', 1), team(222, 'B', 2)];
    test.each([
        ['no data', {}],
        ['a non-integer challenge id', match(two, '135938')],
        ['teams that is not a list', match('x')],
        ['one team', match([team(111, 'A', 1)])],
        ['three teams', match([...two, team(333, 'C', 3)])],
        ['duplicate team ids', match([team(111, 'A', 1), team(111, 'B', 2)])],
        ['our team missing', match([team(222, 'B', 2), team(333, 'C', 3)])],
        ['a first team that is not an object', match([5, team(111, 'A', 1)])],
        ['a second team that is not an object', match([team(111, 'A', 1), null])],
        ['a team with a non-integer id', match([team('111', 'A', 1), team(222, 'B', 2)])],
        ['a team with a non-string name', match([team(111, 7, 1), team(222, 'B', 2)])],
        ['a team with non-integer votes', match([team(111, 'A', 1.5), team(222, 'B', 2)])],
    ])('a match with %s is none', async (_name, body) => {
        const result = await readWith(joined(), body);

        expect(result).toEqual({ kind: 'none' });
        expect(logger.__mockWarningFn).not.toHaveBeenCalled();
    });
});

describe('team standing', () => {
    test('an active member who is not last keeps the cushion unset', async () => {
        const teamMatch = await teamMatchOf(joined(111, 'a1'), rosterMatch(usFive, themFour));

        expect(teamMatch.me).toEqual({ kind: 'active', position: 1, votes: 1000, activeSlots: 4, cushion: null });
    });

    test('the last active member gets the cushion against our first standby', async () => {
        const teamMatch = await teamMatchOf(joined(111, 'a4'), rosterMatch(usFive, themFour));

        expect(teamMatch.me).toEqual({ kind: 'active', position: 4, votes: 700, activeSlots: 4, cushion: 100 });
    });

    test('a tie at the cutoff gives the last active member a zero cushion', async () => {
        const tied = [...usFive.slice(0, 3), member('a4', 600), member('a5', 600)];

        const teamMatch = await teamMatchOf(joined(111, 'a4'), rosterMatch(tied, themFour));

        expect(teamMatch.me).toEqual({ kind: 'active', position: 4, votes: 600, activeSlots: 4, cushion: 0 });
    });

    test('the last active member with no standby behind them keeps the cushion unset', async () => {
        const teamMatch = await teamMatchOf(joined(111, 'a4'), rosterMatch(usFive.slice(0, 4), themFour));

        expect(teamMatch.me).toEqual({ kind: 'active', position: 4, votes: 700, activeSlots: 4, cushion: null });
    });

    test('a standby counts the votes needed to strictly pass the last active member', async () => {
        const teamMatch = await teamMatchOf(joined(111, 'a5'), rosterMatch(usFive, themFour));

        expect(teamMatch.me).toEqual({ kind: 'standby', position: 5, votes: 600, activeSlots: 4, votesToActive: 101 });
    });

    test('a standby tied with the cutoff needs one vote', async () => {
        const tied = [...usFive.slice(0, 3), member('a4', 600), member('a5', 600)];

        const teamMatch = await teamMatchOf(joined(111, 'a5'), rosterMatch(tied, themFour));

        expect(teamMatch.me).toEqual({ kind: 'standby', position: 5, votes: 600, activeSlots: 4, votesToActive: 1 });
    });

    test('positions are counted in vote order, never from the server rank values', async () => {
        const ranked = [
            member('a1', 50, 7),
            member('a2', 80, 3),
            member('a3', 20, 9),
            member('a4', 10, 4),
            member('a5', 5, 2),
        ];
        const opponents = [member('b1', 30, 1), member('b2', 25, 2), member('b3', 15, 3), member('b4', 12, 4)];

        const teamMatch = await teamMatchOf(joined(111, 'a5'), rosterMatch(ranked, opponents));

        expect(teamMatch.me).toEqual({ kind: 'standby', position: 5, votes: 5, activeSlots: 4, votesToActive: 6 });
    });

    test('the match still reads when neither side lists valid members', async () => {
        const teamMatch = await teamMatchOf(joined(111, 'a1'), rosterMatch([], []));

        expect(teamMatch.us).toEqual({ name: 'Home Team', votes: 4000 });
        expect(teamMatch.me).toBeNull();
    });

    test('the match still reads when our side lists no members at all', async () => {
        const teamMatch = await teamMatchOf(joined(111, 'a1'), rosterMatch(undefined, themFour));

        expect(teamMatch.me).toBeNull();
    });

    test('a missing current_member leaves the standing null and the match intact', async () => {
        const teamMatch = await teamMatchOf(joined(), rosterMatch(usFive, themFour));

        expect(teamMatch.me).toBeNull();
        expect(teamMatch.us).toEqual({ name: 'Home Team', votes: 4000 });
    });

    test.each([
        ['a non-string id', { id: 42 }],
        ['an empty id', { id: '' }],
    ])('a current_member with %s leaves the standing null', async (_name, current) => {
        const body = { state: { status: 'STATUS_JOINED' }, data: { teams: [{ id: 111, current_member: current }] } };

        const teamMatch = await teamMatchOf(body, rosterMatch(usFive, themFour));

        expect(teamMatch.me).toBeNull();
    });

    test('a member id outside our roster leaves the standing null', async () => {
        const teamMatch = await teamMatchOf(joined(111, 'zz'), rosterMatch(usFive, themFour));

        expect(teamMatch.me).toBeNull();
    });

    test.each([
        ['ours', 'us'],
        ['theirs', 'them'],
    ])('a malformed member on the %s side leaves the standing null', async (_name, side) => {
        const us = side === 'us' ? [member('a1', 1000), 'junk'] : usFive;
        const them = side === 'them' ? [member('b1', 900), null] : themFour;

        const teamMatch = await teamMatchOf(joined(111, 'a1'), rosterMatch(us, them));

        expect(teamMatch.me).toBeNull();
        expect(teamMatch.us).toEqual({ name: 'Home Team', votes: 4000 });
    });

    test.each([
        ['a member that is not an object', 'junk'],
        ['a member with a non-string id', { id: 7, rank_data: { total: { votes: 1 } } }],
        ['a member with an empty id', { id: '', rank_data: { total: { votes: 1 } } }],
        ['a member with no rank_data', { id: 'a1' }],
        ['a member with unreadable votes', { id: 'a1', rank_data: { total: { votes: 'x' } } }],
    ])('a roster with %s invalidates the standing', async (_name, bad) => {
        const teamMatch = await teamMatchOf(joined(111, 'a1'), rosterMatch([member('a0', 5), bad], themFour));

        expect(teamMatch.me).toBeNull();
    });
});

describe('match status', () => {
    test('a RUNNING match says so and logs nothing', async () => {
        const teamMatch = await teamMatchOf(joined(111, 'a1'), rosterMatch(usFive, themFour, 'RUNNING'));

        expect(teamMatch.running).toBe(true);
        expect(logger.__mockDebugFn).not.toHaveBeenCalled();
    });

    test('a body with no state leaves the running flag absent, never an explicit false', async () => {
        const teamMatch = await teamMatchOf(joined(111, 'a1'), rosterMatch(usFive, themFour));

        expect(teamMatch).not.toHaveProperty('running');
    });

    test('a non-RUNNING status is logged once per change, never per read', async () => {
        const finished = await teamMatchOf(joined(111, 'a1'), rosterMatch(usFive, themFour, 'FINISHED'));
        expect(finished.running).toBe(false);
        expect(logger.__mockDebugFn).toHaveBeenCalledTimes(1);
        expect(logger.__mockDebugFn).toHaveBeenLastCalledWith('Team match not running', { status: 'FINISHED' });

        await teamMatchOf(joined(111, 'a1'), rosterMatch(usFive, themFour, 'FINISHED'));
        expect(logger.__mockDebugFn).toHaveBeenCalledTimes(1);

        const running = await teamMatchOf(joined(111, 'a1'), rosterMatch(usFive, themFour, 'RUNNING'));
        expect(running.running).toBe(true);
        expect(logger.__mockDebugFn).toHaveBeenCalledTimes(1);

        await teamMatchOf(joined(111, 'a1'), rosterMatch(usFive, themFour, 'FINISHED'));
        expect(logger.__mockDebugFn).toHaveBeenCalledTimes(2);
    });

    test('a status that is not a string logs a null status, once', async () => {
        await teamMatchOf(joined(111, 'a1'), rosterMatch(usFive, themFour, 3));
        await teamMatchOf(joined(111, 'a1'), rosterMatch(usFive, themFour));

        expect(logger.__mockDebugFn).toHaveBeenCalledWith('Team match not running', { status: null });
        expect(logger.__mockDebugFn).toHaveBeenCalledTimes(1);
    });
});

describe('log hygiene', () => {
    test('no log payload ever carries a member id, a vote count or a standing value', async () => {
        await readWith(null);
        await readWith({ state: { status: 'STATUS_PENDING' }, data: { teams: [{ id: 111 }] } });
        await readWith(joined(111, 'm-1'), rosterMatch(usFive, themFour, 'FINISHED'));

        const allowed = [{ requestFailed: true }, { status: 'STATUS_PENDING' }, { status: 'FINISHED' }];
        for (const mock of [logger.__mockDebugFn, logger.__mockWarningFn]) {
            expect(mock.mock.calls.length).toBeGreaterThan(0);
            for (const [message, data] of mock.mock.calls) {
                expect(typeof message).toBe('string');
                expect(allowed).toContainEqual(data);
            }
        }
    });
});
