/**
 * GuruShots Auto Voter - API Strategy Interface
 * 
 * This module defines the common interface that both real and mock
 * API implementations must follow, ensuring consistency.
 */

/**
 * Abstract API Strategy class
 * This serves as the interface that all API strategies must implement
 */
class ApiStrategy {
    /**
     * Authenticate user with email and password
     * 
     * @param {string} email - User's email address
     * @param {string} password - User's password
     * @returns {Promise<object>} - Authentication response with token
     */
    async authenticate(/* email, password */) {
        throw new Error('authenticate method must be implemented by subclass');
    }

    /**
     * Get active challenges for the authenticated user
     * 
     * @param {string} token - Authentication token
     * @returns {Promise<object>} - Response containing array of active challenges
     */
    async getActiveChallenges(/* token */) {
        throw new Error('getActiveChallenges method must be implemented by subclass');
    }

    /**
     * Get vote images for a specific challenge
     * 
     * @param {object} challenge - Challenge object
     * @param {string} token - Authentication token
     * @returns {Promise<object>} - Response containing vote images
     */
    async getVoteImages(/* challenge, token */) {
        throw new Error('getVoteImages method must be implemented by subclass');
    }

    /**
     * Submit votes for images
     * 
     * @param {object} voteImages - Vote images object
     * @param {string} token - Authentication token
     * @param {number} exposureThreshold - Exposure threshold (default: schema default)
     * @returns {Promise<object>} - Vote submission response
     */
    async submitVotes(/* voteImages, token, exposureThreshold */) {
        throw new Error('submitVotes method must be implemented by subclass');
    }

    /**
     * Apply boost to a challenge
     * 
     * @param {object} challenge - Challenge object
     * @param {string} token - Authentication token
     * @returns {Promise<object>} - Boost application response
     */
    async applyBoost(/* challenge, token */) {
        throw new Error('applyBoost method must be implemented by subclass');
    }

    /**
     * Apply boost to a specific entry
     * 
     * @param {string} challengeId - Challenge ID
     * @param {string} imageId - Image ID
     * @param {string} token - Authentication token
     * @returns {Promise<object>} - Boost application response
     */
    async applyBoostToEntry(/* challengeId, imageId, token */) {
        throw new Error('applyBoostToEntry method must be implemented by subclass');
    }

    /**
     * Main voting process - fetch challenges and vote
     * 
     * @param {string} token - Authentication token
     * @returns {Promise<object>} - Voting process response
     */
    async fetchChallengesAndVote(/* token */) {
        throw new Error('fetchChallengesAndVote method must be implemented by subclass');
    }

    /**
     * Get strategy type (for debugging/logging)
     * 
     * @returns {string} - Strategy type name
     */
    getStrategyType() {
        return this.constructor.name;
    }
}

module.exports = ApiStrategy;