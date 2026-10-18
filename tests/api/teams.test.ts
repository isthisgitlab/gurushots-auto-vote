/**
 * Tests for api/teams.ts — the team-match read: get_teams for the member's team,
 * then get_match for its match. `none` (no team, no match, an unreadable field)
 * is told apart from `failed` (a request came back null), and neither throws.
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

const { fetchActiveTeamMatch } = require('../../src/ts/api/teams') as typeof teamsModule;
const { makePostRequest } = jest.mocked(require('../../src/ts/api/api-client') as typeof api_clientModule);
const logger: LoggerMock = invalid(require('../../src/ts/logger'));
const token = 'tok-123';

const joined = (id: unknown = 111) => ({ state: { status: 'STATUS_JOINED' }, data: { teams: [{ id }] } });
const team = (id: unknown, name: unknown, totalVotes: unknown) => ({ id, name, total_votes: totalVotes });
const match = (teams: unknown, challengeId: unknown = 135938) => ({ data: { challenge_id: challengeId, teams } });
const readWith = async (teamsBody: unknown, matchBody?: unknown) => {
    makePostRequest.mockResolvedValueOnce(invalid(teamsBody));
    if (matchBody !== undefined) makePostRequest.mockResolvedValueOnce(invalid(matchBody));
    return fetchActiveTeamMatch(token);
};

beforeEach(() => {
    jest.clearAllMocks();
    makePostRequest.mockReset();
});

describe('fetchActiveTeamMatch', () => {
    test('maps a joined team and its match, with us/them told apart by our team id', async () => {
        const result = await readWith(joined(), match([team(222, 'Poland Gurus', 8258), team(111, 'Home Team', 7514)]));

        expect(result).toEqual({
            kind: 'match',
            challengeId: '135938',
            teamMatch: { us: { name: 'Home Team', votes: 7514 }, them: { name: 'Poland Gurus', votes: 8258 } },
        });
    });

    test('we may be the first team of the match too', async () => {
        const result = await readWith(joined(), match([team(111, 'Home Team', 1), team(222, 'Poland Gurus', 2)]));

        expect(result).toEqual({
            kind: 'match',
            challengeId: '135938',
            teamMatch: { us: { name: 'Home Team', votes: 1 }, them: { name: 'Poland Gurus', votes: 2 } },
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
