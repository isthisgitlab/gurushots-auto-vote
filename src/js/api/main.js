/**
 * GuruShots Auto Voter - Main Orchestration Module
 *
 * This module orchestrates all the voting operations by coordinating
 * between challenges, voting, and boost modules.
 */

const {getActiveChallenges} = require('./challenges');
const {getVoteImages, submitVotes} = require('./voting');
const {applyBoost, applyBoostToEntry} = require('./boost');
const settings = require('../settings');
const {cleanupStaleMetadata} = require('../metadata');
const {sleep, getRandomDelay} = require('./utils');
const logger = require('../logger');

// Global cancellation flag
let shouldCancelVoting = false;

// Function to check if voting should be cancelled
const checkCancellation = () => {
    return shouldCancelVoting;
};

// Function to set cancellation flag
const setCancellationFlag = (cancel) => {
    shouldCancelVoting = cancel;
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
 * @param {number|function} exposureThreshold - Exposure threshold (default: schema default) or function to get threshold per challenge
 * @returns {void}
 */
const fetchChallengesAndVote = async (token, exposureThreshold = settings.SETTINGS_SCHEMA.exposure.default) => {
    logger.startOperation('voting-process', 'Voting process');
    
    try {
        // Get all active challenges
        logger.info('🔄 Loading active challenges');
        const {challenges} = await getActiveChallenges(token);
        // Current timestamp in seconds (Unix epoch time)
        const now = Math.floor(Date.now() / 1000);
        
        logger.info(`📋 Found ${challenges.length} active challenges`);
        
        if (challenges.length === 0) {
            logger.warning('No active challenges found');
            logger.endOperation('voting-process', 'No challenges to process');
            return {success: true, message: 'No active challenges found'};
        }

        // Cleanup stale metadata for challenges that no longer exist
        try {
            const activeChallengeIds = challenges.map(challenge => challenge.id.toString());
            logger.debug(`🔧 DEBUG: About to cleanup metadata, active challenge IDs: [${activeChallengeIds.join(', ')}]`);
            const cleanupSuccess = cleanupStaleMetadata(activeChallengeIds);
            if (cleanupSuccess) {
                logger.debug('Successfully cleaned up stale metadata');
            } else {
                logger.warning('Failed to cleanup stale metadata');
            }
        } catch (error) {
            logger.warning('Error during metadata cleanup:', error);
        }

        // Process each challenge
        let processedCount = 0;
        for (const challenge of challenges) {
            processedCount++;
            
            // Check for cancellation before processing each challenge
            if (checkCancellation()) {
                logger.warning('🛑 Voting cancelled by user');
                logger.endOperation('voting-process', null, 'Voting cancelled by user');
                return {success: false, message: 'Voting cancelled by user'};
            }

            // Log progress
            logger.progress(`Processing challenge ${processedCount}/${challenges.length}: ${challenge.title}`, processedCount, challenges.length);

            // Get the effective exposure threshold for this challenge
            const effectiveThreshold = typeof exposureThreshold === 'function'
                ? exposureThreshold(challenge.id.toString())
                : exposureThreshold;

            // Check if boost is available for this challenge
            const {boost} = challenge.member;
            if (boost.state === 'AVAILABLE' && boost.timeout) {
                logger.challengeInfo(challenge.id, challenge.title, 'Boost available');

                // Get the effective boost time setting for this challenge
                const effectiveBoostTime = settings.getEffectiveSetting('boostTime', challenge.id.toString());
                const timeUntilDeadline = boost.timeout - now;

                if (timeUntilDeadline <= effectiveBoostTime && timeUntilDeadline > 0) {
                    const minutesRemaining = Math.floor(timeUntilDeadline / 60);
                    const hoursRemaining = Math.floor(minutesRemaining / 60);
                    const timeDisplay = hoursRemaining > 0
                        ? `${hoursRemaining}h ${minutesRemaining % 60}m`
                        : `${minutesRemaining}m`;
                    
                    logger.startOperation(`boost-${challenge.id}`, `Applying boost to challenge ${challenge.title}`);
                    
                    try {
                        await applyBoost(challenge, token);
                        logger.endOperation(`boost-${challenge.id}`, `Boost applied successfully (${timeDisplay} remaining)`);
                    } catch (error) {
                        logger.endOperation(`boost-${challenge.id}`, null, error.message || error);
                    }
                } else {
                    const minutesRemaining = Math.floor(timeUntilDeadline / 60);
                    const timeDisplay = minutesRemaining > 60 
                        ? `${Math.floor(minutesRemaining / 60)}h ${minutesRemaining % 60}m`
                        : `${minutesRemaining}m`;
                    logger.challengeInfo(challenge.id, challenge.title, `Boost not ready - ${timeDisplay} until deadline (threshold: ${effectiveBoostTime / 60}m)`);
                }
            }

            // Check if boost-only mode is enabled for this challenge
            const onlyBoost = settings.getEffectiveSetting('onlyBoost', challenge.id.toString());

            // Get the effective lastminute threshold for this challenge
            const effectiveLastMinuteThreshold = settings.getEffectiveSetting('lastMinuteThreshold', challenge.id.toString());
            const timeUntilEnd = challenge.close_time - now;
            const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinuteThreshold * 60) && timeUntilEnd > 0;

            // Check if we're within the last hour of the challenge
            const isWithinLastHour = timeUntilEnd <= 3600 && timeUntilEnd > 0; // 3600 seconds = 1 hour

            // Get the vote-only-in-last-threshold setting for this challenge
            const voteOnlyInLastMinute = settings.getEffectiveSetting('voteOnlyInLastMinute', challenge.id.toString());

            // Determine if we should vote based on lastminute threshold logic
            let shouldVote = false;
            let voteReason = '';

            if (onlyBoost) {
                // Skip voting if boost-only mode is enabled
                voteReason = 'boost-only mode enabled';
            } else if (challenge.start_time >= now) {
                // Skip voting if challenge hasn't started yet
                voteReason = 'challenge not started';
            } else if (challenge.type === 'flash') {
                // Flash type: ignore exposure threshold, boost only and vote when below 100
                if (challenge.member.ranking.exposure.exposure_factor < 100) {
                    shouldVote = true;
                    voteReason = `flash type: exposure ${challenge.member.ranking.exposure.exposure_factor}% < 100%`;
                } else {
                    voteReason = 'flash type: exposure already at 100%';
                }
            } else if (voteOnlyInLastMinute && !isWithinLastMinuteThreshold) {
                // Skip voting if vote-only-in-last-threshold is enabled and we're not within the last threshold
                voteReason = `vote-only-in-last-threshold enabled: not within last ${effectiveLastMinuteThreshold}m threshold`;
            } else if (isWithinLastMinuteThreshold) {
                // Within lastminute threshold: ignore exposure threshold, auto-vote if exposure < 100
                if (challenge.member.ranking.exposure.exposure_factor < 100) {
                    shouldVote = true;
                    voteReason = `lastminute threshold (${effectiveLastMinuteThreshold}m): exposure ${challenge.member.ranking.exposure.exposure_factor}% < 100%`;
                } else {
                    voteReason = `lastminute threshold (${effectiveLastMinuteThreshold}m): exposure already at 100%`;
                }
            } else if (isWithinLastHour) {
                // Within last hour: use lastHourExposure threshold
                const effectiveLastHourExposure = settings.getEffectiveSetting('lastHourExposure', challenge.id.toString());
                if (challenge.member.ranking.exposure.exposure_factor < effectiveLastHourExposure) {
                    shouldVote = true;
                    voteReason = `last hour threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% < ${effectiveLastHourExposure}%`;
                } else {
                    voteReason = `last hour threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% >= ${effectiveLastHourExposure}%`;
                }
            } else {
                // Normal logic: vote if exposure factor is less than the effective threshold
                if (challenge.member.ranking.exposure.exposure_factor < effectiveThreshold) {
                    shouldVote = true;
                    voteReason = `normal threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% < ${effectiveThreshold}%`;
                } else {
                    voteReason = `normal threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% >= ${effectiveThreshold}%`;
                }
            }

            // Vote on challenge if conditions are met
            if (shouldVote) {
                logger.startOperation(`vote-${challenge.id}`, `Voting on challenge ${challenge.title}`);
                
                try {
                    // Check for cancellation before voting
                    if (checkCancellation()) {
                        logger.warning('🛑 Voting cancelled by user during challenge processing');
                        logger.endOperation('voting-process', null, 'Voting cancelled by user');
                        return {success: false, message: 'Voting cancelled by user'};
                    }

                    logger.challengeInfo(challenge.id, challenge.title, `Starting voting process - ${voteReason}`);

                    // Get images to vote on
                    const voteImages = await getVoteImages(challenge, token);
                    if (voteImages && voteImages.images) {
                        // Check for cancellation before submitting votes
                        if (checkCancellation()) {
                            logger.warning('🛑 Voting cancelled by user before vote submission');
                            logger.endOperation('voting-process', null, 'Voting cancelled by user');
                            return {success: false, message: 'Voting cancelled by user'};
                        }

                        logger.challengeInfo(challenge.id, challenge.title, `Submitting votes for ${voteImages.images.length} images`);

                        // Submit votes to 100% (always vote to 100, not just to threshold)
                        logger.debug(`🔧 DEBUG: About to submit votes for challenge ${challenge.id}: ${challenge.title}`);
                        await submitVotes(voteImages, token);
                        logger.debug(`🔧 DEBUG: Completed vote submission for challenge ${challenge.id}: ${challenge.title}`);

                        // Check for cancellation before delay
                        if (checkCancellation()) {
                            logger.debug(`🔧 DEBUG: Cancellation detected after vote submission for challenge ${challenge.id}: ${challenge.title}`);
                            logger.warning('🛑 Voting cancelled by user after vote submission');
                            logger.endOperation('voting-process', null, 'Voting cancelled by user');
                            return {success: false, message: 'Voting cancelled by user'};
                        }

                        logger.endOperation(`vote-${challenge.id}`, 'Votes submitted successfully');

                        // Add random delay between challenges to mimic human behavior
                        const delay = getRandomDelay(2000, 5000);
                        logger.debug(`Adding ${delay}ms delay between challenges`);
                        await sleep(delay);
                    } else {
                        logger.challengeError(challenge.id, challenge.title, 'No vote images available');
                        logger.endOperation(`vote-${challenge.id}`, null, 'No vote images available');
                    }
                } catch (error) {
                    logger.challengeError(challenge.id, challenge.title, `Voting failed: ${error.message || error}`);
                    logger.endOperation(`vote-${challenge.id}`, null, error.message || error);
                }
            } else {
                // Log why voting was skipped
                logger.challengeInfo(challenge.id, challenge.title, `Skipping voting - ${voteReason}`);
            }
        }

        // Complete the voting process
        logger.endOperation('voting-process', `All ${challenges.length} challenges processed successfully`);

        return {success: true, message: 'Voting process completed successfully'};
    } catch (error) {
        logger.endOperation('voting-process', null, error.message || error);
        return {success: false, error: error.message || 'Voting process failed'};
    }
};

module.exports = {
    fetchChallengesAndVote,
    setCancellationFlag,
    applyBoostToEntry,
}; 