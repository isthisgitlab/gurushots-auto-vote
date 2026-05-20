/**
 * GuruShots Auto Voter - Main Orchestration Module
 *
 * This module orchestrates all the voting operations by coordinating
 * between challenges, voting, and boost modules.
 */

const { getActiveChallenges } = require('./challenges');
const { getVoteImages, submitVotes } = require('./voting');
const { applyBoost, applyBoostToEntry } = require('./boost');
const { getChallengeTurbo, submitTurboSelection, applyTurbo, TURBO_SELECTION_DELAY_MS } = require('./turbo');
const { getEligiblePhotos, submitToChallenge } = require('./submissions');
const { cleanupStaleMetadata } = require('../metadata');
const { sleep, getRandomDelay } = require('./utils');
const logger = require('../logger');
const settings = require('../settings');
const votingLogic = require('../services/VotingLogic');
const autoFill = require('../services/autoFill');
const cancellation = require('../voting/cancellation');

/**
 * Plays through the Turbo mini-game for a single challenge.
 * Iterates pair-by-pair, picks first_image, flips to second_image on a wrong
 * pick, and stops early once the response reports state === 'WON'.
 */
const runTurboMiniGame = async (challenge, token) => {
    const set = await getChallengeTurbo(challenge.id, token);
    if (!set) {
        logger.withCategory('turbo').warning(`${logger.challengeTag(challenge)} No turbo battle set returned`, null);
        return { played: 0, correct: 0, flipped: 0, doubleFailed: 0, won: false };
    }

    let played = 0;
    let correct = 0;
    let flipped = 0;
    let doubleFailed = 0;
    let won = false;

    for (const battle of set.battles) {
        if (battle.isSuccess !== null) continue;
        if (!battle.firstImageId || !battle.secondImageId) {
            doubleFailed++;
            continue;
        }

        played++;
        const first = await submitTurboSelection(challenge.id, battle.firstImageId, token);
        if (first.ok) {
            correct++;
            if (first.state === 'WON') {
                won = true;
                break;
            }
            await sleep(TURBO_SELECTION_DELAY_MS);
            continue;
        }

        // First pick lost or errored — flip to the other image.
        await sleep(TURBO_SELECTION_DELAY_MS);
        const second = await submitTurboSelection(challenge.id, battle.secondImageId, token);
        if (second.ok) {
            correct++;
            flipped++;
            if (second.state === 'WON') {
                won = true;
                break;
            }
        } else {
            doubleFailed++;
            const code = second.errorCode || first.errorCode;
            if (code) {
                logger
                    .withCategory('turbo')
                    .warning(`${logger.challengeTag(challenge)} Turbo battle skipped, error_code=${code}`, null);
            }
        }
        await sleep(TURBO_SELECTION_DELAY_MS);
    }

    return { played, correct, flipped, doubleFailed, won };
};

// Thin delegate kept for backward compatibility with index.js callers.
const setCancellationFlag = (cancel) => {
    cancellation.setCancelled(cancel);
};

/**
 * Main function that fetches active challenges and processes them
 *
 * This function:
 * 1. Gets all active challenges for the user
 * 2. For each challenge:
 *    - Applies boosts if available and close to deadline
 *    - Votes on images if exposure factor is less than the exposure threshold
 *
 * @param {string} token - Authentication token
 * @param {number|function} [getExposureThreshold] - Optional exposure-threshold resolver kept for caller backward-compat; unused internally (the voting-logic service reads settings directly).
 * @param {string|number} [challengeIdFilter] - When set, restricts the strategy pass to a single challenge (per-card "Run"). Stale-metadata cleanup still runs against the full active list before filtering.
 * @returns {void}
 */
