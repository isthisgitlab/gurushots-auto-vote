/**
 * Team-match reads on the /rest/ web API (WEB header profile). A team match runs
 * on an ordinary challenge and get_my_active_challenges carries no marker for it,
 * so the link only exists here:
 *
 *   get_teams (limit=1&start=0) - the member's team (`data.teams[0].id`), only
 *                                 when `state.status` is STATUS_JOINED
 *   get_match (team_id=<id>)    - that team's match: `data.challenge_id` and both
 *                                 sides' `total_votes`
 *
 * SECURITY: both bodies carry other members' rosters, so they are in the api
 * client's BODY_UNLOGGED_URLS and this module logs flags and the status string
 * only, never a body.
 */

import { makePostRequest } from './api-client';
import { ENDPOINTS, createWebHeaders } from './constants';
import * as logger from '../logger';
import { isInteger } from '../numbers';
import { isPlainObject } from '../plainObject';

import type { MatchResponse, TeamMatch, TeamsResponse } from '../types/gurushots';

const JOINED_STATUS = 'STATUS_JOINED';

/** `match`: the member's team has a match; `none`: no team, no match or an unreadable field; `failed`: a request failed. */
type TeamMatchRead =
    | { kind: 'match'; challengeId: string; teamMatch: TeamMatch }
    | { kind: 'none' }
    | { kind: 'failed' };

interface MatchTeam {
    id: number;
    name: string;
    votes: number;
}

const matchTeam = (value: unknown): MatchTeam | null => {
    if (!isPlainObject(value)) return null;
    const { id, name, total_votes: votes } = value;
    return isInteger(id) && typeof name === 'string' && isInteger(votes) ? { id, name, votes } : null;
};

/** The member's team id, or null when `get_teams` reports no joined team (a normal state). */
const joinedTeamId = (response: TeamsResponse): number | null => {
    const status = response.state?.status;
    const data: unknown = response.data;
    const teams: unknown = isPlainObject(data) ? data.teams : null;
    const first: unknown = Array.isArray(teams) ? teams[0] : null;
    if (status !== JOINED_STATUS || !isPlainObject(first) || !isInteger(first.id)) {
        // The observed status stays in the log so an unknown one that hides the marker can be diagnosed.
        logger.withCategory('api').debug('No joined team', { status: typeof status === 'string' ? status : null });
        return null;
    }
    return first.id;
};

/** The match's challenge and both sides, or null unless it has exactly two well-formed teams, one of them ours. */
const readMatch = (response: MatchResponse, teamId: number): { challengeId: string; teamMatch: TeamMatch } | null => {
    const data: unknown = response.data;
    if (!isPlainObject(data) || !isInteger(data.challenge_id)) return null;
    const teams: unknown = data.teams;
    if (!Array.isArray(teams) || teams.length !== 2) return null;
    const first = matchTeam(teams[0]);
    const second = matchTeam(teams[1]);
    if (!first || !second || first.id === second.id) return null;
    const us = first.id === teamId ? first : second.id === teamId ? second : null;
    if (!us) return null;
    const them = us === first ? second : first;
    return {
        challengeId: String(data.challenge_id),
        teamMatch: { us: { name: us.name, votes: us.votes }, them: { name: them.name, votes: them.votes } },
    };
};

/**
 * Reads the member's current team match. Never throws or rejects.
 *
 * @param token - Authentication token
 */
const fetchActiveTeamMatch = async (token: string): Promise<TeamMatchRead> => {
    const teams = await makePostRequest<TeamsResponse>(ENDPOINTS.getTeams, createWebHeaders(token), 'limit=1&start=0');
    if (!teams) {
        logger.withCategory('api').warning('Teams unavailable; team match unknown', { requestFailed: true });
        return { kind: 'failed' };
    }
    const teamId = joinedTeamId(teams);
    if (teamId === null) return { kind: 'none' };

    // The id is integer-narrowed above, so no raw string reaches the form body.
    const match = await makePostRequest<MatchResponse>(
        ENDPOINTS.getMatch,
        createWebHeaders(token),
        `team_id=${teamId}`,
    );
    if (!match) {
        logger.withCategory('api').warning('Team match unavailable; team match unknown', { requestFailed: true });
        return { kind: 'failed' };
    }
    const read = readMatch(match, teamId);
    return read ? { kind: 'match', ...read } : { kind: 'none' };
};

export { fetchActiveTeamMatch };
export type { TeamMatchRead };
