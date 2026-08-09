/**
 * The voting-pass orchestration shared by BOTH API strategies. Previously
 * api/main.js and mock/index.js each carried a hand-maintained copy of this
 * loop, and the mock fork had already silently lost auto-fill, emergency
 * fill, turbo-earn, and the timer-ordered deadline actions. Now the mock
 * runs the identical strategy path over its fake endpoints.
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
 * Runners execute SEQUENTIALLY by design: auto-fill mutates the shared
 * challenge object (reflectNewEntry) so a later turbo/boost in the same
 * cycle sees the consumed slot and new entry. Do not parallelize them.
 *
 * @param {string} token
 * @param {string|number|null} challengeIdFilter - restricts the strategy pass
 *   to one challenge (per-card "Run"); stale-metadata cleanup still runs
 *   against the full active list first.
 * @param {{
 *   api: {
 *     getActiveChallenges: Function,
 *     getVoteImages: Function,
 *     submitVotes: Function,
 *     applyBoost: Function,
 *     applyBoostToEntry: Function,
 *     applyTurbo: Function,
 *     getEligiblePhotos: Function,
 *     submitToChallenge: Function,
 *     runTurboMiniGame: Function,
 *   },
 *   cleanupStaleMetadata: (Function|null),
 *   interChallengeDelay: () => number,
 *   entryTracker?: ({get: Function, set: Function}|null),
 * }} deps
 *   `entryTracker` backs the voteOnNewEntry feature. Real mode passes a
 *   metadata.json-backed tracker; mock passes an in-memory one for the same reason
 *   it passes cleanupStaleMetadata: null — the metadata store is shared and
 *   un-namespaced, and mock challenge ids would accumulate there unpruned. Omitting
 *   it entirely makes the feature inert.
 * @returns {Promise<{success:boolean, message?:string, error?:string, challenges?:Array}>}
 *   `challenges` is the full active list this cycle fetched (not the
 *   filtered subset) so callers can reuse it for threshold scheduling.
 */

const logger = require('../logger');
const settings = require('../settings');
const votingLogic = require('./VotingLogic');
const autoFill = require('./autoFill');
const newEntryTracker = require('./newEntryTracker');
const cancellation = require('../voting/cancellation');
const { formatDuration } = require('../format/duration');
const { sleep } = require('../timing');

/**
 * Per-challenge context threaded to every deadline-action runner. All of a
 * runner's per-pass state comes through here explicitly — module-scope
 * imports (logger, settings, votingLogic, autoFill, formatDuration) are the
 * only other things they touch.
 *
 * @typedef {{
 *   challenge: Object,
 *   token: string,
 *   now: number,
 *   api: Object,
 *   fillDeps: Object,
 * }} ActionContext
 */

