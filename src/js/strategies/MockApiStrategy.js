/**
 * GuruShots Auto Voter - Mock API Strategy
 *
 * This module implements the mock API strategy that returns
 * simulated responses for testing and development.
 */

const ApiStrategy = require('../interfaces/ApiStrategy');
const {mockApiClient} = require('../mock');
const settings = require('../settings');

/**
 * Mock API Strategy implementation
 * Returns simulated responses for testing and development
 */
class MockApiStrategy extends ApiStrategy {
    /**
     * Authenticate user with email and password
     *
     * @param {string} email - User's email address
     * @param {string} password - User's password
     * @returns {Promise<object>} - Authentication response with token
     */
    async authenticate(email, password) {
        console.log('🔧 Using mock authentication');
        return await mockApiClient.authenticate(email, password);
    }

    /**
     * Get active challenges for the authenticated user
     *
     * @param {string} token - Authentication token
     * @returns {Promise<object>} - Response containing array of active challenges
     */
    async getActiveChallenges(token) {
        console.log('🔧 Using mock getActiveChallenges');
        return await mockApiClient.getActiveChallenges(token);
    }

    /**
     * Get vote images for a specific challenge
     *
     * @param {object} challenge - Challenge object
     * @param {string} token - Authentication token
     * @returns {Promise<object>} - Response containing vote images
     */
    async getVoteImages(challenge, token) {
        console.log('🔧 Using mock getVoteImages');
        return await mockApiClient.getVoteImages(challenge, token);
    }

    /**
     * Submit votes for images
     *
     * @param {object} voteImages - Vote images object
     * @param {string} token - Authentication token
     * @param {number} exposureThreshold - Exposure threshold (default: schema default)
     * @returns {Promise<object>} - Vote submission response
     */
    async submitVotes(voteImages, token, exposureThreshold = settings.SETTINGS_SCHEMA.exposure.default) {
        console.log('🔧 Using mock submitVotes');
        return await mockApiClient.submitVotes(voteImages, token, exposureThreshold);
    }

    /**
     * Apply boost to a challenge
     *
     * @param {object} challenge - Challenge object
     * @param {string} token - Authentication token
     * @returns {Promise<object>} - Boost application response
     */
    async applyBoost(challenge, token) {
        console.log('🔧 Using mock applyBoost');
        return await mockApiClient.applyBoost(challenge, token);
    }

    /**
     * Apply boost to a specific entry
     *
     * @param {string} challengeId - Challenge ID
     * @param {string} imageId - Image ID
     * @param {string} token - Authentication token
     * @returns {Promise<object>} - Boost application response
     */
    async applyBoostToEntry(challengeId, imageId, token) {
        console.log('🔧 Using mock applyBoostToEntry');
        return await mockApiClient.applyBoostToEntry(challengeId, imageId, token);
    }

    /**
     * Main voting process - fetch challenges and vote
     *
     * @param {string} token - Authentication token
     * @param {number|function} exposureThreshold - Exposure threshold (default: schema default) or function to get threshold per challenge
     * @returns {Promise<object>} - Voting process response
     */
    async fetchChallengesAndVote(token, exposureThreshold = settings.SETTINGS_SCHEMA.exposure.default) {
        console.log('🔧 Using mock fetchChallengesAndVote');
        return await mockApiClient.fetchChallengesAndVote(token, exposureThreshold);
    }

    /**
     * Get strategy type (for debugging/logging)
     *
     * @returns {string} - Strategy type name
     */
    getStrategyType() {
        return 'MockAPI';
    }
}

module.exports = MockApiStrategy;