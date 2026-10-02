/**
 * The voting-pass orchestration shared by BOTH API strategies
 * (strategies/real and mock/strategy.ts): the mock runs the identical strategy
 * path over its fake endpoints, so auto-fill, emergency fill, turbo-earn and
 * the timer-ordered deadline actions behave the same in both modes.
 *
 * `deps.api` is the endpoint set (real api/* modules or mockApiClient — the
 * same surface apiFactory's ApiStrategy describes minus authenticate and
 * this function itself). Strategy-specific behavior is injected:
 *   - interChallengeDelay: real mode mimics a human (2-5s random); mock
 *     uses a short fixed delay.
 *   - cleanupStaleMetadata: real mode prunes stale per-challenge metadata;
 *     mock passes null — the metadata store is SHARED and un-namespaced,
 *     and mock challenge ids never match real ones, so running cleanup in
 *     mock mode would purge the user's real voting metadata.
 *
 * The per-phase runners live in services/votingOrchestrator/.
 *
 * Runners execute SEQUENTIALLY by design: auto-fill mutates the shared
 * challenge object (reflectNewEntry) so a later turbo/boost in the same
 * cycle sees the consumed slot and new entry. Do not parallelize them.
 *
 * @param challengeIdFilter - restricts the strategy pass
 *   to one challenge (per-card "Run"); stale-metadata cleanup still runs
 *   against the full active list first.
 * @param deps - see types/votingPass.ts
 *   `entryTracker` backs the voteOnNewEntry feature. Real mode passes a
 *   metadata.json-backed tracker; mock passes an in-memory one for the same reason
 *   it passes cleanupStaleMetadata: null — the metadata store is shared and
 *   un-namespaced, and mock challenge ids would accumulate there unpruned. Omitting
 *   it entirely makes the feature inert.
 *   `entryAges` records when each entry entered its challenge, for the boost's
 *   fresh-entry wait (boostFreshEntryWait). Real mode persists it; mock passes an
 *   in-memory one. Omitting it means a boost is never held.
 *   `currency` backs the automatic key / swap / fill spends (services/currencyAuto.ts):
 *   `strategy` is the endpoint set the spend services take (the same shape the manual
 *   currency handlers pass), `swapLedger` the swap-back ledger and `spendLedger` the
 *   automatic-fill counter. Mock passes in-memory ledgers for the same reason it passes
 *   cleanupStaleMetadata: null. Omitting it makes the automation inert.
 *   `missions` is what the active missions still need (services/missions.ts): a
 *   turbo win or a fill this pass counts down its mission, and a vote mission
 *   splits its remaining votes over the challenges (missionVoteQuota). Omitted =
 *   no mission is followed.
 *   `challenges` is the full active list this cycle fetched (not the
 *   filtered subset) so callers can reuse it for threshold scheduling.
 */

import * as logger from '../logger';
import * as votingLogic from './VotingLogic';
import * as photoStats from './photoStats';
import * as currencyAuto from './currencyAuto';
import { consumeMission, registerMissionNeeds } from './missions';
import { turboRunSnapshot } from './turboRunLock';
import { runScenarioStep } from './scenarioRunner';
import * as cancellation from '../voting/cancellation';
import { failureText } from '../format/logSafe';
import { buildFillDeps, cancelPass } from './votingOrchestrator/context';
import { runDeadlineActions } from './votingOrchestrator/actionRunners';
import { playAutoTurbo } from './votingOrchestrator/turbo';
import { describeNewEntryOutcome, detectNewEntry, recordEntrySnapshot } from './votingOrchestrator/newEntries';
import { voteOnChallenge } from './votingOrchestrator/vote';
import { missionVoteDecision, planMissionVotes, resetMissionVoteLog } from './votingOrchestrator/missionVotes';

import type { Challenge } from '../types/gurushots';
import type { VotingPassDeps, VotingPassResult } from '../types/votingPass';
import type { PassContext } from './votingOrchestrator/context';
import { errorMessage } from '../errorMessage';

/**
 * Failed-pass exit before any challenge is processed: log on the challenges
 * category, close the operation with the same message, surface the list.
 */
const abortPass = (msg: string, allChallenges: Challenge[], level: 'error' | 'warning'): VotingPassResult => {
    logger.withCategory('challenges')[level](msg, null);
    logger.withCategory('voting').endOperation('voting-process', null, msg);
    return { success: false, error: msg, challenges: allChallenges };
};

/**
 * Cleanup stale metadata against the full active list — must run before any
 * per-challenge filter so we don't drop metadata for challenges the user is
 * simply not running this pass.
 */
