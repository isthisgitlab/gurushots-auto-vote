/**
 * GuruShots Auto Voter - Mock Data Index
 *
 * This file exports all mock data for easy access and testing
 */

const auth = require('./auth');
const challenges = require('./challenges');
const voting = require('./voting');
const boost = require('./boost');
const errors = require('./errors');
const settings = require('../settings');
const votingLogic = require('../services/VotingLogic');
const logger = require('../logger');

// Global cancellation flag for mock API
let shouldCancelVoting = false;

// Function to set cancellation flag
const setCancellationFlag = (cancel) => {
    shouldCancelVoting = cancel;
};

// Session-stable mock data cache to prevent regeneration within same app run
let sessionMockCache = {
    challenges: null,
    voteImages: new Map(), // challengeUrl -> voteImages
    lastCacheTime: null,
};

// Function to clear session cache (for testing)
const clearSessionCache = () => {
    sessionMockCache = {
        challenges: null,
        voteImages: new Map(),
        lastCacheTime: null,
    };
};

/**
 * Complete mock data object
 */
const mockData = {
    auth,
    challenges,
    voting,
    boost,
    errors,
};

/**
 * Helper function to get mock data by type and scenario
 *
 * @param {string} type - The type of mock data (auth, challenges, voting, boost, errors)
 * @param {string} scenario - The specific scenario (optional)
 * @returns {object} - The requested mock data
 */
const getMockData = (type, scenario = null) => {
    if (!mockData[type]) {
        throw new Error(`Unknown mock data type: ${type}`);
    }

    if (scenario) {
        if (!mockData[type][scenario]) {
            throw new Error(`Unknown scenario "${scenario}" for type "${type}"`);
        }
        return mockData[type][scenario];
    }

    return mockData[type];
};

/**
 * Helper function to simulate API responses with delays
 *
 * @param {object} data - The mock data to return
 * @param {number} delay - Delay in milliseconds (default: 1000)
 * @returns {Promise<object>} - Promise that resolves with the mock data after delay
 */
const simulateApiResponse = (data, delay = 1000) => {
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve(data);
        }, delay);
    });
};

/**
 * Helper function to simulate API errors
 *
 * @param {object} error - The error object to return
 * @param {number} delay - Delay in milliseconds (default: 500)
 * @returns {Promise<object>} - Promise that rejects with the error after delay
 */
const simulateApiError = (error, delay = 500) => {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            reject(error);
        }, delay);
    });
};

/**
 * Mock API client that can be used for testing
 */
