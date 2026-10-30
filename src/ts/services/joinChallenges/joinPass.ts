/**
 * The automatic per-cycle join pass: the balance and budget kept accurate as it
 * spends, the join window, and the mission-driven early joins.
 */

import * as logger from '../../logger';
import * as settings from '../../settings';
import * as cancellation from '../../voting/cancellation';
import { joinFreshRefusalWhy, joinAfterStartClamped } from '../VotingLogic';
import { isKnownTurboMode } from '../../voting/turboMode';
import { consumeMission } from '../missions';
import type { Bankroll, Challenge } from '../../types/gurushots';
import type { MissionNeeds } from '../missions';
import { errorMessage } from '../../errorMessage';
import { cat } from './shared';
import type { JoinDeps } from './shared';
import { decideCandidateJoin, joinCandidateGateRefusal, joinMissionLift } from './joinMissionLift';
import type { JoinPassState } from './joinMissionLift';
import {
    anyTitleRuleEnablesAutoJoin,
    resolveCandidateConfig,
    resolveJoinSetting,
    warnMissingCloseTime,
} from './settingsResolution';
import { performJoin } from './performJoin';
import { claimOf, pruneClosedClaims, refreshClaims } from './unlockMarker';
import { isMarkedChallenge } from '../../challengeMarks';

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
 * An unreadable active list yields 0 — never join early blind. So does a read
 * that dropped elements: the pending count could be short of the truth.
 */