/** @param {ActionContext} ctx */
const runBoost = async (ctx) => {
    const { challenge, token, now, api, fillDeps } = ctx;
    // Check if boost is available for this challenge
    const { boost } = challenge.member;
    const hasTimeout = typeof boost.timeout === 'number' && boost.timeout > 0;
    const isTimerBasedAvailable = boost.state === 'AVAILABLE' && hasTimeout;
    const isKeyUnlockedAvailable = boost.state === 'AVAILABLE_KEY' || (boost.state === 'AVAILABLE' && !hasTimeout);
    if (!isTimerBasedAvailable && !isKeyUnlockedAvailable) return;

    logger.withCategory('voting').info(`${logger.challengeTag(challenge)} Boost available`, null);

    // Use the centralized voting logic service for boost decisions.
    // emergency:true lets shouldApplyBoost apply an available boost
    // near the deadline even if autoBoost is off for this challenge.
    const shouldApplyBoost = votingLogic.shouldApplyBoost(challenge, now, { emergency: true });
    const effectiveBoostTime = votingLogic.getEffectiveBoostTime(challenge.id.toString());
    // For timer-based availability use boost.timeout; for key-unlocked use challenge end time
    const timeUntilDisplayBase = isTimerBasedAvailable ? boost.timeout - now : challenge.close_time - now;

    if (shouldApplyBoost) {
        // Surface the override so an applied boost on a challenge with
        // Auto-Apply Boost off is explained rather than looking like a bug.
        if (!settings.getEffectiveSetting('autoBoost', challenge.id.toString())) {
            logger
                .withCategory('boost')
                .info(
                    `${logger.challengeTag(challenge)} Emergency Fill window — applying available boost despite Auto-Apply Boost being off`,
                    null,
                );
        }
        const timeDisplay = formatDuration(timeUntilDisplayBase);

        const applyingMsg = isTimerBasedAvailable
            ? `Applying boost to challenge ${challenge.title}`
            : `Applying boost to challenge ${challenge.title} (key-unlocked)`;
        logger.withCategory('boost').startOperation(`boost-${challenge.id}`, applyingMsg);

        try {
            const cid = challenge.id.toString();
            let boostResult;
            if (settings.getEffectiveSetting('boostFillNew', cid) === true) {
                // Fill-new: submit a fresh photo and boost that entry instead
                // of an existing one. Falls back to the configured Boost Entry
                // when no fresh photo can be submitted (full / none / failed).
                const filled = await autoFill.submitNewEntryForAction(challenge, token, fillDeps);
                if (filled.ok) {
                    autoFill.reflectNewEntry(challenge, filled.imageId);
                    boostResult = await api.applyBoostToEntry(cid, filled.imageId, token);
                } else if (filled.reason === 'challenge-gone') {
                    // The live re-check confirmed the challenge left the
                    // active list — boosting an existing entry on it would
                    // just be a second failing call and a confusing log.
                    logger
                        .withCategory('boost')
                        .endOperation(`boost-${challenge.id}`, null, 'challenge left the active list — boost skipped');
                    return;
                } else {
                    logger
                        .withCategory('boost')
                        .info(
                            `${logger.challengeTag(challenge)} boost fill-new unavailable (${filled.reason}); boosting existing entry`,
                            null,
                        );
                    boostResult = await api.applyBoost(challenge, token);
                }
            } else {
                boostResult = await api.applyBoost(challenge, token);
            }
            if (boostResult) {
                const successSuffix = isTimerBasedAvailable
                    ? `${timeDisplay} remaining`
                    : `${timeDisplay} until challenge ends`;
                logger
                    .withCategory('boost')
                    .endOperation(`boost-${challenge.id}`, `Boost applied successfully (${successSuffix})`);
            }
            // On null/falsy result, applyBoost already logged endOperation with the failure
            // reason — no caller-side fallback log needed (mirrors the turbo handling shape).
        } catch (error) {
            logger.withCategory('boost').endOperation(`boost-${challenge.id}`, null, error.message || error);
        }
    } else {
        const timeDisplay = formatDuration(timeUntilDisplayBase);
        const reason = isTimerBasedAvailable
            ? `${timeDisplay} until deadline (threshold: ${effectiveBoostTime / 60}m)`
            : `${timeDisplay} until challenge ends (needs ≤ 10m to auto-apply)`;
        logger.withCategory('voting').info(`${logger.challengeTag(challenge)} Boost not ready - ${reason}`, null);
    }
};

/** @param {ActionContext} ctx */
const runTurboApply = async (ctx) => {
    const { challenge, token, now, api, fillDeps } = ctx;
    // Auto-apply a won turbo when eligible. emergency:true lets
    // shouldApplyTurbo apply a won turbo near the deadline even if
    // Auto-Apply Turbo (useTurbo) is off for this challenge.
    const turboApply = votingLogic.shouldApplyTurbo(challenge, now, { emergency: true });
    if (!turboApply.apply) return;

    // Surface the override so an applied turbo on a challenge with
    // Auto-Apply Turbo off is explained rather than looking like a bug.
    if (!settings.getEffectiveSetting('useTurbo', challenge.id.toString())) {
        logger
            .withCategory('turbo')
            .info(
                `${logger.challengeTag(challenge)} Emergency Fill window — applying won turbo despite Auto-Apply Turbo being off`,
                null,
            );
    }

    let imageId = turboApply.imageId;
    if (turboApply.fillNew) {
        // Fill-new: submit a fresh photo and turbo that entry instead of an
        // existing one. Falls back to the configured Turbo Entry (if any)
        // when no fresh photo can be submitted (full / none / failed).
        const filled = await autoFill.submitNewEntryForAction(challenge, token, fillDeps);
        if (filled.ok) {
            autoFill.reflectNewEntry(challenge, filled.imageId);
            imageId = filled.imageId;
        } else if (filled.reason === 'challenge-gone') {
            // The live re-check confirmed the challenge left the active
            // list — applying turbo to an existing entry on it would just
            // be a second failing call and a confusing log.
            logger
                .withCategory('turbo')
                .info(
                    `${logger.challengeTag(challenge)} turbo fill-new: challenge left the active list — turbo skipped`,
                    null,
                );
            return;
        } else if (imageId) {
            logger
                .withCategory('turbo')
                .info(
                    `${logger.challengeTag(challenge)} turbo fill-new unavailable (${filled.reason}); applying to existing entry`,
                    null,
                );
        }
    }
    if (!imageId) {
        logger
            .withCategory('turbo')
            .info(
                `${logger.challengeTag(challenge)} turbo fill-new could not submit a photo and there is no existing entry — skipped`,
                null,
            );
    } else {
        logger
            .withCategory('turbo')
            .startOperation(`turbo-apply-${challenge.id}`, `Applying turbo to entry ${imageId} on ${challenge.title}`);
        try {
            const result = await api.applyTurbo(challenge.id, imageId, token);
            if (result.ok) {
                logger
                    .withCategory('turbo')
                    .endOperation(`turbo-apply-${challenge.id}`, `Turbo applied to entry ${imageId}`);
            } else {
                logger
                    .withCategory('turbo')
                    .endOperation(`turbo-apply-${challenge.id}`, null, 'Apply request returned ok=false');
            }
        } catch (error) {
            logger.withCategory('turbo').endOperation(`turbo-apply-${challenge.id}`, null, error.message || error);
        }
    }
};

