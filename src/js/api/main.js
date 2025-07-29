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
const {sleep, getRandomDelay} = require('./utils');

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
    try {
        // Get all active challenges
        const {challenges} = await getActiveChallenges(token);
        // Current timestamp in seconds (Unix epoch time)
        const now = Math.floor(Date.now() / 1000);

        // Process each challenge
        for (const challenge of challenges) {
            // Check for cancellation before processing each challenge
            if (checkCancellation()) {
                console.log('🛑 Voting cancelled by user');
                return {success: false, message: 'Voting cancelled by user'};
            }

            // Get the effective exposure threshold for this challenge
            const effectiveThreshold = typeof exposureThreshold === 'function'
                ? exposureThreshold(challenge.id.toString())
                : exposureThreshold;

            // Check if boost is available for this challenge
            const {boost} = challenge.member;
            if (boost.state === 'AVAILABLE' && boost.timeout) {
                console.log(`Boost available for challenge: ${challenge.title}`);

                // Get the effective boost time setting for this challenge
                const effectiveBoostTime = settings.getEffectiveSetting('boostTime', challenge.id.toString());
                const timeUntilDeadline = boost.timeout - now;

                if (timeUntilDeadline <= effectiveBoostTime && timeUntilDeadline > 0) {
                    const minutesRemaining = Math.floor(timeUntilDeadline / 60);
                    const hoursRemaining = Math.floor(minutesRemaining / 60);
                    const timeDisplay = hoursRemaining > 0
                        ? `${hoursRemaining}h ${minutesRemaining % 60}m`
                        : `${minutesRemaining}m`;
                    console.log(`Boost deadline is within ${timeDisplay} (${effectiveBoostTime / 60} minutes setting). Executing boost.`);
                    try {
                        await applyBoost(challenge, token);
                    } catch (error) {
                        console.error('Error during boost process:', error.message || error);
                    }
                }
            }

            // Check if boost-only mode is enabled for this challenge
            const onlyBoost = settings.getEffectiveSetting('onlyBoost', challenge.id.toString());

            // Get the effective lastminute threshold for this challenge
            const effectiveLastMinutes = settings.getEffectiveSetting('lastMinutes', challenge.id.toString());
            const timeUntilEnd = challenge.close_time - now;
            const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinutes * 60) && timeUntilEnd > 0;

            // Determine if we should vote based on lastminute threshold logic
            let shouldVote = false;
            let voteReason = '';

            if (onlyBoost) {
                // Skip voting if boost-only mode is enabled
                voteReason = 'boost-only mode enabled';
            } else if (challenge.start_time >= now) {
                // Skip voting if challenge hasn't started yet
                voteReason = 'challenge not started';
            } else if (isWithinLastMinuteThreshold) {
                // Within lastminute threshold: ignore exposure threshold, auto-vote if exposure < 100
                if (challenge.member.ranking.exposure.exposure_factor < 100) {
                    shouldVote = true;
                    voteReason = `lastminute threshold (${effectiveLastMinutes}m): exposure ${challenge.member.ranking.exposure.exposure_factor}% < 100%`;
                } else {
                    voteReason = `lastminute threshold (${effectiveLastMinutes}m): exposure already at 100%`;
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
                try {
                    // Check for cancellation before voting
                    if (checkCancellation()) {
                        console.log('🛑 Voting cancelled by user during challenge processing');
                        return {success: false, message: 'Voting cancelled by user'};
                    }

                    // Get images to vote on
                    const voteImages = await getVoteImages(challenge, token);
                    if (voteImages) {
                        // Check for cancellation before submitting votes
                        if (checkCancellation()) {
                            console.log('🛑 Voting cancelled by user before vote submission');
                            return {success: false, message: 'Voting cancelled by user'};
                        }

                        // Submit votes with the effective exposure threshold
                        await submitVotes(voteImages, token, effectiveThreshold);

                        // Check for cancellation before delay
                        if (checkCancellation()) {
                            console.log('🛑 Voting cancelled by user after vote submission');
                            return {success: false, message: 'Voting cancelled by user'};
                        }

                        // Add random delay between challenges to mimic human behavior
                        await sleep(getRandomDelay(2000, 5000));
                    }
                } catch (error) {
                    console.error(`Error voting on challenge: ${challenge.title}. Skipping to next challenge.`);
                    console.error(error.message || error);
                }
            } else {
                // Log why voting was skipped
                console.log(`Skipping voting on challenge: ${challenge.title} - ${voteReason}`);
            }
        }

        // Format completion time using Latvian locale (24-hour format)
        const completionTime = new Date().toLocaleTimeString('lv-LV');
        console.log(`Voting process completed for all challenges at ${completionTime}`);

        return {success: true, message: 'Voting process completed successfully'};
    } catch (error) {
        console.error('Error during voting process:', error.message || error);
        return {success: false, error: error.message || 'Voting process failed'};
    }
};

module.exports = {
    fetchChallengesAndVote,
    setCancellationFlag,
    applyBoostToEntry,
}; 