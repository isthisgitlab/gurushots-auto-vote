/**
 * Team-match reads on the /rest/ web API (WEB header profile). A team match runs
 * on an ordinary challenge and get_my_active_challenges carries no marker for it,
 * so the link only exists here:
 *
 *   get_teams (limit=1&start=0) - the member's team (`data.teams[0].id`) and the
 *                                 signed-in member (`current_member.id`), only
 *                                 when `state.status` is STATUS_JOINED
 *   get_match (team_id=<id>)    - that team's match: `data.challenge_id`, both
 *                                 sides' `total_votes` and the participants
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

import type { MatchResponse, TeamMatch, TeamStanding, TeamsResponse } from '../types/gurushots';

const JOINED_STATUS = 'STATUS_JOINED';
const RUNNING_STATUS = 'RUNNING';

/** `match`: the member's team has a match; `none`: no team, no match or an unreadable field; `failed`: a request failed. */
type TeamMatchRead =
    | { kind: 'match'; challengeId: string; teamMatch: TeamMatch }
    | { kind: 'none' }
    | { kind: 'failed' };

/** One match participant, narrowed to what the standing counts: who they are and their votes. */
interface MatchMember {
    id: string;
    votes: number;
}

interface MatchTeam {
    id: number;
    name: string;
    votes: number;
    /** The roster in server order, or null when a listed member fails to narrow (the standing is then unreadable). */
    members: MatchMember[] | null;
}

/** The last match status seen, so a non-RUNNING one is logged once per change only; `undefined` until the first read. */
let lastMatchStatus: string | null | undefined;

const __resetMatchStatusForTests = (): void => {
    lastMatchStatus = undefined;
};

/** Flags a non-RUNNING status once per change; the payload carries the status string and nothing else. */
const logMatchStatus = (status: string | null): void => {
    if (status === lastMatchStatus) return;
    lastMatchStatus = status;
    if (status !== RUNNING_STATUS) {
        logger.withCategory('api').debug('Team match not running', { status });
    }
};

/** One participant, or null unless it has a non-empty string id and integer votes; the server `rank` is never read. */
const matchMember = (value: unknown): MatchMember | null => {
    if (!isPlainObject(value)) return null;
    const { id, rank_data } = value;
    if (typeof id !== 'string' || id === '') return null;
    const total: unknown = isPlainObject(rank_data) ? rank_data.total : null;
    const votes: unknown = isPlainObject(total) ? total.votes : null;
    return isInteger(votes) ? { id, votes } : null;
};

/** A roster in server order; null when a listed member fails to narrow, empty when none is listed. */
const matchMembers = (value: unknown): MatchMember[] | null => {
    if (!Array.isArray(value)) return [];
    const members: MatchMember[] = [];
    for (const entry of value) {
        const member = matchMember(entry);
        if (!member) return null;
        members.push(member);
    }
    return members;
};

const matchTeam = (value: unknown): MatchTeam | null => {
    if (!isPlainObject(value)) return null;
    const { id, name, total_votes: votes, members } = value;
    if (!isInteger(id) || typeof name !== 'string' || !isInteger(votes)) return null;
    return { id, name, votes, members: matchMembers(members) };
};

/**
 * The member's team id with the signed-in member's id, or a null for each when
 * `get_teams` reports no joined team; a bad `current_member` never hides the team,
 * it only leaves `meId` null.
 */
const joinedTeam = (response: TeamsResponse): { teamId: number | null; meId: string | null } => {
    const status = response.state?.status;
    const data: unknown = response.data;
    const teams: unknown = isPlainObject(data) ? data.teams : null;
    const first: unknown = Array.isArray(teams) ? teams[0] : null;
    const current: unknown = isPlainObject(first) ? first.current_member : null;
    const currentId: unknown = isPlainObject(current) ? current.id : null;
    const meId = typeof currentId === 'string' && currentId !== '' ? currentId : null;
    if (status !== JOINED_STATUS || !isPlainObject(first) || !isInteger(first.id)) {
        // The observed status stays in the log so an unknown one that hides the marker can be diagnosed.
        logger.withCategory('api').debug('No joined team', { status: typeof status === 'string' ? status : null });
        return { teamId: null, meId: null };
    }
    return { teamId: first.id, meId };
};

/**
 * The signed-in member's standing among the participants. Only the top
 * `min(ourCount, theirCount)` members count, and positions are counted in the
 * vote-sorted order — stable, so equal votes keep the server's order — never
 * from the server's `rank` values, which can be non-contiguous.
 */
const teamStanding = (us: MatchTeam, them: MatchTeam, meId: string | null): TeamStanding | null => {
    if (!us.members || !them.members || meId === null) return null;
    const activeSlots = Math.min(us.members.length, them.members.length);
    if (activeSlots === 0) return null;
    const order = [...us.members].sort((a, b) => b.votes - a.votes);
    const index = order.findIndex((member) => member.id === meId);
    if (index < 0) return null;
    const me = order[index];
    if (index < activeSlots) {
        // The cushion only means something for the last active member: the votes our first standby lacks.
        const standby = order.length > activeSlots ? order[activeSlots] : null;
        return {
            kind: 'active',
            position: index + 1,
            votes: me.votes,
            activeSlots,
            cushion: index + 1 === activeSlots && standby !== null ? me.votes - standby.votes : null,
        };
    }
    // GuruShots' tie rule is unknown, so count the votes needed to strictly pass the last active member.
    return {
        kind: 'standby',
        position: index + 1,
        votes: me.votes,
        activeSlots,
        votesToActive: order[activeSlots - 1].votes - me.votes + 1,
    };
};

/** The match's challenge, both sides and our standing, or null unless it has exactly two well-formed teams, one of them ours. */
const readMatch = (
    response: MatchResponse,
    teamId: number,
    meId: string | null,
): { challengeId: string; teamMatch: TeamMatch } | null => {
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
    const status: unknown = isPlainObject(response.state) ? response.state.status : null;
    const statusString = typeof status === 'string' ? status : null;
    logMatchStatus(statusString);
    return {
        challengeId: String(data.challenge_id),
        teamMatch: {
            us: { name: us.name, votes: us.votes },
            them: { name: them.name, votes: them.votes },
            // Absent or non-string status is no answer: the flag stays absent ("absent means
            // running") instead of reading as an explicit "not running".
            ...(statusString === null ? {} : { running: statusString === RUNNING_STATUS }),
            me: teamStanding(us, them, meId),
        },
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
    const { teamId, meId } = joinedTeam(teams);
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
    const read = readMatch(match, teamId, meId);
    return read ? { kind: 'match', ...read } : { kind: 'none' };
};

export { fetchActiveTeamMatch, __resetMatchStatusForTests };
export type { TeamMatchRead };