/** @param {ActionContext} ctx */
const runAutoFill = async (ctx) => {
    const { challenge, token, now, fillDeps } = ctx;
    // Auto-fill missing entries near deadline (one slot per cycle, staggered).
    // On submit it reflects the new entry locally, so a turbo/boost that runs
    // later this cycle (timer order) acts on it instead of waiting a cycle.
    const fillResult = await autoFill.maybeAutoFillChallenge(challenge, token, now, fillDeps);
    if (fillResult === 'submitted') {
        logger
            .withCategory('voting')
            .info(
                `${logger.challengeTag(challenge)} autoFill: entry submitted (available to later actions this cycle)`,
                null,
            );
    }
};

/** @param {ActionContext} ctx */
const runEmergencyFill = async (ctx) => {
    const { challenge, token, now, fillDeps } = ctx;
    // Emergency fill: net for slots that staggered auto-fill leaves
    // empty (auto-fill off, or tags set with no match) — fills all
    // remaining slots once the challenge is inside the emergency window.
    const emergencyResult = await autoFill.maybeEmergencyFillChallenge(challenge, token, now, fillDeps);
    if (emergencyResult === 'submitted') {
        logger
            .withCategory('voting')
            .info(`${logger.challengeTag(challenge)} emergencyFill: entries submitted near deadline`, null);
    }
};

const actionRunners = {
    boost: runBoost,
    turbo: runTurboApply,
    autoFill: runAutoFill,
    emergencyFill: runEmergencyFill,
};