const turboJoinsNeeded = async (
    token: string,
    deps: JoinDeps,
    missions: MissionNeeds | null,
    nowSec: number,
): Promise<number> => {
    const turboNeed = missions?.turbo ?? 0;
    if (turboNeed <= 0 || !deps.getActiveChallenges) return 0;
    const { challenges, fetchFailed, pruneUnsafe } = await deps.getActiveChallenges(token);
    if (fetchFailed || pruneUnsafe) return 0;
    const requirements = missions?.turboRequirements ?? [{ remaining: turboNeed, expiresAtSec: null }];
    let joinsNeeded = 0;
    for (const { remaining, expiresAtSec: deadline } of requirements) {
        const pending = challenges.filter((c) => {
            // A marked challenge's turbo state cannot be read: it still counts
            // as a pending turbo, so it alone never drives an early join.
            if (isMarkedChallenge(c)) return true;
            const state = c?.member?.turbo?.state ?? '';
            // A turbo without a known mode is never played, so it earns nothing toward the mission.
            if (!PENDING_TURBO_STATES.has(state) || !isKnownTurboMode(c?.member?.turbo)) return false;
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
 * Joins still to make without the timing window (Join Early for Missions):
 * as many as a turbo mission is short of turbos.
 */
const earlyJoinsFor = async (
    token: string,
    deps: JoinDeps,
    missions: MissionNeeds | null,
    nowSec: number,
): Promise<number> => {
    if (settings.getEffectiveSetting('missionJoinEarly', null) !== true) return 0;
    return turboJoinsNeeded(token, deps, missions, nowSec);
};

/**
 * close_time is epoch SECONDS everywhere in this codebase; `now` arrives as
 * epoch ms. A caller that omits it falls back to the wall clock rather than
 * computing a window against 0, which would fail every candidate closed.
 */
const toPassNowSec = (now: number): number => Math.floor((Number.isFinite(now) && now > 0 ? now : Date.now()) / 1000);

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
 * The clamp note, once per pass beside the missing-timing diagnostic: a
 * join-after-start offset at or beyond the challenge's own length is clamped to
 * the latest reachable point (99% elapsed), and the user should know their
 * value did not apply as written. Runs on the production path only — the
 * join-mission dry run never reaches this file — and names the first clamped
 * candidate the window actually governed (joined, or deferred as `too-early`):
 * a candidate the scope or money checks refuse never reaches the window, so it
 * says nothing about the clamp.
 */
const noteAfterStartClamp = (
    challenge: Challenge,
    cfg: ReturnType<typeof resolveCandidateConfig>,
    decision: ReturnType<typeof decideCandidateJoin>,
    pass: JoinPassState,
) => {
    if (!decision.join && decision.reason !== 'too-early') return;
    // Early-join mode lifts the window wholesale (the candidate joins with the
    // after-start value passed as 0), so no clamp applies to it.
    if (pass.earlyJoins > 0 || cfg.joinAfterSecFromStart <= 0) return;
    if (pass.afterStartClampLogged) return;
    if (!joinAfterStartClamped(challenge, pass.nowSec, cfg.joinAfterSecFromStart)) return;
    pass.afterStartClampLogged = true;
    cat().infoT('md10227656ef8', [logger.challengeTag(challenge)], null);
};

/**
 * A full or price-unreadable candidate is never joined, so say why it was
 * skipped — at INFO when the user pointed the pass at this challenge
 * themselves (a title-profile opt-in, or a non-empty Chosen Photos list
 * resolved for it: they should know why nothing happened), at DEBUG for the
 * pass's general sweep. `chosenPhotos` resolves by rule and override here,
 * which is the list's settings-layer resolution (the member scoping of
 * resolveJoinChosen only filters it).
 */
const noteJoinSafetySkip = (challenge: Challenge, reason: 'full' | 'price-unknown', hasProfileMatch: boolean) => {
    const chosen = resolveJoinSetting('chosenPhotos', challenge);
    const optedIn = hasProfileMatch || (Array.isArray(chosen) && chosen.length > 0);
    const why = joinFreshRefusalWhy(reason);
    const message = `skipped ${logger.challengeTag(challenge)}: ${why} — nothing was joined`;
    if (optedIn) cat().info(message, null);
    else cat().debug(message, null);
};

// Challenges already warned about a paid-but-not-entered join: once per challenge per process.
const warnedPaidNotEntered = new Set<string>();

/**
 * With Manual Only on, a join the user already paid for is still not entered by itself. Say so once, so
 * the coins are not left stranded unnoticed. The challenge is not joined, so it has no card and no Pick… button:
 * the user enters it from Discover: choose the photo for that challenge (Chosen Photos), then press Join, which
 * tries those photos first.
 */
const noteUnenteredPaidJoin = async (challenge: Challenge, deps: JoinDeps): Promise<void> => {
    const key = String(challenge?.id);
    if (warnedPaidNotEntered.has(key) || !(await paidAlready(challenge, deps))) return;
    warnedPaidNotEntered.add(key);
    cat().warning(
        `Manual Only is on for ${logger.challengeTag(challenge)}: the join was already paid for, but no photo is entered automatically — enter one from Discover: choose the photo for this challenge (Chosen Photos), then press Join`,
        null,
    );
};

/**
 * Whether the challenge holds an unlock claim, at a positive listing price: a free candidate is not looked up at
 * all. A claim that could not be looked for again is not known to be there: not read as "already paid".
 */
const paidAlready = async (
    challenge: { id?: string | number; join_coins?: number },
    deps: JoinDeps,
): Promise<boolean> => {
    const cost = Number(challenge?.join_coins);
    if (challenge?.id == null || !(cost > 0) || !deps.joinStateStore) return false;
    if (!(await refreshClaims(deps))) return false;
    return claimOf(deps.joinStateStore, challenge.id) !== null;
};

/**
 * The same claim whatever the listing now costs: a claim beats the full/price guard even once the price reads 0
 * or is gone — the coins were paid when the price was positive.
 */
const claimWhateverCost = async (challenge: { id?: string | number }, deps: JoinDeps): Promise<boolean> => {
    if (challenge?.id == null || !deps.joinStateStore) return false;
    if (!(await refreshClaims(deps))) return false;
    return claimOf(deps.joinStateStore, challenge.id) !== null;
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
    const gateRefusal = joinCandidateGateRefusal(challenge);
    if (gateRefusal === 'skipped:manual-photos-only') {
        await noteUnenteredPaidJoin(challenge, deps);
    }
    if (gateRefusal !== null) return gateRefusal;
    const alreadyPaid = await paidAlready(challenge, deps);
    const cfg = resolveCandidateConfig(challenge);
    const decision = decideCandidateJoin(challenge, cfg, pass, alreadyPaid);
    noteAfterStartClamp(challenge, cfg, decision, pass);
    let submitOnly = alreadyPaid;
    if (!decision.join) {
        noteTimingRefusal(challenge, decision.reason, pass);
        if (decision.reason === 'full' || decision.reason === 'price-unknown') {
            // The guard refuses a FRESH join; a claim on file beats it whatever the listing now costs —
            // the price may have dropped to 0 since the unlock was paid, and only the submit is left.
            // With a claim the join goes ahead as the paid retry does: submit only, never an unlock.
            if (!(await claimWhateverCost(challenge, deps))) {
                noteJoinSafetySkip(challenge, decision.reason, cfg.hasProfileMatch);
                return `skipped:${decision.reason}`;
            }
            submitOnly = true;
        } else {
            return `skipped:${decision.reason}`;
        }
    }
    // Guard each candidate: one bad candidate (unexpected throw) must not
    // abort the rest of the pass — mirrors the per-challenge voting loop.
    let outcome;
    try {
        // The balance the pass already holds goes into the claim, for the user to compare with GuruShots.
        const coins = Number(pass.bankroll?.coins);
        outcome = await performJoin(challenge, token, deps, decision.needsCoins, {
            submitOnly,
            coinsBefore: Number.isFinite(coins) ? coins : null,
            priceCeiling: decision.needsCoins,
        });
    } catch (error) {
        cat().warning(`join failed for ${logger.challengeTag(challenge)}: ${errorMessage(error) || error}`, null);
        return 'error';
    }
    // An unlock that got no answer may have charged: it counts against the pass as if it had.
    const spent = outcome.charged + (outcome.maybeCharged ?? 0);
    if (spent > 0) {
        pass.remainingBudget -= spent;
        // A charge only follows a passed affordability check, which already
        // proved Number(bankroll.coins) finite. Coerce the same way so a
        // numeric-string balance is still decremented for the rest of the pass.
        const bankroll = pass.bankroll as Bankroll;
        bankroll.coins = Number(bankroll.coins) - spent;
    }
    return outcome.status;
};

/**
 * A readable open list (empty included) is what cleanup of per-challenge
 * settings compares against to keep a chosen-photos entry for a challenge that
 * can still be joined. Optional-chained like every other settings call here: a
 * partial facade must not fail the pass.
 */
const rememberOpenList = (candidates: Array<Challenge | null>): void => {
    settings.rememberOpenChallengeIds?.(candidates.flatMap((c) => (c?.id == null ? [] : [c.id])));
};

/**
 * Automatic join pass — a pre-step in fetchChallengesAndVote. The `autoJoin`
 * enable is resolved per candidate by title (rule-inline → profile → master), so
 * a titled candidate joins even when the master default is off; the pass only
 * skips wholesale when the master is off AND no title rule turns it on.
 * Sequential, cancellation-aware.
 *
 * Candidates are additionally gated by the join WINDOW — the three timing
 * settings (`autoJoinAfterHoursFromStart`, `autoJoinAfterPercentElapsed`,
 * `autoJoinWithinHoursOfEnd`) resolve to ONE window in a fixed order, the
 * first above 0 winning; 0 = off — so a candidate outside it is deferred with
 * `skipped:too-early` and reconsidered next cycle, so entries land late in a
 * challenge's life rather than the moment it appears.
 *
 * @param now epoch ms — the clock the join window is measured against
 *   (converted to seconds to match `close_time`); defaults to Date.now()
 * @param missions what the active missions still need
 *   (services/missions.ts). With missionJoinEarly on, the timing window is
 *   lifted while a mission wants joins: a join mission only while the open
 *   list can complete it, a turbo mission for the turbos it is short of — a
 *   turbo is only winnable in a joined challenge, so each join brings one
 *   (earlyJoinsFor).
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
        // aislop-ignore-next-line ai-slop/hidden-fallback -- logged via the join logger; the empty pass result is the documented contract
        return empty;
    }
    if (candidates === null) {
        cat().warning('could not list open challenges: the request failed', null);
        return empty;
    }
    rememberOpenList(candidates);
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return { ran: true, joined: 0, results: [] };
    }

    const bankroll = await readPassBankroll(token, deps);
    const nowSec = toPassNowSec(now);
    const pass: JoinPassState = {
        bankroll,
        remainingBudget: settings.getEffectiveSetting('autoJoinCycleCoinBudget', null),
        nowSec,
        // One diagnostic per pass, not per candidate (see warnMissingCloseTime).
        missingCloseTimeLogged: false,
        // One clamp note per pass, not per candidate (see noteAfterStartClamp).
        afterStartClampLogged: false,
        earlyJoins: await earlyJoinsFor(token, deps, missions, nowSec),
    };
    // A join mission lifts the window only while the currently open challenges
    // are enough to complete it.
    const joinNeed = missions?.join ?? 0;
    if (settings.getEffectiveSetting('missionJoinEarly', null) === true && joinNeed > 0) {
        const result = joinMissionLift(candidates, joinNeed, bankroll, pass.remainingBudget, nowSec);
        pass.earlyJoins = Math.max(pass.earlyJoins, result.lift);
        if (result.wouldJoin < joinNeed && pass.earlyJoins === 0) {
            // One per pass, beside the early-join notice: the mission cannot
            // be completed by what is open now, so nothing joins early.
            cat().info(
                `join mission needs ${joinNeed} but only ${result.wouldJoin} of the open challenges would join — waiting for the auto-join timing`,
                null,
            );
        }
    }
    // Explain up front why joins may land outside the configured timing.
    if (pass.earlyJoins > 0) {
        cat().info(`joining up to ${pass.earlyJoins} challenge(s) early for the active missions`, null);
    }

    const results: Array<{ id: string | number | undefined; status: string }> = [];
    let joined = 0;
    // A turbo mission, or a join mission whose open list can complete it, may
    // want fewer joins than there are open challenges. Spend those joins on
    // the ones ending soonest, so their turbos can be won first.
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
            // Any landed join serves the mission — early or in-window — so it consumes the need in both cases.
            consumeMission(missions, 'join');
        }
        results.push({ id: challenge?.id, status });
    }

    // After the joins, so each one's own reads of the claims come first.
    await pruneClosedClaims(candidates, deps);
    if (joined > 0) {
        cat().info(`join pass complete: joined ${joined} of ${candidates.length} open challenge(s)`, null);
    }
    return { ran: true, joined, results };
};

export { runJoinPass };