const pruneStaleMetadata = (
    cleanupStaleMetadata: (activeChallengeIds: string[]) => boolean,
    allChallenges: Challenge[],
) => {
    try {
        const activeChallengeIds = allChallenges.map((challenge) => challenge.id.toString());
        const cleanupSuccess = cleanupStaleMetadata(activeChallengeIds);
        if (cleanupSuccess) {
            logger.withCategory('api').debug('Successfully cleaned up stale metadata', null);
        } else {
            logger.withCategory('api').warning('Failed to cleanup stale metadata', null);
        }
    } catch (error) {
        logger.withCategory('api').warning('Error during metadata cleanup:', error);
    }
};

/**
 * Narrow the pass to the per-card "Run" challenge when a filter is set.
 *
 *   `result` is the pass's exit value when the filtered challenge is not active.
 */
const selectPassChallenges = (
    allChallenges: Challenge[],
    challengeIdFilter: string | number | null,
): { challenges: Challenge[]; result?: undefined } | { result: VotingPassResult; challenges?: undefined } => {
    if (challengeIdFilter == null) {
        return {
            challenges: [...allChallenges].sort((a, b) => (a?.close_time ?? Infinity) - (b?.close_time ?? Infinity)),
        };
    }
    const idStr = String(challengeIdFilter);
    const challenges = allChallenges.filter((c) => String(c.id) === idStr);
    if (challenges.length === 0) {
        return { result: abortPass(`Challenge ${idStr} is not active`, allChallenges, 'warning') };
    }
    logger.withCategory('voting').info(`🎯 Run scoped to single challenge: ${challenges[0].title} (${idStr})`, null);
    return { challenges };
};

/**
 * One challenge's full pass: its user-defined scenario, turbo-earn, currency
 * automation, deadline actions, new-entry detection, the vote, and the
 * post-vote exposure fill — in that order.
 *
 * @param position - 1-based index for progress reporting
 * @returns the cancelled-pass result, or null to continue
 */
const processChallenge = async (
    challenge: Challenge,
    now: number,
    position: number,
    total: number,
    pass: PassContext,
): Promise<VotingPassResult | null> => {
    // Check for cancellation before processing each challenge
    if (cancellation.isCancelled()) {
        return cancelPass(pass.allChallenges);
    }

    logger
        .withCategory('voting')
        .progress(`Processing challenge ${position}/${total}: ${challenge.title}`, position, total);

    // The challenge's scenario runs first: its actions (and a phase change)
    // land before the built-in steps, which then read the new phase's
    // settings overlay through getEffectiveSetting.
    await runScenarioStep(challenge, now, pass);

    await playAutoTurbo(challenge, now, pass);

    // Automatic key unlock and photo swap (opt-in per challenge/profile). They
    // run ahead of the deadline actions on purpose: an unlocked boost is then
    // available to the boost runner this same pass, and a swap happens before a
    // boost/turbo lands, so neither spends on the photo about to be replaced.
    const currencyCtx = { challenge, token: pass.token, now, currency: pass.currency };
    await currencyAuto.runAutoKey(currencyCtx);
    await currencyAuto.runAutoSwap(currencyCtx);

    const actionsCancelled = await runDeadlineActions(challenge, now, pass);
    if (actionsCancelled) return actionsCancelled;

    // New-entry detection runs AFTER the deadline actions on purpose: auto-fill /
    // emergency fill / boost-turbo fill-new all reflect their new entry into
    // challenge.member.ranking.entries, so an entry submitted seconds ago in this
    // very cycle is detected in this very cycle rather than waiting for the next one.
    const entry = detectNewEntry(challenge, pass.entryTracker);
    // Use the centralized voting logic service
    const decision = votingLogic.evaluateVotingDecision(challenge, now, { hasNewEntry: entry.hasNewEntry });
    // What actually runs: a vote mission may turn a threshold-wait into a capped vote.
    const missionVote = missionVoteDecision(challenge, decision, pass, now);
    const voteDecision = missionVote?.decision ?? decision;

    if (entry.hasNewEntry) {
        logger
            .withCategory('voting')
            .info(
                `${logger.challengeTag(challenge)} New entry detected — ${describeNewEntryOutcome(voteDecision, missionVote !== null)}`,
                null,
            );
    }

    // onVoteLanded fires only when a cancel follows a submit that already
    // landed, so it records the snapshot with voteThrew=false; calling it from
    // a failure path would disarm a forced-vote retry.
    const vote = await voteOnChallenge(
        challenge,
        voteDecision,
        pass,
        () => recordEntrySnapshot(pass.entryTracker, entry, decision, false),
        missionVote?.maxVotes,
    );
    if (vote.cancelled) return vote.cancelled;

    recordEntrySnapshot(pass.entryTracker, entry, decision, vote.voteThrew);

    // Automatic exposure fill, AFTER the vote: a fill is only worth spending
    // when this pass's voting could not lift exposure to the fill threshold.
    // Failing that, a "Use Fill" mission may want one; either counts toward it.
    if (!vote.voteThrew) {
        const filled =
            (await currencyAuto.runAutoExposureFill(currencyCtx, vote.votePool)) ||
            (await currencyAuto.runMissionFill(currencyCtx, pass.missions?.fill ?? 0));
        if (filled) consumeMission(pass.missions, 'fill');
    }
    return null;
};

