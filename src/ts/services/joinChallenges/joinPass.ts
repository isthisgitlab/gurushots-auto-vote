/**
 * The automatic per-cycle join pass.
 */

import * as logger from '../../logger';
import * as settings from '../../settings';
import * as cancellation from '../../voting/cancellation';
import { shouldJoinChallenge } from '../VotingLogic';
import { consumeMission } from '../missions';
import type { Bankroll, Challenge } from '../../types/gurushots';
import type { MissionNeeds } from '../missions';
import { errorMessage } from '../../errorMessage';
import { cat } from './shared';
import type { JoinDeps } from './shared';
import {
    anyTitleRuleEnablesAutoJoin,
    resolveCandidateConfig,
    resolveJoinSetting,
    warnMissingCloseTime,
} from './settingsResolution';
import { performJoin } from './performJoin';

// ---- automatic per-cycle pass ----

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

/**
 * One balance read for the whole pass. A throw here (or a null return) means
 * "balance unknown" ⇒ no paid joins.
 */
const readPassBankroll = async (token: string, deps: JoinDeps): Promise<Bankroll | null> => {
    try {
        return await deps.getBankroll(token);
    } catch (error) {
        cat().warning(`could not read balance (paid joins skipped this pass): ${errorMessage(error) || error}`, null);
        return null;
    }
};

// Turbo states still ahead of a win: earnable now, being played, or on the
// timer before it opens.
const PENDING_TURBO_STATES = new Set(['FREE', 'IN_PROGRESS', 'TIMER']);

/**
 * How many joins a "Win Turbo" mission still needs: its remaining wins minus
 * the turbos in joined challenges that can be won before the mission expires.
 * A join with a timely turbo stops another early join on the next cycle.
 * An unreadable active list yields 0 — never join early blind.
 */
const turboJoinsNeeded = async (
    token: string,
    deps: JoinDeps,
    missions: MissionNeeds | null,
    nowSec: number,
): Promise<number> => {
    const turboNeed = missions?.turbo ?? 0;
    if (turboNeed <= 0 || !deps.getActiveChallenges) return 0;
    const { challenges, fetchFailed } = await deps.getActiveChallenges(token);
    if (fetchFailed) return 0;
    const requirements = missions?.turboRequirements ?? [{ remaining: turboNeed, expiresAtSec: null }];
    let joinsNeeded = 0;
    for (const { remaining, expiresAtSec: deadline } of requirements) {
        const pending = challenges.filter((c) => {
            const state = c?.member?.turbo?.state ?? '';
            if (!PENDING_TURBO_STATES.has(state)) return false;
            if (deadline === null) return true;
            const closes = Number(c?.close_time);
            if (!Number.isFinite(closes) || closes <= nowSec) return false;
            if (state !== 'TIMER') return true;
            const opens = Number(c?.member?.turbo?.time_to_open);
            return Number.isFinite(opens) && opens > 0 && opens < deadline && opens < closes;
        }).length;
        joinsNeeded = Math.max(joinsNeeded, remaining - pending);
    }
    return joinsNeeded;
};

/**
 * Joins still to make without the timing window (Join Early for Missions): as
 * many as a join mission needs, or as a turbo mission is short of turbos.
 */
const earlyJoinsFor = async (
    token: string,
    deps: JoinDeps,
    missions: MissionNeeds | null,
    nowSec: number,
): Promise<number> => {
    if (settings.getEffectiveSetting('missionJoinEarly', null) !== true) return 0;
    return Math.max(missions?.join ?? 0, await turboJoinsNeeded(token, deps, missions, nowSec));
};

/**
 * close_time is epoch SECONDS everywhere in this codebase; `now` arrives as
 * epoch ms. A caller that omits it falls back to the wall clock rather than
 * computing a window against 0, which would fail every candidate closed.
 */
const toPassNowSec = (now: number): number => Math.floor((Number.isFinite(now) && now > 0 ? now : Date.now()) / 1000);

const decideCandidateJoin = (challenge: Challenge, pass: JoinPassState) => {
    const cfg = resolveCandidateConfig(challenge);
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
    });
};

/**
 * Both timing fields get the same one-per-pass diagnostic: each means the window
 * silently stopped joining, which is otherwise indistinguishable from "nothing
 * to join".
 */
const noteTimingRefusal = (challenge: Challenge, reason: string, pass: JoinPassState) => {
    if (reason !== 'close-time-unknown' && reason !== 'start-time-unknown') return;
    if (pass.missingCloseTimeLogged) return;
    pass.missingCloseTimeLogged = true;
    warnMissingCloseTime(challenge, reason);
};

/**
 * Decide and (when due) perform one candidate's join, keeping the pass's
 * balance and budget in step with what it spent.
 *
 * @returns the candidate's result status
 */
