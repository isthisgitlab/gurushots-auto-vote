/**
 * GuruShots Auto Voter - Main Orchestration Module
 * 
 * This module orchestrates all the voting operations by coordinating
 * between challenges, voting, and boost modules.
 */

const { getActiveChallenges } = require('./challenges');
const { getVoteImages, submitVotes } = require('./voting');
const { applyBoost } = require('./boost');
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
 *    - Votes on images if exposure factor is less than 100
 * 
 * @param {string} token - Authentication token
 * @returns {void}
 */
const fetchChallengesAndVote = async (token) => {
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
            // Check if boost is available for this challenge
            const {boost} = challenge.member;
            if (boost.state === 'AVAILABLE' && boost.timeout) {
                console.log(`Boost available for challenge: ${challenge.title}`);

                // Apply boost if deadline is within 1 hour
                const oneHourInSeconds = 60 * 60; // 1 hour in seconds
                const timeUntilDeadline = boost.timeout - now;

                if (timeUntilDeadline <= oneHourInSeconds && timeUntilDeadline > 0) {
                    console.log(`Boost deadline is within 1 hour (${Math.floor(timeUntilDeadline / 60)} minutes). Executing boost.`);
                    try {
                        await applyBoost(challenge, token);
                    } catch (error) {
                        console.error('Error during boost process:', error.message || error);
                    }
                }
            }

            // Vote on challenge if exposure factor is less than 100 and challenge has started
            if (challenge.member.ranking.exposure.exposure_factor < 100 && challenge.start_time < now) {
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
                    
                        // Submit votes
                        await submitVotes(voteImages, token);
                    
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
}; 