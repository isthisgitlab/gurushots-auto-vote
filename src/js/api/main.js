/**
 * GuruShots Auto Voter - Main Orchestration Module
 * 
 * This module orchestrates all the voting operations by coordinating
 * between challenges, voting, and boost modules.
 */

const { getActiveChallenges } = require('./challenges');
const { getVoteImages, submitVotes } = require('./voting');
const { applyBoost, applyBoostToEntry } = require('./boost');
const settings = require('../settings');
const { sleep, getRandomDelay } = require('./utils');

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
                return { success: false, message: 'Voting cancelled by user' };
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

            // Vote on challenge if exposure factor is less than the effective threshold and challenge has started
            if (challenge.member.ranking.exposure.exposure_factor < effectiveThreshold && challenge.start_time < now) {
                try {
                // Check for cancellation before voting
                    if (checkCancellation()) {
                        console.log('🛑 Voting cancelled by user during challenge processing');
                        return { success: false, message: 'Voting cancelled by user' };
                    }
                
                    // Get images to vote on
                    const voteImages = await getVoteImages(challenge, token);
                    if (voteImages) {
                    // Check for cancellation before submitting votes
                        if (checkCancellation()) {
                            console.log('🛑 Voting cancelled by user before vote submission');
                            return { success: false, message: 'Voting cancelled by user' };
                        }
                    
                        // Submit votes with the effective exposure threshold
                        await submitVotes(voteImages, token, effectiveThreshold);
                    
                        // Check for cancellation before delay
                        if (checkCancellation()) {
                            console.log('🛑 Voting cancelled by user after vote submission');
                            return { success: false, message: 'Voting cancelled by user' };
                        }
                    
                        // Add random delay between challenges to mimic human behavior
                        await sleep(getRandomDelay(2000, 5000));
                    }
                } catch (error) {
                    console.error(`Error voting on challenge: ${challenge.title}. Skipping to next challenge.`);
                    console.error(error.message || error);
                }
            }
        }

        // Format completion time using Latvian locale (24-hour format)
        const completionTime = new Date().toLocaleTimeString('lv-LV');
        console.log(`Voting process completed for all challenges at ${completionTime}`);
        
        return { success: true, message: 'Voting process completed successfully' };
    } catch (error) {
        console.error('Error during voting process:', error.message || error);
        return { success: false, error: error.message || 'Voting process failed' };
    }
};

module.exports = {
    fetchChallengesAndVote,
    setCancellationFlag,
    applyBoostToEntry,
}; 