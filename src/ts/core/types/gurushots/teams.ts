/**
 * The team payloads: the two teams' vote totals and the member's standing in a
 * match, and the web team/match reads they come from.
 */

/**
 * The signed-in member's standing among their team's match participants, counted
 * in sorted-vote positions over the top `activeSlots` (= `min(ourCount, theirCount)`)
 * members who actually score. Numbers only — never another member's id or name.
 */
export type TeamStanding =
    | { kind: 'active'; position: number; votes: number; activeSlots: number; cushion: number | null }
    | { kind: 'standby'; position: number; votes: number; activeSlots: number; votesToActive: number };

/** Both teams' vote totals in a team match, from our side (`us`) and the opponent's (`them`). */
export interface TeamMatch {
    us: { name: string; votes: number };
    them: { name: string; votes: number };
    /** Absent means running. */
    running?: boolean;
    /** null when the standing is unreadable: a malformed roster, no scoring slots, or the member not listed. */
    me?: TeamStanding | null;
}

/** The WEB get_teams (limit=1): the member's team, only read when `state.status` is STATUS_JOINED. */
export interface TeamsResponse {
    state?: { status?: string };
    data?: { teams?: Array<{ id?: number; current_member?: { id?: string } }> };
}

/** The WEB get_match: the challenge a team's match runs on, each side's total votes and the participants. */
export interface MatchResponse {
    state?: { status?: string };
    data?: {
        challenge_id?: number;
        teams?: Array<{
            id?: number;
            name?: string;
            total_votes?: number;
            /** The match participants in server order; narrowed in api/teams.ts, which never trusts `rank`. */
            members?: Array<{ id?: string; rank?: number; rank_data?: { total?: { votes?: number } } }>;
        }>;
    };
}
