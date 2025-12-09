/**
 * GuruShots Auto Voter - Main Orchestration Module
 *
 * This module orchestrates all the voting operations by coordinating
 * between challenges, voting, and boost modules.
 */

const {getActiveChallenges} = require('./challenges');
const {getVoteImages, submitVotes} = require('./voting');
const {applyBoost, applyBoostToEntry} = require('./boost');
const {cleanupStaleMetadata} = require('../metadata');
const {sleep, getRandomDelay} = require('./utils');
const logger = require('../logger');
const votingLogic = require('../services/VotingLogic');

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
const fetchChallengesAndVote = async (token) => {
    logger.withCategory('voting').startOperation('voting-process', 'Voting process');
    
    try {
        // Get all active challenges
        logger.withCategory('challenges').info('🔄 Loading active challenges', null);
        const {challenges} = await getActiveChallenges(token);
        // Current timestamp in seconds (Unix epoch time)
        const now = Math.floor(Date.now() / 1000);
        
        logger.withCategory('challenges').info(`📋 Found ${challenges.length} active challenges`, null);
        
        if (challenges.length === 0) {
            logger.withCategory('challenges').warning('No active challenges found', null);
            logger.withCategory('voting').endOperation('voting-process', 'No challenges to process');
            return {success: true, message: 'No active challenges found'};
        }

        // Cleanup stale metadata for challenges that no longer exist
        try {
            const activeChallengeIds = challenges.map(challenge => challenge.id.toString());
            logger.withCategory('api').debug(`🔧 DEBUG: About to cleanup metadata, active challenge IDs: [${activeChallengeIds.join(', ')}]`, null);
            const cleanupSuccess = cleanupStaleMetadata(activeChallengeIds);
            if (cleanupSuccess) {
                logger.withCategory('api').debug('Successfully cleaned up stale metadata', null);
            } else {
                logger.withCategory('api').warning('Failed to cleanup stale metadata', null);
            }
        } catch (error) {
            logger.withCategory('api').warning('Error during metadata cleanup:', error);
        }

        // Process each challenge
        let processedCount = 0;
        for (const challenge of challenges) {
            processedCount++;
            
            // Check for cancellation before processing each challenge
            if (checkCancellation()) {
                logger.withCategory('voting').warning('🛑 Voting cancelled by user', null);
                logger.withCategory('voting').endOperation('voting-process', null, 'Voting cancelled by user');
                return {success: false, message: 'Voting cancelled by user'};
            }

            // Log progress
            logger.withCategory('voting').progress(`Processing challenge ${processedCount}/${challenges.length}: ${challenge.title}`, processedCount, challenges.length);

            // Note: effectiveThreshold is now handled by the voting logic service

            // Check if boost is available for this challenge
            const {boost} = challenge.member;
            const hasTimeout = typeof boost.timeout === 'number' && boost.timeout > 0;
            const isTimerBasedAvailable = boost.state === 'AVAILABLE' && hasTimeout;
            const isKeyUnlockedAvailable = boost.state === 'AVAILABLE_KEY' || (boost.state === 'AVAILABLE' && !hasTimeout);
            if (isTimerBasedAvailable || isKeyUnlockedAvailable) {
                logger.challengeInfo(challenge.id, challenge.title, 'Boost available');

                // Use the centralized voting logic service for boost decisions
                const shouldApplyBoost = votingLogic.shouldApplyBoost(challenge, now);
                const effectiveBoostTime = votingLogic.getEffectiveBoostTime(challenge.id.toString());
                // For timer-based availability use boost.timeout; for key-unlocked use challenge end time
                const timeUntilDisplayBase = isTimerBasedAvailable
                    ? (boost.timeout - now)
                    : (challenge.close_time - now);

                if (shouldApplyBoost) {
                    const minutesRemaining = Math.floor(timeUntilDisplayBase / 60);
                    const hoursRemaining = Math.floor(minutesRemaining / 60);
                    const timeDisplay = hoursRemaining > 0
                        ? `${hoursRemaining}h ${minutesRemaining % 60}m`
                        : `${minutesRemaining}m`;
                    
                    const applyingMsg = isTimerBasedAvailable
                        ? `Applying boost to challenge ${challenge.title}`
                        : `Applying boost to challenge ${challenge.title} (key-unlocked)`;
                    logger.withCategory('boost').startOperation(`boost-${challenge.id}`, applyingMsg);
                    
                    try {
                        await applyBoost(challenge, token);
                        const successSuffix = isTimerBasedAvailable
                            ? `${timeDisplay} remaining`
                            : `${timeDisplay} until challenge ends`;
                        logger.withCategory('boost').endOperation(`boost-${challenge.id}`, `Boost applied successfully (${successSuffix})`);
                    } catch (error) {
                        logger.withCategory('boost').endOperation(`boost-${challenge.id}`, null, error.message || error);
                    }
                } else {
                    const minutesRemaining = Math.floor(timeUntilDisplayBase / 60);
                    const timeDisplay = minutesRemaining > 60 
                        ? `${Math.floor(minutesRemaining / 60)}h ${minutesRemaining % 60}m`
                        : `${minutesRemaining}m`;
                    if (isTimerBasedAvailable) {
                        logger.challengeInfo(
                            challenge.id,
                            challenge.title,
                            `Boost not ready - ${timeDisplay} until deadline (threshold: ${effectiveBoostTime / 60}m)`,
                        );
                    } else {
                        // Key-unlocked path uses the 10-minute rule; omit timer threshold language
                        logger.challengeInfo(
                            challenge.id,
                            challenge.title,
                            `Boost not ready - ${timeDisplay} until challenge ends (needs ≤ 10m to auto-apply)`,
                        );
                    }
                }
            }

            // Use the centralized voting logic service
            const {shouldVote, voteReason, targetExposure} = votingLogic.evaluateVotingDecision(challenge, now);

            // Vote on challenge if conditions are met
            if (shouldVote) {
                logger.withCategory('voting').startOperation(`vote-${challenge.id}`, `Voting on challenge ${challenge.title}`);
                
                try {
                    // Check for cancellation before voting
                    if (checkCancellation()) {
                        logger.withCategory('voting').warning('🛑 Voting cancelled by user during challenge processing', null);
                        logger.withCategory('voting').endOperation('voting-process', null, 'Voting cancelled by user');
                        return {success: false, message: 'Voting cancelled by user'};
                    }

                    logger.challengeInfo(challenge.id, challenge.title, `Starting voting process - ${voteReason}`);

                    // Get images to vote on
                    const voteImages = await getVoteImages(challenge, token);
                    if (voteImages && voteImages.images) {
                        // Check for cancellation before submitting votes
                        if (checkCancellation()) {
                            logger.withCategory('voting').warning('🛑 Voting cancelled by user before vote submission', null);
                            logger.withCategory('voting').endOperation('voting-process', null, 'Voting cancelled by user');
                            return {success: false, message: 'Voting cancelled by user'};
                        }

                        logger.challengeInfo(challenge.id, challenge.title, `Submitting votes for ${voteImages.images.length} images`);

                        // Submit votes to target exposure (dynamic based on voting rules)
                        logger.withCategory('voting').debug(`🔧 DEBUG: About to submit votes for challenge ${challenge.id}: ${challenge.title} (target: ${targetExposure}%)`, null);
                        await submitVotes(voteImages, token, targetExposure);
                        logger.withCategory('voting').debug(`🔧 DEBUG: Completed vote submission for challenge ${challenge.id}: ${challenge.title}`, null);

                        // Check for cancellation before delay
                        if (checkCancellation()) {
                            logger.withCategory('voting').debug(`🔧 DEBUG: Cancellation detected after vote submission for challenge ${challenge.id}: ${challenge.title}`, null);
                            logger.withCategory('voting').warning('🛑 Voting cancelled by user after vote submission', null);
                            logger.withCategory('voting').endOperation('voting-process', null, 'Voting cancelled by user');
                            return {success: false, message: 'Voting cancelled by user'};
                        }

                        logger.withCategory('voting').endOperation(`vote-${challenge.id}`, 'Votes submitted successfully');

                        // Add random delay between challenges to mimic human behavior
                        const delay = getRandomDelay(2000, 5000);
                        logger.withCategory('voting').debug(`Adding ${delay}ms delay between challenges`, null);
                        await sleep(delay);
                    } else {
                        logger.challengeError(challenge.id, challenge.title, 'No vote images available');
                        logger.withCategory('voting').endOperation(`vote-${challenge.id}`, null, 'No vote images available');
                    }
                } catch (error) {
                    logger.challengeError(challenge.id, challenge.title, `Voting failed: ${error.message || error}`);
                    logger.withCategory('voting').endOperation(`vote-${challenge.id}`, null, error.message || error);
                }
            } else {
                // Log why voting was skipped
                logger.challengeInfo(challenge.id, challenge.title, `Skipping voting - ${voteReason}`);
            }
        }

        // Complete the voting process
        logger.withCategory('voting').endOperation('voting-process', `All ${challenges.length} challenges processed successfully`);

        return {success: true, message: 'Voting process completed successfully'};
    } catch (error) {
        logger.withCategory('voting').endOperation('voting-process', null, error.message || error);
        return {success: false, error: error.message || 'Voting process failed'};
    }
};

module.exports = {
    fetchChallengesAndVote,
    setCancellationFlag,
    applyBoostToEntry,
}; 