const mockApiClient = {
    /**
     * Simulate authentication
     */
    authenticate: async (email, password) => {
        logger.debug(`Mock authentication with: ${email}, password: ${password ? '[hidden]' : 'no password'}`);

        // Accept any non-empty email and password for mock mode
        if (email && email.trim() !== '' && password && password.trim() !== '') {
            logger.success('Mock authentication successful');
            return simulateApiResponse(auth.mockLoginSuccess, 1500);
        } else {
            logger.error('Mock authentication failed - empty credentials');
            return simulateApiError(auth.mockLoginFailure, 1000);
        }
    },

    /**
     * Simulate getting active challenges
     */
    getActiveChallenges: async (token) => {
        logger.api('Mock getActiveChallenges');
        logger.debug(`Token provided: ${!!token}`);
        logger.debug(`Token starts with mock_: ${token ? token.startsWith('mock_') : false}`);

        // In mock mode, accept any token (including real ones)
        if (token) {
            // Use cached challenges for session stability, generate only once per session
            if (!sessionMockCache.challenges) {
                if (challenges.generateMockChallenges) {
                    sessionMockCache.challenges = challenges.generateMockChallenges();
                    logger.info(`Generated session-stable mock challenges: ${sessionMockCache.challenges.challenges.length}`);
                } else {
                    sessionMockCache.challenges = challenges.mockActiveChallenges;
                    logger.info(`Using static mock challenges: ${sessionMockCache.challenges.challenges.length}`);
                }
                sessionMockCache.lastCacheTime = Date.now();
            } else {
                logger.info(`Using cached mock challenges: ${sessionMockCache.challenges.challenges.length}`);
            }
            return simulateApiResponse(sessionMockCache.challenges, 800);
        } else {
            logger.error('No token provided, returning error');
            return simulateApiError(errors.mockAuthErrors.invalidToken, 500);
        }
    },

    /**
     * Simulate getting vote images
     */
    getVoteImages: async (challenge, token) => {
        logger.api('Mock getVoteImages');
        logger.debug(`Challenge: ${challenge.title}`);
        logger.debug(`Token provided: ${!!token}`);

        // In mock mode, accept any token (including real ones)
        if (token) {
            const challengeUrl = challenge.url;
            const cacheKey = `${challengeUrl}-${challenge.id}`;
            
            // Use cached vote images for session stability
            if (!sessionMockCache.voteImages.has(cacheKey)) {
                if (voting.generateMockVoteImages) {
                    const voteImages = voting.generateMockVoteImages(challengeUrl, challenge);
                    sessionMockCache.voteImages.set(cacheKey, voteImages);
                    logger.debug(`Generated session-stable vote images for ${challenge.title}: ${voteImages.images.length}`);
                } else {
                    const voteImages = voting.mockVoteImagesByChallenge[challengeUrl] || voting.mockEmptyVoteImages;
                    sessionMockCache.voteImages.set(cacheKey, voteImages);
                    logger.debug(`Using static vote images for ${challenge.title}: ${voteImages.images.length}`);
                }
            } else {
                logger.debug(`Using cached vote images for ${challenge.title}`);
            }
            
            const cachedVoteImages = sessionMockCache.voteImages.get(cacheKey);
            logger.debug(`Returning mock vote images: ${cachedVoteImages.images.length}`);
            return simulateApiResponse(cachedVoteImages, 1200);
        } else {
            logger.error('No token provided, returning error');
            return simulateApiError(errors.mockAuthErrors.invalidToken, 500);
        }
    },

    /**
     * Simulate submitting votes
     */
    submitVotes: async (voteImages, token, exposureThreshold = settings.SETTINGS_SCHEMA.exposure.default) => {
        logger.api('Mock submitVotes');
        logger.debug(`Vote images count: ${voteImages.images ? voteImages.images.length : 0}`);
        logger.debug(`Token provided: ${!!token}`);
        logger.debug(`Exposure threshold: ${exposureThreshold}`);

        // In mock mode, accept any token (including real ones)
        if (token) {
            if (voteImages.images && voteImages.images.length > 0) {
                logger.info('Submitting mock votes successfully');
                
                // Update metadata after successful mock vote submission
                try {
                    const { updateChallengeVoteMetadata } = require('../metadata');
                    if (voteImages.challenge && voteImages.challenge.id) {
                        // Use the ORIGINAL exposure factor from before voting (the "from what" value)
                        const originalExposure = voteImages.voting?.exposure?.exposure_factor || 50;
                        
                        logger.debug(`About to update mock metadata for challenge ${voteImages.challenge.id}, original exposure: ${Math.round(originalExposure)}%`);
                        const success = updateChallengeVoteMetadata(voteImages.challenge.id.toString(), Math.round(originalExposure));
                        if (success) {
                            logger.debug(`Successfully updated mock metadata for challenge ${voteImages.challenge.id}: original exposure ${Math.round(originalExposure)}%`);
                            logger.success(`Mock metadata updated for challenge ${voteImages.challenge.id}: original exposure ${Math.round(originalExposure)}%`);
                        } else {
                            logger.debug(`Failed to update mock metadata for challenge ${voteImages.challenge.id}`);
                            logger.warning(`Failed to update mock metadata for challenge ${voteImages.challenge.id}`);
                        }
                    }
                } catch (error) {
                    logger.debug(`Error updating mock metadata for challenge ${voteImages.challenge.id}: ${error.message}`);
                    logger.error(`Error updating mock metadata: ${error.message}`);
                }
                
                return simulateApiResponse(voting.mockVoteSubmissionSuccess, 2000);
            } else {
                logger.error('No vote images, returning error');
                return simulateApiError(voting.mockVoteSubmissionFailure, 1000);
            }
        } else {
            logger.error('No token provided, returning error');
            return simulateApiError(errors.mockAuthErrors.invalidToken, 500);
        }
    },

    /**
     * Simulate applying boost
     */
    applyBoost: async (challenge, token) => {
        logger.api('Mock applyBoost');
        logger.debug(`Challenge: ${challenge.title}`);
        logger.debug(`Boost state: ${challenge.member.boost.state}`);
        logger.debug(`Token provided: ${!!token}`);

        // In mock mode, accept any token (including real ones)
        if (token) {
            const boostState = challenge.member.boost.state;
            if (boostState === 'AVAILABLE') {
                logger.debug('Applying boost successfully');
                return simulateApiResponse(boost.mockBoostSuccess, 1500);
            } else if (boostState === 'USED') {
                logger.info('Boost already used');
                return simulateApiError(boost.mockBoostAlreadyUsed, 800);
            } else {
                logger.info('Boost not available');
                return simulateApiError(boost.mockBoostFailure, 800);
            }
        } else {
            logger.error('No token provided, returning error');
            return simulateApiError(errors.mockAuthErrors.invalidToken, 500);
        }
    },

    /**
     * Simulate applying boost to a specific entry
     */
    applyBoostToEntry: async (challengeId, imageId, token) => {
        logger.api('Mock applyBoostToEntry');
        logger.debug(`Challenge ID: ${challengeId}`);
        logger.debug(`Image ID: ${imageId}`);
        logger.debug(`Token provided: ${token ? `${token.substring(0, 10)}...` : 'none'}`);

        // In mock mode, accept any token (including real ones)
        if (token) {
            logger.debug('Applying boost to specific entry successfully');
            return simulateApiResponse(boost.mockBoostSuccess, 1500);
        } else {
            logger.error('No token provided, returning error');
            return simulateApiError(errors.mockAuthErrors.invalidToken, 500);
        }
    },

    /**
     * Simulate the main voting process (fetchChallengesAndVote)
     */
    fetchChallengesAndVote: async (token, exposureThreshold = settings.SETTINGS_SCHEMA.exposure.default) => {
        logger.info('Mock Voting Process Started');
        logger.debug(`Token provided: ${!!token}`);
        logger.debug(`Exposure threshold type: ${typeof exposureThreshold}`);

        // In mock mode, accept any token (including real ones)
        if (token) {
            // Simulate getting challenges
            const challengesResponse = await simulateApiResponse(challenges.mockActiveChallenges, 800);
            logger.info(`Found ${challengesResponse.challenges.length} active challenges`);

            // Simulate processing each challenge
            for (const challenge of challengesResponse.challenges) {
                // Check for cancellation before processing each challenge
                if (shouldCancelVoting) {
                    logger.info('Mock voting cancelled by user');
                    return {success: false, message: 'Mock voting cancelled by user'};
                }

                logger.debug(`Processing challenge: ${challenge.title}`);

                // Get the effective exposure threshold for this challenge
                const effectiveThreshold = typeof exposureThreshold === 'function'
                    ? exposureThreshold(challenge.id.toString())
                    : exposureThreshold;

                logger.debug(`Challenge ${challenge.id} exposure threshold: ${effectiveThreshold}`);

                // Simulate boost application if available
                if (challenge.member.boost.state === 'AVAILABLE') {
                    // Check for cancellation before boost
                    if (shouldCancelVoting) {
                        logger.info('Mock voting cancelled by user before boost');
                        return {success: false, message: 'Mock voting cancelled by user'};
                    }

                    logger.debug(`Applying boost to challenge: ${challenge.title}`);
                    await simulateApiResponse(boost.mockBoostSuccess, 1500);
                }

                // Use the centralized voting logic service
                const now = Math.floor(Date.now() / 1000);
                const {shouldVote, voteReason} = votingLogic.evaluateVotingDecision(challenge, now);

                // Simulate voting if conditions are met
                if (shouldVote) {
                    // Check for cancellation before voting
                    if (shouldCancelVoting) {
                        logger.info('Mock voting cancelled by user before voting');
                        return {success: false, message: 'Mock voting cancelled by user'};
                    }

                    logger.debug(`Voting on challenge: ${challenge.title}`);
                    const challengeUrl = challenge.url;
                    if (voting.mockVoteImagesByChallenge[challengeUrl]) {
                        const voteImages = await simulateApiResponse(voting.mockVoteImagesByChallenge[challengeUrl], 1200);
                        if (voteImages && voteImages.images && voteImages.images.length > 0) {
                            // Check for cancellation before vote submission
                            if (shouldCancelVoting) {
                                logger.info('Mock voting cancelled by user before vote submission');
                                return {success: false, message: 'Mock voting cancelled by user'};
                            }

                            await simulateApiResponse(voting.mockVoteSubmissionSuccess, 2000);
                        }
                    }
                } else {
                    // Log why voting was skipped
                    logger.debug(`Skipping voting on challenge: ${challenge.title} - ${voteReason}`);
                }

                // Check for cancellation before delay
                if (shouldCancelVoting) {
                    logger.info('Mock voting cancelled by user before delay');
                    return {success: false, message: 'Mock voting cancelled by user'};
                }

                // Simulate delay between challenges
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            logger.info('Mock Voting Process Completed');
            return {success: true, message: 'Mock voting process completed'};
        } else {
            return simulateApiError(errors.mockAuthErrors.invalidToken, 500);
        }
    },
};

module.exports = {
    // Individual mock data modules
    auth,
    challenges,
    voting,
    boost,
    errors,

    // Complete mock data object
    mockData,

    // Helper functions
    getMockData,
    simulateApiResponse,
    simulateApiError,

    // Mock API client
    mockApiClient,

    // Cancellation control
    setCancellationFlag,
    
    // Session cache control
    clearSessionCache,
}; 