const runVotingPass = async (token, challengeIdFilter, deps) => {
    const { api, cleanupStaleMetadata, interChallengeDelay, entryTracker = null } = deps;
    // Shared dependency bundle for every auto-fill entry point this pass
    // (fill-new on boost/turbo, staggered auto-fill, emergency fill).
    const fillDeps = {
        settings,
        logger,
        getEligiblePhotos: api.getEligiblePhotos,
        submitToChallenge: api.submitToChallenge,
        getActiveChallenges: api.getActiveChallenges,
    };
    logger.withCategory('voting').startOperation('voting-process', 'Voting process');

    try {
        // Get all active challenges
        logger.withCategory('challenges').info('🔄 Loading active challenges', null);
        const { challenges: allChallenges } = await api.getActiveChallenges(token);
        // Current timestamp in seconds (Unix epoch time)
        const now = Math.floor(Date.now() / 1000);

        logger.withCategory('challenges').info(`📋 Found ${allChallenges.length} active challenges`, null);

        // Standard cancelled-pass exit shared by the per-challenge and
        // per-action cancellation checks: one warn, close the operation,
        // surface the full active list.
        const cancelledResult = () => {
            logger.withCategory('voting').warning('🛑 Voting cancelled by user', null);
            logger.withCategory('voting').endOperation('voting-process', null, 'Voting cancelled by user');
            return { success: false, message: 'Voting cancelled by user', challenges: allChallenges };
        };

        if (allChallenges.length === 0) {
            logger.withCategory('challenges').warning('No active challenges found', null);
            logger.withCategory('voting').endOperation('voting-process', 'No challenges to process');
            return { success: true, message: 'No active challenges found', challenges: allChallenges };
        }

        // Cleanup stale metadata against the full active list — must
        // run before any per-challenge filter so we don't drop metadata
        // for challenges the user is simply not running this pass.
        if (cleanupStaleMetadata) {
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
        }

        let challenges = allChallenges;
        if (challengeIdFilter != null) {
            const idStr = String(challengeIdFilter);
            challenges = allChallenges.filter((c) => String(c.id) === idStr);
            if (challenges.length === 0) {
                const msg = `Challenge ${idStr} is not active`;
                logger.withCategory('challenges').warning(msg, null);
                logger.withCategory('voting').endOperation('voting-process', null, msg);
                return { success: false, error: msg, challenges: allChallenges };
            }
            logger
                .withCategory('voting')
                .info(`🎯 Run scoped to single challenge: ${challenges[0].title} (${idStr})`, null);
        }

        // Process each challenge
        let processedCount = 0;
        for (const challenge of challenges) {
            processedCount++;

            // Check for cancellation before processing each challenge
            if (cancellation.isCancelled()) {
                return cancelledResult();
            }

            // Log progress
            logger
                .withCategory('voting')
                .progress(
                    `Processing challenge ${processedCount}/${challenges.length}: ${challenge.title}`,
                    processedCount,
                    challenges.length,
                );

            // Auto-earn turbo by playing the mini-game when eligible. This has no
            // close-time threshold (it plays whenever a turbo is winnable), and a
            // turbo earned this cycle can't be applied until the next cycle re-fetches
            // state, so it runs ahead of the timer-ordered deadline actions below.
            if (votingLogic.shouldPlayAutoTurbo(challenge, now)) {
                logger
                    .withCategory('turbo')
                    .startOperation(`turbo-earn-${challenge.id}`, `Playing turbo mini-game on ${challenge.title}`);
                try {
                    const result = await api.runTurboMiniGame(challenge, token);
                    const summary = `played=${result.played} correct=${result.correct} flipped=${result.flipped} doubleFailed=${result.doubleFailed} won=${result.won}`;
                    logger.withCategory('turbo').endOperation(`turbo-earn-${challenge.id}`, summary);
                } catch (error) {
                    logger
                        .withCategory('turbo')
                        .endOperation(`turbo-earn-${challenge.id}`, null, error.message || error);
                }
            }

            // Deadline actions (boost / auto-fill / turbo apply / emergency fill) run
            // in the order their configured timers imply — largest seconds-before-close
            // window first — instead of a fixed code order, so e.g. auto-fill (15m) acts
            // before turbo (12m) when both are due. Each runner keeps its own full
            // eligibility check, so an action that isn't actually due just no-ops.
            const actionCtx = { challenge, token, now, api, fillDeps };
            for (const { action } of votingLogic.orderDeadlineActions(challenge)) {
                // Honor cancellation between actions, same as the per-challenge guard.
                if (cancellation.isCancelled()) {
                    return cancelledResult();
                }
                // Defensive: orderDeadlineActions only emits the four known keys, but
                // guard the dispatch so a future action added there without a matching
                // runner degrades to a skip instead of throwing and aborting the loop.
                const run = actionRunners[action];
                if (typeof run === 'function') await run(actionCtx);
            }

            // New-entry detection (voteOnNewEntry). Runs AFTER the deadline actions
            // above on purpose: auto-fill / emergency fill / boost-turbo fill-new all
            // reflect their new entry into challenge.member.ranking.entries, so an
            // entry submitted seconds ago in this very cycle is detected in this very
            // cycle rather than waiting for the next one.
            //
            // The setting is read HERE and nowhere else — VotingLogic takes the
            // already-gated boolean. Gating the whole block (not just the decision)
            // keeps the feature genuinely opt-in: metadata.json is a synchronous
            // whole-file read/write, and a user who never enables this should pay
            // none of it.
            const challengeId = challenge.id.toString();
            const tracking =
                entryTracker && settings.getEffectiveSetting('voteOnNewEntry', challengeId) === true
                    ? newEntryTracker.readEntryIds(challenge)
                    : null;
            const hasNewEntry = tracking
                ? newEntryTracker.hasNewEntries(entryTracker.get(challengeId), tracking)
                : false;
            if (hasNewEntry) {
                logger
                    .withCategory('voting')
                    .info(`${logger.challengeTag(challenge)} New entry detected — forcing a vote this cycle`, null);
            }

            // Use the centralized voting logic service
            const { shouldVote, voteReason, targetExposure, forcedByNewEntry } = votingLogic.evaluateVotingDecision(
                challenge,
                now,
                { hasNewEntry },
            );
            let voteThrew = false;

            // Vote on challenge if conditions are met
            if (shouldVote) {
                logger
                    .withCategory('voting')
                    .startOperation(`vote-${challenge.id}`, `Voting on ${logger.challengeTag(challenge)}`, 'DEBUG');

                try {
                    // Check for cancellation before voting
                    if (cancellation.isCancelled()) {
                        logger
                            .withCategory('voting')
                            .warning('🛑 Voting cancelled by user during challenge processing', null);
                        logger.withCategory('voting').endOperation('voting-process', null, 'Voting cancelled by user');
                        return { success: false, message: 'Voting cancelled by user', challenges: allChallenges };
                    }

                    logger
                        .withCategory('voting')
                        .info(`${logger.challengeTag(challenge)} Starting voting process - ${voteReason}`, null);

                    // Get images to vote on
                    const voteImages = await api.getVoteImages(challenge, token);
                    if (voteImages && voteImages.images) {
                        // Check for cancellation before submitting votes
                        if (cancellation.isCancelled()) {
                            logger
                                .withCategory('voting')
                                .warning('🛑 Voting cancelled by user before vote submission', null);
                            logger
                                .withCategory('voting')
                                .endOperation('voting-process', null, 'Voting cancelled by user');
                            return { success: false, message: 'Voting cancelled by user', challenges: allChallenges };
                        }

                        logger
                            .withCategory('voting')
                            .info(
                                `${logger.challengeTag(challenge)} Submitting votes for ${voteImages.images.length} images`,
                                null,
                            );

                        // Submit votes to target exposure (dynamic based on voting rules)
                        await api.submitVotes(voteImages, token, targetExposure);

                        // Check for cancellation before delay
                        if (cancellation.isCancelled()) {
                            logger
                                .withCategory('voting')
                                .warning('🛑 Voting cancelled by user after vote submission', null);
                            logger
                                .withCategory('voting')
                                .endOperation('voting-process', null, 'Voting cancelled by user');
                            return { success: false, message: 'Voting cancelled by user', challenges: allChallenges };
                        }

                        logger.withCategory('voting').endOperation(`vote-${challenge.id}`, 'voting attempt complete');

                        // Add a delay between challenges (strategy-specific pacing)
                        const delay = interChallengeDelay();
                        logger.withCategory('voting').debug(`Adding ${delay}ms delay between challenges`, null);
                        await sleep(delay);
                    } else {
                        // No images is a valid "nothing to do" state — close the op as a
                        // DEBUG success (silent) and surface one WARN for user visibility.
                        logger.withCategory('voting').endOperation(`vote-${challenge.id}`, 'no vote images available');
                        logger
                            .withCategory('voting')
                            .warning(`${logger.challengeTag(challenge)} No vote images available — skipping`, null);
                    }
                } catch (error) {
                    voteThrew = true;
                    logger.withCategory('voting').endOperation(`vote-${challenge.id}`, null, error.message || error);
                }
            } else {
                // Log why voting was skipped
                logger
                    .withCategory('voting')
                    .info(`${logger.challengeTag(challenge)} Skipping voting - ${voteReason}`, null);
            }

            // Record the entry snapshot, which disarms the trigger. Skipped only when
            // a vote this trigger FORCED threw, so the next cycle retries it — that is
            // the whole retry contract. Deliberately NOT skipped for:
            //   - "no vote images available", which is not a throw; treating it as a
            //     failure would force a getVoteImages call every cycle forever on a
            //     challenge that never has any.
            //   - a blocked decision (onlyBoost / vote-only-in-last-minute /
            //     scheduled-fill-only / not started), which consumes the trigger.
            //     Every block that can later lift, lifts into a rule that already
            //     votes to 100% or re-reads exposure from scratch, so nothing is lost.
            if (tracking && !(forcedByNewEntry && voteThrew)) {
                entryTracker.set(challengeId, tracking);
            }
        }

        // Complete the voting process
        logger
            .withCategory('voting')
            .endOperation('voting-process', `All ${challenges.length} challenges processed successfully`);

        return { success: true, message: 'Voting process completed successfully', challenges: allChallenges };
    } catch (error) {
        logger.withCategory('voting').endOperation('voting-process', null, error.message || error);
        return { success: false, error: error.message || 'Voting process failed' };
    }
};

module.exports = { runVotingPass };
