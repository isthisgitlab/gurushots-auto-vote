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

// Global cancellation flag for mock API
let shouldCancelVoting = false;

// Function to set cancellation flag
const setCancellationFlag = (cancel) => {
    shouldCancelVoting = cancel;
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
        console.log('🔧 Mock authentication with:', email, password ? '[hidden]' : 'no password');

        // Accept any non-empty email and password for mock mode
        if (email && email.trim() !== '' && password && password.trim() !== '') {
            console.log('✅ Mock authentication successful');
            return simulateApiResponse(auth.mockLoginSuccess, 1500);
        } else {
            console.log('❌ Mock authentication failed - empty credentials');
            return simulateApiError(auth.mockLoginFailure, 1000);
        }
    },

    /**
     * Simulate getting active challenges
     */
    getActiveChallenges: async (token) => {
        console.log('=== Mock getActiveChallenges ===');
        console.log('Token provided:', token ? `${token.substring(0, 10)}...` : 'none');
        console.log('Full token:', token || 'NO TOKEN');
        console.log('Token starts with mock_:', token ? token.startsWith('mock_') : false);

        // In mock mode, accept any token (including real ones)
        if (token) {
            // Generate fresh mock data each time to simulate changing exposure factors
            const freshChallenges = challenges.generateMockChallenges ?
                challenges.generateMockChallenges() :
                challenges.mockActiveChallenges;
            console.log('Returning mock challenges:', freshChallenges.challenges.length);
            return simulateApiResponse(freshChallenges, 800);
        } else {
            console.log('No token provided, returning error');
            return simulateApiError(errors.mockAuthErrors.invalidToken, 500);
        }
    },

    /**
     * Simulate getting vote images
     */
    getVoteImages: async (challenge, token) => {
        console.log('=== Mock getVoteImages ===');
        console.log('Challenge:', challenge.title);
        console.log('Token provided:', token ? `${token.substring(0, 10)}...` : 'none');
        console.log('Full token:', token || 'NO TOKEN');

        // In mock mode, accept any token (including real ones)
        if (token) {
            const challengeUrl = challenge.url;
            // Generate fresh vote images for the specific challenge
            const freshVoteImages = voting.generateMockVoteImages ?
                voting.generateMockVoteImages(challengeUrl) :
                (voting.mockVoteImagesByChallenge[challengeUrl] || voting.mockEmptyVoteImages);
            console.log('Returning mock vote images:', freshVoteImages.images.length);
            return simulateApiResponse(freshVoteImages, 1200);
        } else {
            console.log('No token provided, returning error');
            return simulateApiError(errors.mockAuthErrors.invalidToken, 500);
        }
    },

    /**
     * Simulate submitting votes
     */
    submitVotes: async (voteImages, token, exposureThreshold = settings.SETTINGS_SCHEMA.exposure.default) => {
        console.log('=== Mock submitVotes ===');
        console.log('Vote images count:', voteImages.images ? voteImages.images.length : 0);
        console.log('Token provided:', token ? `${token.substring(0, 10)}...` : 'none');
        console.log('Full token:', token || 'NO TOKEN');
        console.log('Exposure threshold:', exposureThreshold);

        // In mock mode, accept any token (including real ones)
        if (token) {
            if (voteImages.images && voteImages.images.length > 0) {
                console.log('Submitting mock votes successfully');
                return simulateApiResponse(voting.mockVoteSubmissionSuccess, 2000);
            } else {
                console.log('No vote images, returning error');
                return simulateApiError(voting.mockVoteSubmissionFailure, 1000);
            }
        } else {
            console.log('No token provided, returning error');
            return simulateApiError(errors.mockAuthErrors.invalidToken, 500);
        }
    },

    /**
     * Simulate applying boost
     */
    applyBoost: async (challenge, token) => {
        console.log('=== Mock applyBoost ===');
        console.log('Challenge:', challenge.title);
        console.log('Boost state:', challenge.member.boost.state);
        console.log('Token provided:', token ? `${token.substring(0, 10)}...` : 'none');
        console.log('Full token:', token || 'NO TOKEN');

        // In mock mode, accept any token (including real ones)
        if (token) {
            const boostState = challenge.member.boost.state;
            if (boostState === 'AVAILABLE') {
                console.log('Applying boost successfully');
                return simulateApiResponse(boost.mockBoostSuccess, 1500);
            } else if (boostState === 'USED') {
                console.log('Boost already used');
                return simulateApiError(boost.mockBoostAlreadyUsed, 800);
            } else {
                console.log('Boost not available');
                return simulateApiError(boost.mockBoostFailure, 800);
            }
        } else {
            console.log('No token provided, returning error');
            return simulateApiError(errors.mockAuthErrors.invalidToken, 500);
        }
    },

    /**
     * Simulate applying boost to a specific entry
     */
    applyBoostToEntry: async (challengeId, imageId, token) => {
        console.log('=== Mock applyBoostToEntry ===');
        console.log('Challenge ID:', challengeId);
        console.log('Image ID:', imageId);
        console.log('Token provided:', token ? `${token.substring(0, 10)}...` : 'none');

        // In mock mode, accept any token (including real ones)
        if (token) {
            console.log('Applying boost to specific entry successfully');
            return simulateApiResponse(boost.mockBoostSuccess, 1500);
        } else {
            console.log('No token provided, returning error');
            return simulateApiError(errors.mockAuthErrors.invalidToken, 500);
        }
    },

    /**
     * Simulate the main voting process (fetchChallengesAndVote)
     */
    fetchChallengesAndVote: async (token, exposureThreshold = settings.SETTINGS_SCHEMA.exposure.default) => {
        console.log('=== Mock Voting Process Started ===');
        console.log('Token provided:', token ? `${token.substring(0, 10)}...` : 'none');
        console.log('Full token:', token || 'NO TOKEN');
        console.log('Exposure threshold type:', typeof exposureThreshold);

        // In mock mode, accept any token (including real ones)
        if (token) {
            // Simulate getting challenges
            const challengesResponse = await simulateApiResponse(challenges.mockActiveChallenges, 800);
            console.log(`Found ${challengesResponse.challenges.length} active challenges`);

            // Simulate processing each challenge
            for (const challenge of challengesResponse.challenges) {
                // Check for cancellation before processing each challenge
                if (shouldCancelVoting) {
                    console.log('🛑 Mock voting cancelled by user');
                    return {success: false, message: 'Mock voting cancelled by user'};
                }

                console.log(`Processing challenge: ${challenge.title}`);

                // Get the effective exposure threshold for this challenge
                const effectiveThreshold = typeof exposureThreshold === 'function'
                    ? exposureThreshold(challenge.id.toString())
                    : exposureThreshold;

                console.log(`Challenge ${challenge.id} exposure threshold: ${effectiveThreshold}`);

                // Simulate boost application if available
                if (challenge.member.boost.state === 'AVAILABLE') {
                    // Check for cancellation before boost
                    if (shouldCancelVoting) {
                        console.log('🛑 Mock voting cancelled by user before boost');
                        return {success: false, message: 'Mock voting cancelled by user'};
                    }

                    console.log(`Applying boost to challenge: ${challenge.title}`);
                    await simulateApiResponse(boost.mockBoostSuccess, 1500);
                }

                // Check if boost-only mode is enabled for this challenge
                const onlyBoost = settings.getEffectiveSetting('onlyBoost', challenge.id.toString());

                // Simulate voting if exposure factor is less than the effective threshold
                // Skip voting if boost-only mode is enabled
                if (!onlyBoost && challenge.member.ranking.exposure.exposure_factor < effectiveThreshold) {
                    // Check for cancellation before voting
                    if (shouldCancelVoting) {
                        console.log('🛑 Mock voting cancelled by user before voting');
                        return {success: false, message: 'Mock voting cancelled by user'};
                    }

                    console.log(`Voting on challenge: ${challenge.title}`);
                    const challengeUrl = challenge.url;
                    if (voting.mockVoteImagesByChallenge[challengeUrl]) {
                        const voteImages = await simulateApiResponse(voting.mockVoteImagesByChallenge[challengeUrl], 1200);
                        if (voteImages && voteImages.images && voteImages.images.length > 0) {
                            // Check for cancellation before vote submission
                            if (shouldCancelVoting) {
                                console.log('🛑 Mock voting cancelled by user before vote submission');
                                return {success: false, message: 'Mock voting cancelled by user'};
                            }

                            await simulateApiResponse(voting.mockVoteSubmissionSuccess, 2000);
                        }
                    }
                } else if (onlyBoost) {
                    console.log(`Boost-only mode enabled for challenge: ${challenge.title}. Skipping voting.`);
                }

                // Check for cancellation before delay
                if (shouldCancelVoting) {
                    console.log('🛑 Mock voting cancelled by user before delay');
                    return {success: false, message: 'Mock voting cancelled by user'};
                }

                // Simulate delay between challenges
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            console.log('=== Mock Voting Process Completed ===');
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
}; 