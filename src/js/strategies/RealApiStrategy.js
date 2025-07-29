/**
 * GuruShots Auto Voter - Real API Strategy
 *
 * This module implements the real API strategy that makes actual
 * HTTP requests to the GuruShots API endpoints.
 */

const ApiStrategy = require('../interfaces/ApiStrategy');
const {authenticate} = require('../api/login');
const {fetchChallengesAndVote} = require('../api/main');
const {getActiveChallenges} = require('../api/challenges');
const {getVoteImages, submitVotes} = require('../api/voting');
const {applyBoost, applyBoostToEntry} = require('../api/boost');
const settings = require('../settings');

/**
 * Real API Strategy implementation
 * Makes actual HTTP requests to GuruShots API
 */
class RealApiStrategy extends ApiStrategy {
    /**
     * Authenticate user with email and password
     *
     * @param {string} email - User's email address
     * @param {string} password - User's password
     * @returns {Promise<object>} - Authentication response with token
     */
    async authenticate(email, password) {
        return await authenticate(email, password);
    }

    /**
     * Get active challenges for the authenticated user
     *
     * @param {string} token - Authentication token
     * @returns {Promise<object>} - Response containing array of active challenges
     */
    async getActiveChallenges(token) {
        return await getActiveChallenges(token);
    }

    /**
     * Get vote images for a specific challenge
     *
     * @param {object} challenge - Challenge object
     * @param {string} token - Authentication token
     * @returns {Promise<object>} - Response containing vote images
     */
    async getVoteImages(challenge, token) {
        return await getVoteImages(challenge, token);
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
        return await submitVotes(voteImages, token, exposureThreshold);
    }

    /**
     * Apply boost to a challenge
     *
     * @param {object} challenge - Challenge object
     * @param {string} token - Authentication token
     * @returns {Promise<object>} - Boost application response
     */
    async applyBoost(challenge, token) {
        return await applyBoost(challenge, token);
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
        return await applyBoostToEntry(challengeId, imageId, token);
    }

    /**
     * Main voting process - fetch challenges and vote
     *
     * @param {string} token - Authentication token
     * @param {number|function} exposureThreshold - Exposure threshold (default: schema default) or function to get threshold per challenge
     * @returns {Promise<object>} - Voting process response
     */
    async fetchChallengesAndVote(token, exposureThreshold = settings.SETTINGS_SCHEMA.exposure.default) {
        return await fetchChallengesAndVote(token, exposureThreshold);
    }

    /**
     * Get strategy type (for debugging/logging)
     *
     * @returns {string} - Strategy type name
     */
    getStrategyType() {
        return 'RealAPI';
    }
}

module.exports = RealApiStrategy;