/**
 * The voting pass — see the file header.
 */
const runVotingPass = async (
    token: string,
    challengeIdFilter: string | number | null,
    deps: VotingPassDeps,
): Promise<VotingPassResult> => {
    const {
        api,
        cleanupStaleMetadata,
        interChallengeDelay,
        entryTracker = null,
        entryAges = null,
        currency = null,
        scenarios = null,
        missions = null,
        refreshMissionNeeds = null,
    } = deps;
    const fillDeps = buildFillDeps(api, entryAges);
    // Clear the photo-stats failure breaker so a pass that hit a rate limit does
    // not disable stat enrichment for every later pass in the session.
    photoStats.resetPassState();
    logger.withCategory('voting').startOperation('voting-process', 'Voting process');
    const unregisterMissionNeeds = registerMissionNeeds(token, missions);

    try {
        // Get all active challenges
        logger.withCategory('challenges').info('🔄 Loading active challenges', null);
        const turboSnapshot = turboRunSnapshot();
        const { challenges: allChallenges, fetchFailed } = await api.getActiveChallenges(token);

        // A failed fetch is not an empty account. makePostRequest resolves null once retries
        // are exhausted, which would otherwise arrive here as an empty list and be reported
        // as a successful pass with "No active challenges found" — an outage indistinguishable
        // from having nothing to vote on, with the scheduler re-arming as if all were well.
        if (fetchFailed) {
            return abortPass('Could not load active challenges — the API request failed', allChallenges, 'error');
        }

        logger.withCategory('challenges').info(`📋 Found ${allChallenges.length} active challenges`, null);

        if (allChallenges.length === 0) {
            logger.withCategory('challenges').warning('No active challenges found', null);
            logger.withCategory('voting').endOperation('voting-process', 'No challenges to process');
            return { success: true, message: 'No active challenges found', challenges: allChallenges };
        }

        if (cleanupStaleMetadata) pruneStaleMetadata(cleanupStaleMetadata, allChallenges);

        const scope = selectPassChallenges(allChallenges, challengeIdFilter);
        if (scope.result) return scope.result;
        const { challenges } = scope;

        const pass: PassContext = {
            token,
            api,
            fillDeps,
            interChallengeDelay,
            entryTracker,
            entryAges,
            currency,
            scenarios,
            missions,
            refreshMissionNeeds,
            missionVoteQuota: planMissionVotes(missions, challengeIdFilter, allChallenges),
            allChallenges,
            turboSnapshot,
        };

        // Process each challenge
        let processedCount = 0;
        for (const challenge of challenges) {
            processedCount++;

            // Current timestamp in seconds (Unix epoch time), re-read per challenge rather
            // than captured once for the whole pass. A pass spends 2-5s of inter-challenge
            // delay per challenge, plus retries (up to 30s per request), paginated library
            // walks and up to 25 get_image_data calls per fill — minutes in total. A single
            // pass-start clock would evaluate every later challenge against a time biased
            // into the past, missing last-minute/emergency/boost/turbo windows that opened
            // mid-pass and treating an already-closed challenge as still open.
            const now = Math.floor(Date.now() / 1000);

            // One malformed challenge must not cost the pass every challenge after it: an
            // unguarded property read would otherwise throw into the single outer catch
            // below and abandon the whole pass. Catching here lets the loop move on to the
            // next challenge; the cancellation checkpoints inside return a result rather
            // than throw, so cancellation still exits the pass immediately rather than
            // being swallowed as a per-challenge error.
            try {
                const cancelled = await processChallenge(challenge, now, processedCount, challenges.length, pass);
                if (cancelled) return cancelled;
            } catch (error) {
                logger
                    .withCategory('voting')
                    .error(
                        `${logger.challengeTag(challenge)} Skipped after an unexpected error — continuing with the remaining challenges`,
                        error,
                    );
            }
        }

        // Complete the voting process
        logger
            .withCategory('voting')
            .endOperation('voting-process', `All ${challenges.length} challenges processed successfully`);

        return { success: true, message: 'Voting process completed successfully', challenges: allChallenges };
    } catch (error) {
        logger.withCategory('voting').endOperation('voting-process', null, failureText(error));
        return {
            success: false,
            error: errorMessage(error) || 'Voting process failed',
        };
    } finally {
        unregisterMissionNeeds?.();
    }
};

export { runVotingPass, resetMissionVoteLog };
export type { PassContext };