const joinCandidate = async (
    challenge: Challenge,
    token: string,
    deps: JoinDeps,
    pass: JoinPassState,
): Promise<string> => {
    // Per-candidate enable (master → profile): skip titles auto-join is off
    // for, BEFORE resolving the rest of the config (avoid redundant work).
    if (resolveJoinSetting('autoJoin', challenge) !== true) {
        return 'skipped:autojoin-off';
    }
    const decision = decideCandidateJoin(challenge, pass);
    if (!decision.join) {
        noteTimingRefusal(challenge, decision.reason, pass);
        return `skipped:${decision.reason}`;
    }
    // Guard each candidate: one bad candidate (unexpected throw) must not
    // abort the rest of the pass — mirrors the per-challenge voting loop.
    let outcome;
    try {
        outcome = await performJoin(challenge, token, deps, decision.needsCoins);
    } catch (error) {
        cat().warning(`join failed for ${logger.challengeTag(challenge)}: ${errorMessage(error) || error}`, null);
        return 'error';
    }
    if (outcome.charged > 0) {
        pass.remainingBudget -= outcome.charged;
        // A charge only follows a passed affordability check, which already
        // proved Number(bankroll.coins) finite. Coerce the same way so a
        // numeric-string balance is still decremented for the rest of the pass.
        const bankroll = pass.bankroll as Bankroll;
        bankroll.coins = Number(bankroll.coins) - outcome.charged;
    }
    return outcome.status;
};

/**
 * Automatic join pass — a pre-step in fetchChallengesAndVote. The `autoJoin`
 * enable is resolved per candidate by title (rule-inline → profile → master), so
 * a titled candidate joins even when the master default is off; the pass only
 * skips wholesale when the master is off AND no title rule turns it on.
 * Sequential, cancellation-aware.
 *
 * Candidates are additionally gated by the join WINDOW
 * (`autoJoinWithinHoursOfEnd`, 0 = off): a candidate outside it is deferred with
 * `skipped:too-early` and reconsidered next cycle, so entries land near a
 * challenge's end rather than the moment it appears.
 *
 * @param now epoch ms — the clock the join window is measured against
 *   (converted to seconds to match `close_time`); defaults to Date.now()
 * @param missions what the active missions still need
 *   (services/missions.ts). With missionJoinEarly on, the timing window is
 *   lifted for as many joins as a "Join N challenges" mission needs, or as a
 *   "Win Turbo" mission is short of turbos — a turbo is only winnable in a
 *   joined challenge, so each join brings one (earlyJoinsFor). Each join counts
 *   the join mission down.
 */
const runJoinPass = async (
    token: string,
    now: number,
    deps: JoinDeps,
    missions: MissionNeeds | null = null,
): Promise<{ ran: boolean; joined: number; results: Array<{ id: string | number | undefined; status: string }> }> => {
    const empty = { ran: false, joined: 0, results: [] };
    if (!token) return empty;
    // The master autoJoin is only the default; a title profile can enable joining
    // for its title even when the master is off (resolved master → profile — an
    // un-joined candidate has no cached id for a per-challenge override to key
    // off). So we can only skip the pass entirely when the master is off AND no
    // title profile turns it on. Effective per-candidate enable is resolved in
    // joinCandidate.
    const masterOn = settings.getEffectiveSetting('autoJoin', null) === true;
    // When the master default is off, the pass is still needed if any saved title
    // profile turns autoJoin ON for its title. Check that precisely (a tag-only
    // title rule — an auto-fill tag rule — carries no profile and can never
    // enable joining, so it must NOT keep the pass alive every cycle).
    if (!masterOn && !anyTitleRuleEnablesAutoJoin()) {
        return empty;
    }

    let candidates;
    try {
        candidates = await deps.getMemberChallenges(token, 'open');
    } catch (error) {
        cat().warning(`could not list open challenges: ${errorMessage(error) || error}`, null);
        return empty;
    }
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return { ran: true, joined: 0, results: [] };
    }

    const bankroll = await readPassBankroll(token, deps);
    const nowSec = toPassNowSec(now);
    const pass: JoinPassState = {
        bankroll,
        remainingBudget: Number(settings.getEffectiveSetting('autoJoinCycleCoinBudget', null)) || 0,
        nowSec,
        // One diagnostic per pass, not per candidate (see warnMissingCloseTime).
        missingCloseTimeLogged: false,
        earlyJoins: await earlyJoinsFor(token, deps, missions, nowSec),
    };
    // Explain up front why joins may land outside the configured timing.
    if (pass.earlyJoins > 0) {
        cat().info(`joining up to ${pass.earlyJoins} challenge(s) early for the active missions`, null);
    }

    const results: Array<{ id: string | number | undefined; status: string }> = [];
    let joined = 0;
    // A mission may need fewer joins than there are open challenges. Spend
    // those joins on the ones ending soonest, so their turbos can be won first.
    const orderedCandidates =
        pass.earlyJoins > 0
            ? [...candidates].sort((a, b) => (a?.close_time ?? Infinity) - (b?.close_time ?? Infinity))
            : candidates;
    for (const challenge of orderedCandidates) {
        if (cancellation.isCancelled()) {
            cat().warning('join pass cancelled by user', null);
            break;
        }
        const status = await joinCandidate(challenge, token, deps, pass);
        if (status === 'joined') {
            joined += 1;
            pass.earlyJoins -= 1;
            consumeMission(missions, 'join');
        }
        results.push({ id: challenge?.id, status });
    }

    if (joined > 0) {
        cat().info(`join pass complete: joined ${joined} of ${candidates.length} open challenge(s)`, null);
    }
    return { ran: true, joined, results };
};

export { runJoinPass };
