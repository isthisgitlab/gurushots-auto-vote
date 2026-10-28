/**
 * The per-candidate join decision shared by the automatic pass and the
 * join-mission dry run — the entry gates and the timing/affordability
 * predicate — and the dry run itself: whether a "Join challenges" mission
 * may lift the auto-join timing window, counted over the open candidates
 * with that very predicate.
 */

import { shouldJoinChallenge } from '../VotingLogic';
import type { Bankroll, Challenge } from '../../types/gurushots';
import { resolveCandidateConfig, resolveJoinSetting } from './settingsResolution';

/**
 * Mutable per-pass join state: the balance and budget kept locally accurate as
 * the pass spends, the clock the join window is measured against, and whether
 * the one-per-pass missing-timing diagnostic has fired.
 */
type JoinPassState = {
    bankroll: Bankroll | null;
    remainingBudget: number;
    nowSec: number;
    missingCloseTimeLogged: boolean;
    /** Joins still to make without the timing window, for the active missions. */
    earlyJoins: number;
};

const decideCandidateJoin = (
    challenge: Challenge,
    cfg: ReturnType<typeof resolveCandidateConfig>,
    pass: JoinPassState,
    alreadyPaid: boolean,
) => {
    // Join Early for Missions lifts the timing window while a mission wants
    // joins: these would join later anyway, the mission wants them now.
    const joinEarly = pass.earlyJoins > 0;
    if (joinEarly) {
        const closeTime = Number(challenge?.close_time);
        if (!Number.isFinite(closeTime) || closeTime <= 0) {
            return { join: false, needsCoins: 0, reason: 'close-time-unknown' };
        }
        if (closeTime <= pass.nowSec) return { join: false, needsCoins: 0, reason: 'already-closed' };
    }
    return shouldJoinChallenge({
        challenge,
        bankroll: pass.bankroll,
        remainingBudget: pass.remainingBudget,
        includeTypes: cfg.includeTypes,
        excludeTypes: cfg.excludeTypes,
        maxCoins: cfg.maxCoins,
        hasProfileMatch: cfg.hasProfileMatch,
        includeTags: cfg.includeTags,
        excludeTags: cfg.excludeTags,
        joinWithinSec: joinEarly ? 0 : cfg.joinWithinSec,
        joinAfterPercentElapsed: joinEarly ? 0 : cfg.joinAfterPercentElapsed,
        nowSec: pass.nowSec,
        alreadyPaid,
    });
};

/**
 * The two entry gates `joinCandidate` decides before anything else, shared
 * with the join-mission dry run below so the probe counts the same
 * candidates the pass would act on. A non-null value is the status
 * `joinCandidate` returns for the refusal.
 */
const joinCandidateGateRefusal = (
    challenge: Challenge,
): 'skipped:autojoin-off' | 'skipped:manual-photos-only' | null => {
    // Per-candidate enable (master → profile): skip titles auto-join is off
    // for, BEFORE resolving the rest of the config (avoid redundant work).
    if (resolveJoinSetting('autoJoin', challenge) !== true) return 'skipped:autojoin-off';
    // Manual Only: the join would enter a photo by itself, so it is left to the user.
    if (resolveJoinSetting('manualPhotosOnly', challenge) === true) return 'skipped:manual-photos-only';
    return null;
};

/**
 * Whether a join mission lifts the auto-join timing window: a dry run over a
 * scratch state counts what the production decision predicate would join with
 * the window lifted — the window lifts only while the currently open
 * challenges are enough to complete the mission.
 *
 * @returns the lift (the mission's join need when the open list can complete
 *   it, else 0) and how many open candidates would join with the window lifted
 */
const joinMissionLift = (
    candidates: Challenge[],
    joinNeed: number,
    bankroll: Bankroll | null,
    remainingBudget: number,
    nowSec: number,
): { lift: number; wouldJoin: number } => {
    // The probe's earlyJoins stays at 1, deliberately not decremented per
    // counted join — it asks "would this join with the window lifted?",
    // while the real pass counts its lifts down.
    const probePass: JoinPassState = {
        // A shallow copy, never the real pass's object: the pass mutates
        // bankroll.coins in place in its spend accounting, so a shared
        // reference would double-charge the real pass's balance before
        // any join runs. remainingBudget is a number and copies by value.
        bankroll: bankroll ? { ...bankroll } : null,
        remainingBudget,
        nowSec,
        missingCloseTimeLogged: false,
        earlyJoins: 1,
    };
    let wouldJoin = 0;
    // The probe iterates the list as fetched — not the close_time sort the
    // pass uses once a lift is active; the order divergence only matters
    // under a binding budget and is absorbed by the next cycle's
    // re-decide.
    for (const challenge of candidates) {
        if (joinCandidateGateRefusal(challenge) !== null) continue;
        // alreadyPaid: false deliberately undercounts candidates with an
        // unlock claim on file (the real pass joins those submit-only,
        // spending nothing) — conservative, accepted.
        const decision = decideCandidateJoin(challenge, resolveCandidateConfig(challenge), probePass, false);
        if (!decision.join) continue;
        wouldJoin += 1;
        // Count cumulative affordability across the cycle, not each
        // candidate in isolation. The copy is always here when a
        // decrement happens: a paid join only passes its affordability
        // check with a known balance (balance-unknown refuses it), the
        // same invariant the pass's own spend accounting relies on.
        if (decision.needsCoins > 0) {
            probePass.remainingBudget -= decision.needsCoins;
            const probeBankroll = probePass.bankroll as Bankroll;
            probeBankroll.coins = Number(probeBankroll.coins) - decision.needsCoins;
        }
    }
    return { lift: wouldJoin >= joinNeed ? joinNeed : 0, wouldJoin };
};

export { decideCandidateJoin, joinCandidateGateRefusal, joinMissionLift };
export type { JoinPassState };