// eslint-disable-next-line no-unused-vars
const fetchChallengesAndVote = async (token, getExposureThreshold = null, challengeIdFilter = null) => {
    logger.withCategory('voting').startOperation('voting-process', 'Voting process');

    try {
        // Get all active challenges
        logger.withCategory('challenges').info('🔄 Loading active challenges', null);
        const { challenges: allChallenges } = await getActiveChallenges(token);
        // Current timestamp in seconds (Unix epoch time)
        const now = Math.floor(Date.now() / 1000);

        logger.withCategory('challenges').info(`📋 Found ${allChallenges.length} active challenges`, null);

        if (allChallenges.length === 0) {
            logger.withCategory('challenges').warning('No active challenges found', null);
            logger.withCategory('voting').endOperation('voting-process', 'No challenges to process');
            return { success: true, message: 'No active challenges found' };
        }

        // Cleanup stale metadata against the full active list — must
        // run before any per-challenge filter so we don't drop metadata
        // for challenges the user is simply not running this pass.
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

        let challenges = allChallenges;
        if (challengeIdFilter != null) {
            const idStr = String(challengeIdFilter);
            challenges = allChallenges.filter((c) => String(c.id) === idStr);
            if (challenges.length === 0) {
                const msg = `Challenge ${idStr} is not active`;
                logger.withCategory('challenges').warning(msg, null);
                logger.withCategory('voting').endOperation('voting-process', null, msg);
                return { success: false, error: msg };
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
                logger.withCategory('voting').warning('🛑 Voting cancelled by user', null);
                logger.withCategory('voting').endOperation('voting-process', null, 'Voting cancelled by user');
                return { success: false, message: 'Voting cancelled by user' };
            }

            // Log progress
            logger
                .withCategory('voting')
                .progress(
                    `Processing challenge ${processedCount}/${challenges.length}: ${challenge.title}`,
                    processedCount,
                    challenges.length,
                );

            // Note: effectiveThreshold is now handled by the voting logic service

            // Check if boost is available for this challenge
            const { boost } = challenge.member;
            const hasTimeout = typeof boost.timeout === 'number' && boost.timeout > 0;
            const isTimerBasedAvailable = boost.state === 'AVAILABLE' && hasTimeout;
            const isKeyUnlockedAvailable =
                boost.state === 'AVAILABLE_KEY' || (boost.state === 'AVAILABLE' && !hasTimeout);
            if (isTimerBasedAvailable || isKeyUnlockedAvailable) {
                logger.withCategory('voting').info(`${logger.challengeTag(challenge)} Boost available`, null);

                // Use the centralized voting logic service for boost decisions
                const shouldApplyBoost = votingLogic.shouldApplyBoost(challenge, now);
                const effectiveBoostTime = votingLogic.getEffectiveBoostTime(challenge.id.toString());
                // For timer-based availability use boost.timeout; for key-unlocked use challenge end time
                const timeUntilDisplayBase = isTimerBasedAvailable ? boost.timeout - now : challenge.close_time - now;

                if (shouldApplyBoost) {
                    const minutesRemaining = Math.floor(timeUntilDisplayBase / 60);
                    const hoursRemaining = Math.floor(minutesRemaining / 60);
                    const timeDisplay =
                        hoursRemaining > 0 ? `${hoursRemaining}h ${minutesRemaining % 60}m` : `${minutesRemaining}m`;

                    const applyingMsg = isTimerBasedAvailable
                        ? `Applying boost to challenge ${challenge.title}`
                        : `Applying boost to challenge ${challenge.title} (key-unlocked)`;
                    logger.withCategory('boost').startOperation(`boost-${challenge.id}`, applyingMsg);

                    try {
                        const boostResult = await applyBoost(challenge, token);
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
                        logger
                            .withCategory('boost')
                            .endOperation(`boost-${challenge.id}`, null, error.message || error);
                    }
                } else {
                    const minutesRemaining = Math.floor(timeUntilDisplayBase / 60);
                    const timeDisplay =
                        minutesRemaining > 60
                            ? `${Math.floor(minutesRemaining / 60)}h ${minutesRemaining % 60}m`
                            : `${minutesRemaining}m`;
                    const reason = isTimerBasedAvailable
                        ? `${timeDisplay} until deadline (threshold: ${effectiveBoostTime / 60}m)`
                        : `${timeDisplay} until challenge ends (needs ≤ 10m to auto-apply)`;
                    logger
                        .withCategory('voting')
                        .info(`${logger.challengeTag(challenge)} Boost not ready - ${reason}`, null);
                }
            }

            // Auto-earn turbo by playing the mini-game when eligible
            if (votingLogic.shouldPlayAutoTurbo(challenge, now)) {
                logger
                    .withCategory('turbo')
                    .startOperation(`turbo-earn-${challenge.id}`, `Playing turbo mini-game on ${challenge.title}`);
                try {
                    const result = await runTurboMiniGame(challenge, token);
                    const summary = `played=${result.played} correct=${result.correct} flipped=${result.flipped} doubleFailed=${result.doubleFailed} won=${result.won}`;
                    logger.withCategory('turbo').endOperation(`turbo-earn-${challenge.id}`, summary);
                } catch (error) {
                    logger
                        .withCategory('turbo')
                        .endOperation(`turbo-earn-${challenge.id}`, null, error.message || error);
                }
            }

            // Auto-apply a won turbo when eligible
            const turboApply = votingLogic.shouldApplyTurbo(challenge, now);
            if (turboApply.apply) {
                logger
                    .withCategory('turbo')
                    .startOperation(
                        `turbo-apply-${challenge.id}`,
                        `Applying turbo to entry ${turboApply.imageId} on ${challenge.title}`,
                    );
                try {
                    const result = await applyTurbo(challenge.id, turboApply.imageId, token);
                    if (result.ok) {
                        logger
                            .withCategory('turbo')
                            .endOperation(
                                `turbo-apply-${challenge.id}`,
                                `Turbo applied to entry ${turboApply.imageId}`,
                            );
                    } else {
                        logger
                            .withCategory('turbo')
                            .endOperation(`turbo-apply-${challenge.id}`, null, 'Apply request returned ok=false');
                    }
                } catch (error) {
                    logger
                        .withCategory('turbo')
                        .endOperation(`turbo-apply-${challenge.id}`, null, error.message || error);
                }
            }

            // Auto-fill missing entries near deadline (one slot per cycle, staggered)
            const fillResult = await autoFill.maybeAutoFillChallenge(challenge, token, now, {
                settings,
                logger,
                getEligiblePhotos,
                submitToChallenge,
            });
            if (fillResult === 'submitted') {
                logger
                    .withCategory('voting')
                    .info(
                        `${logger.challengeTag(challenge)} autoFill: entry submitted; boost/turbo will be evaluated on next cycle`,
                        null,
                    );
            }

            // Emergency fill: net for slots that staggered auto-fill leaves
            // empty (auto-fill off, or tags set with no match) — fills all
            // remaining slots once the challenge is inside the emergency window.
            const emergencyResult = await autoFill.maybeEmergencyFillChallenge(challenge, token, now, {
                settings,
                logger,
                getEligiblePhotos,
                submitToChallenge,
            });
            if (emergencyResult === 'submitted') {
                logger
                    .withCategory('voting')
                    .info(`${logger.challengeTag(challenge)} emergencyFill: entries submitted near deadline`, null);
            }

            // Use the centralized voting logic service
            const { shouldVote, voteReason, targetExposure } = votingLogic.evaluateVotingDecision(challenge, now);

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
                        return { success: false, message: 'Voting cancelled by user' };
                    }

                    logger
                        .withCategory('voting')
                        .info(`${logger.challengeTag(challenge)} Starting voting process - ${voteReason}`, null);

                    // Get images to vote on
                    const voteImages = await getVoteImages(challenge, token);
                    if (voteImages && voteImages.images) {
                        // Check for cancellation before submitting votes
                        if (cancellation.isCancelled()) {
                            logger
                                .withCategory('voting')
                                .warning('🛑 Voting cancelled by user before vote submission', null);
                            logger
                                .withCategory('voting')
                                .endOperation('voting-process', null, 'Voting cancelled by user');
                            return { success: false, message: 'Voting cancelled by user' };
                        }

                        logger
                            .withCategory('voting')
                            .info(
                                `${logger.challengeTag(challenge)} Submitting votes for ${voteImages.images.length} images`,
                                null,
                            );

                        // Submit votes to target exposure (dynamic based on voting rules)
                        await submitVotes(voteImages, token, targetExposure);

                        // Check for cancellation before delay
                        if (cancellation.isCancelled()) {
                            logger
                                .withCategory('voting')
                                .warning('🛑 Voting cancelled by user after vote submission', null);
                            logger
                                .withCategory('voting')
                                .endOperation('voting-process', null, 'Voting cancelled by user');
                            return { success: false, message: 'Voting cancelled by user' };
                        }

                        logger.withCategory('voting').endOperation(`vote-${challenge.id}`, 'voting attempt complete');

                        // Add random delay between challenges to mimic human behavior
                        const delay = getRandomDelay(2000, 5000);
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
                    logger.withCategory('voting').endOperation(`vote-${challenge.id}`, null, error.message || error);
                }
            } else {
                // Log why voting was skipped
                logger
                    .withCategory('voting')
                    .info(`${logger.challengeTag(challenge)} Skipping voting - ${voteReason}`, null);
            }
        }

        // Complete the voting process
        logger
            .withCategory('voting')
            .endOperation('voting-process', `All ${challenges.length} challenges processed successfully`);

        return { success: true, message: 'Voting process completed successfully' };
    } catch (error) {
        logger.withCategory('voting').endOperation('voting-process', null, error.message || error);
        return { success: false, error: error.message || 'Voting process failed' };
    }
};

module.exports = {
    fetchChallengesAndVote,
    setCancellationFlag,
    applyBoostToEntry,
    runTurboMiniGame,
};
