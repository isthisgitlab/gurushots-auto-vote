import * as logger from '../../logger';
import * as votingLogic from '../VotingLogic';
import { isMissionVoteCandidate, missionVoteQuota } from '../missions';

import type { Challenge } from '../../types/gurushots';
import type { AutoVoteDecision } from '../decisions/voteDecisions';
import type { MissionNeeds } from '../missions';
import type { PassContext } from './context';

/**
 * The vote a vote mission makes on a challenge the normal rules left waiting:
 * a replacement decision (up to 100%) plus the photo cap, or null when the
 * mission has no part here — no quota, the normal rule already votes, the
 * decision is blocked, or the challenge can't take votes.
 */
export const missionVoteDecision = (
    challenge: Challenge,
    decision: AutoVoteDecision,
    pass: PassContext,
    now: number,
): { decision: AutoVoteDecision; maxVotes: number } | null => {
    const quota = pass.missionVoteQuota;
    if (!(quota >= 1) || decision.shouldVote || decision.blocked || !isMissionVoteCandidate(challenge, now)) {
        return null;
    }
    return {
        decision: {
            shouldVote: true,
            targetExposure: 100,
            voteReason: `vote mission: ${pass.missions?.vote} left at cycle start — voting on up to ${quota} photos`,
            forcedByNewEntry: false,
        },
        maxVotes: quota,
    };
};

// Whether the "no challenge can take votes" line was already logged for the
// current stall, so a stall that lasts cycle after cycle is reported once. Any
// cycle with a quota, with normal voting covering the mission, or without a vote
// mission ends the stall.
let voteStallReported = false;

// Test hook: forget that a stall was reported.
export const resetMissionVoteLog = () => {
    voteStallReported = false;
};

/**
 * This cycle's per-challenge share of an active vote mission, over the whole
 * active list; 0 when there is none to do. A single-challenge run never does
 * mission votes. Logs once when a mission is active but no challenge can take
 * votes (not while normal voting covers it). A challenge the normal rules
 * already vote on takes no share: it gets no mission top-up.
 *
 * The split is a cycle-start estimate, made before the scenario steps and the
 * new-entry detection. A challenge whose decision changes by the time it is
 * processed only shifts votes to the next cycle.
 */
export const planMissionVotes = (
    missions: MissionNeeds | null,
    challengeIdFilter: string | number | null,
    allChallenges: Challenge[],
): number => {
    if (challengeIdFilter != null) return 0;
    const votesLeft = missions?.vote ?? 0;
    if (!(votesLeft > 0)) {
        voteStallReported = false;
        return 0;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    let coveredByNormalVoting = false;
    const quota = missionVoteQuota(votesLeft, allChallenges, nowSec, (challenge) => {
        const decision = votingLogic.evaluateVotingDecision(challenge, nowSec);
        if (decision.shouldVote) coveredByNormalVoting = true;
        return decision.blocked === true || decision.shouldVote;
    });
    if (quota > 0 || coveredByNormalVoting) {
        voteStallReported = false;
        return quota;
    }
    if (!voteStallReported) {
        voteStallReported = true;
        logger
            .withCategory('voting')
            .info(
                `🗳️ Vote mission: ${votesLeft} left — no challenge can take votes now (all full, flash or held by your settings); retrying next cycle`,
                null,
            );
    }
    return quota;
};
