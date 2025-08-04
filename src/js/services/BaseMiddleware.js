/**
 * GuruShots Auto Voter - Base Middleware Service
 *
 * This module provides common middleware functionality that can be used
 * by both real and mock API implementations, eliminating code duplication.
 */

const settings = require('../settings');
const logger = require('../logger');

/**
 * Base middleware class that handles common functionality
 */
class BaseMiddleware {
    constructor(apiStrategy) {
        this.apiStrategy = apiStrategy;
    }

    /**
     * CLI-specific login function with user prompts
     *
     * @returns {object|null} - Login response or null if failed
     */
    async cliLogin(email, password) {
        logger.withCategory('authentication').info('=== GuruShots Auto Voter - CLI Login ===', null);

        logger.withCategory('auth').startOperation('cli-login', 'CLI Authentication');

        try {
            // Attempt authentication using the provided strategy
            const response = await this.apiStrategy.authenticate(email, password);

            if (response && response.token) {
                logger.withCategory('auth').endOperation('cli-login', 'Authentication successful');
                logger.withCategory('authentication').success('Token obtained and saved to settings');

                // Save token to settings
                settings.setSetting('token', response.token);

                return {success: true, token: response.token};
            } else {
                logger.withCategory('auth').endOperation('cli-login', null, 'Invalid credentials');
                return {success: false, error: 'Login failed. Please check your credentials.'};
            }
        } catch (error) {
            logger.withCategory('auth').endOperation('cli-login', null, error.message || error);
            return {success: false, error: error.message || error};
        }
    }

    /**
     * GUI-friendly login function
     *
     * @param {string} email - User's email address
     * @param {string} password - User's password
     * @returns {object} - Object containing success status and data/error
     */
    async guiLogin(email, password) {
        try {
            const response = await this.apiStrategy.authenticate(email, password);

            if (response && response.token) {
                // Save token to settings
                settings.setSetting('token', response.token);

                return {
                    success: true,
                    data: response,
                };
            } else {
                return {
                    success: false,
                    error: 'Invalid credentials',
                };
            }
        } catch (error) {
            return {
                success: false,
                error: error.message || 'Authentication failed',
            };
        }
    }

    /**
     * CLI-specific voting function
     *
     * @returns {void}
     */
    async cliVote() {
        logger.withCategory('voting').info('=== GuruShots Auto Voter - CLI Voting ===', null);

        // Load token from settings
        const token = settings.getSetting('token');

        if (!token) {
            logger.withCategory('authentication').error('No authentication token found. Please login first', null);
            logger.withCategory('authentication').info('Run the login command to authenticate', null);
            return;
        }

        logger.withCategory('voting').startOperation('cli-vote', 'CLI Voting Process');

        try {
            // Create a function to get the effective exposure setting for each challenge
            const getExposureThreshold = (challengeId) => {
                try {
                    return settings.getEffectiveSetting('exposure', challengeId);
                } catch (error) {
                    logger.withCategory('settings').warning(`Error getting exposure setting for challenge ${challengeId}`, error);
                    return settings.SETTINGS_SCHEMA.exposure.default; // Fallback to schema default
                }
            };

            await this.apiStrategy.fetchChallengesAndVote(token, getExposureThreshold);
            logger.withCategory('voting').endOperation('cli-vote', 'Voting process completed successfully');
        } catch (error) {
            logger.withCategory('voting').endOperation('cli-vote', null, error.message || error);
        }
    }

    /**
     * GUI-friendly voting function
     *
     * @returns {object} - Object containing success status and data/error
     */
    async guiVote() {
        try {
            // Load token from settings
            const token = settings.getSetting('token');

            if (!token) {
                return {
                    success: false,
                    error: 'No authentication token found. Please login first.',
                };
            }

            // Create a function to get the effective exposure setting for each challenge  
            const getExposureThreshold = (challengeId) => {
                try {
                    return settings.getEffectiveSetting('exposure', challengeId);
                } catch (error) {
                    logger.withCategory('settings').warning(`Error getting exposure setting for challenge ${challengeId}`, error);
                    return settings.SETTINGS_SCHEMA.exposure.default; // Fallback to schema default
                }
            };

            await this.apiStrategy.fetchChallengesAndVote(token, getExposureThreshold);

            return {
                success: true,
                data: 'Voting process completed successfully!',
            };
        } catch (error) {
            return {
                success: false,
                error: error.message || 'Voting process failed',
            };
        }
    }

    /**
     * Check if user is authenticated
     *
     * @returns {boolean} - True if user has a valid token
     */
    isAuthenticated() {
        const token = settings.getSetting('token');
        return !!(token && token.trim() !== '');
    }

    /**
     * Logout function (clears token from settings)
     *
     * @param {boolean} clearToken - Whether to clear the token (default: true)
     */
    logout(clearToken = true) {
        if (clearToken) {
            settings.setSetting('token', '');
            logger.withCategory('authentication').success('Logged out successfully', null, null);
        }
    }

    /**
     * Get active challenges using the strategy
     *
     * @returns {object} - Challenges response
     */
    async getActiveChallenges() {
        const token = settings.getSetting('token');
        if (!token) {
            throw new Error('No authentication token found');
        }
        return this.apiStrategy.getActiveChallenges(token);
    }

    /**
     * Get vote images using the strategy
     *
     * @param {object} challenge - Challenge object
     * @returns {object} - Vote images response
     */
    async getVoteImages(challenge) {
        const token = settings.getSetting('token');
        if (!token) {
            throw new Error('No authentication token found');
        }
        return this.apiStrategy.getVoteImages(challenge, token);
    }

    /**
     * Submit votes using the strategy
     *
     * @param {object} voteImages - Vote images object
     * @param {number} exposureThreshold - Exposure threshold (default: schema default)
     * @returns {object} - Vote submission response
     */
    async submitVotes(voteImages, exposureThreshold = settings.SETTINGS_SCHEMA.exposure.default) {
        const token = settings.getSetting('token');
        if (!token) {
            throw new Error('No authentication token found');
        }
        return this.apiStrategy.submitVotes(voteImages, token, exposureThreshold);
    }

    /**
     * Apply boost using the strategy
     *
     * @param {object} challenge - Challenge object
     * @returns {object} - Boost application response
     */
    async applyBoost(challenge) {
        const token = settings.getSetting('token');
        if (!token) {
            throw new Error('No authentication token found');
        }
        return this.apiStrategy.applyBoost(challenge, token);
    }

    /**
     * Apply boost to entry using the strategy
     *
     * @param {string} challengeId - Challenge ID
     * @param {string} imageId - Image ID
     * @returns {object} - Boost application response
     */
    async applyBoostToEntry(challengeId, imageId) {
        const token = settings.getSetting('token');
        if (!token) {
            throw new Error('No authentication token found');
        }
        return this.apiStrategy.applyBoostToEntry(challengeId, imageId, token);
    }
}

module.exports = BaseMiddleware;