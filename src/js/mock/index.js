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
const logger = require('../logger');
const { runVotingPass } = require('../services/votingOrchestrator');

// Session-stable mock data cache to prevent regeneration within same app run
let sessionMockCache = {
    challenges: null,
    voteImages: new Map(), // challengeUrl -> voteImages
};

// Function to clear session cache (for testing)
const clearSessionCache = () => {
    sessionMockCache = {
        challenges: null,
        voteImages: new Map(),
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
 * Shared preamble + token guard for the mock API methods. Logs
 * `Mock <name>` on the category's api channel, runs the per-method
 * debug lines, and — when the token argument is missing — emits the
 * standard authentication error log and short-circuits with the
 * method's no-token result. The wrapped `fn` therefore only ever runs
 * with a token present (mock mode accepts any token, including real ones).
 *
 * @param {object} spec
 * @param {string} spec.name - method name for the "Mock <name>" preamble
 * @param {string} [spec.category] - preamble logger category (default 'api')
 * @param {number} spec.tokenArg - index of the token in the call args
 * @param {Function} [spec.debug] - extra per-method debug logging (gets the raw args)
 * @param {string} [spec.noTokenMessage] - authentication error line
 * @param {Function} spec.onNoToken - produces the no-token return value
 * @param {Function} fn - the method body
 * @returns {(...args: any[]) => Promise<any>}
 */
const mockMethod = (
    { name, category = 'api', tokenArg, debug, noTokenMessage = 'No token provided, returning error', onNoToken },
    fn,
) => {
    return async (...args) => {
        logger.withCategory(category).api(`Mock ${name}`, null);
        if (debug) debug(...args);
        if (!args[tokenArg]) {
            logger.withCategory('authentication').error(noTokenMessage, null);
            return onNoToken();
        }
        return fn(...args);
    };
};

/**
 * Mock API client that can be used for testing
 */
const mockApiClient = {
    /**
     * Simulate authentication
     */
    authenticate: async (email, password) => {
        logger
            .withCategory('authentication')
            .debug(`Mock authentication with: ${email}, password: ${password ? '[hidden]' : 'no password'}`, null);

        // Accept any non-empty email and password for mock mode
        if (email && email.trim() !== '' && password && password.trim() !== '') {
            logger.withCategory('authentication').success('Mock authentication successful', null, null);
            return simulateApiResponse(auth.mockLoginSuccess, 1500);
        } else {
            logger.withCategory('authentication').error('Mock authentication failed - empty credentials', null);
            return simulateApiError(auth.mockLoginFailure, 1000);
        }
    },

    /**
     * Simulate getting active challenges
     */
    getActiveChallenges: mockMethod(
        {
            name: 'getActiveChallenges',
            tokenArg: 0,
            debug: (token) => {
                logger.withCategory('api').debug(`Token provided: ${!!token}`, null);
                logger
                    .withCategory('api')
                    .debug(`Token starts with mock_: ${token ? token.startsWith('mock_') : false}`, null);
            },
            onNoToken: () => simulateApiError(errors.mockAuthErrors.invalidToken, 500),
        },
        async () => {
            // Use cached challenges for session stability, generate only once per session
            if (!sessionMockCache.challenges) {
                if (challenges.generateMockChallenges) {
                    sessionMockCache.challenges = challenges.generateMockChallenges();
                    logger
                        .withCategory('challenges')
                        .info(
                            `Generated session-stable mock challenges: ${sessionMockCache.challenges.challenges.length}`,
                            null,
                        );
                } else {
                    sessionMockCache.challenges = challenges.mockActiveChallenges;
                    logger
                        .withCategory('challenges')
                        .info(`Using static mock challenges: ${sessionMockCache.challenges.challenges.length}`, null);
                }
            } else {
                logger
                    .withCategory('challenges')
                    .info(`Using cached mock challenges: ${sessionMockCache.challenges.challenges.length}`, null);
            }
            return simulateApiResponse(sessionMockCache.challenges, 800);
        },
    ),

    /**
     * Simulate getting vote images
     */
    getVoteImages: mockMethod(
        {
            name: 'getVoteImages',
            tokenArg: 1,
            debug: (challenge, token) => {
                logger.withCategory('challenges').debug(`Challenge: ${challenge.title}`, null);
                logger.withCategory('api').debug(`Token provided: ${!!token}`, null);
            },
            onNoToken: () => simulateApiError(errors.mockAuthErrors.invalidToken, 500),
        },
        async (challenge) => {
            const challengeUrl = challenge.url;
            const cacheKey = `${challengeUrl}-${challenge.id}`;

            // Use cached vote images for session stability
            if (!sessionMockCache.voteImages.has(cacheKey)) {
                if (voting.generateMockVoteImages) {
                    const voteImages = voting.generateMockVoteImages(challengeUrl, challenge);
                    sessionMockCache.voteImages.set(cacheKey, voteImages);
                    logger
                        .withCategory('voting')
                        .debug(
                            `Generated session-stable vote images for ${challenge.title}: ${voteImages.images.length}`,
                            null,
                        );
                } else {
                    const voteImages = voting.mockVoteImagesByChallenge[challengeUrl] || voting.mockEmptyVoteImages;
                    sessionMockCache.voteImages.set(cacheKey, voteImages);
                    logger
                        .withCategory('voting')
                        .debug(`Using static vote images for ${challenge.title}: ${voteImages.images.length}`, null);
                }
            } else {
                logger.withCategory('voting').debug(`Using cached vote images for ${challenge.title}`, null);
            }

            const cachedVoteImages = sessionMockCache.voteImages.get(cacheKey);
            logger.withCategory('voting').debug(`Returning mock vote images: ${cachedVoteImages.images.length}`, null);
            return simulateApiResponse(cachedVoteImages, 1200);
        },
    ),

    /**
     * Simulate submitting votes
     */
    submitVotes: mockMethod(
        {
            name: 'submitVotes',
            tokenArg: 1,
            debug: (voteImages, token, exposureThreshold = settings.SETTINGS_SCHEMA.exposure.default) => {
                logger
                    .withCategory('voting')
                    .debug(`Vote images count: ${voteImages.images ? voteImages.images.length : 0}`, null);
                logger.withCategory('api').debug(`Token provided: ${!!token}`, null);
                logger.withCategory('voting').debug(`Exposure threshold: ${exposureThreshold}`, null);
            },
            onNoToken: () => simulateApiError(errors.mockAuthErrors.invalidToken, 500),
        },
        async (voteImages) => {
            if (voteImages.images && voteImages.images.length > 0) {
                logger.withCategory('voting').info('Submitting mock votes successfully', null);

                // Update metadata after successful mock vote submission
                try {
                    const { updateChallengeVoteMetadata } = require('../metadata');
                    if (voteImages.challenge && voteImages.challenge.id) {
                        // Use the ORIGINAL exposure factor from before voting (the "from what" value)
                        const originalExposure = voteImages.voting?.exposure?.exposure_factor || 50;

                        logger
                            .withCategory('voting')
                            .debug(
                                `About to update mock metadata for challenge ${voteImages.challenge.id}, original exposure: ${Math.round(originalExposure)}%`,
                                null,
                            );
                        const success = updateChallengeVoteMetadata(
                            voteImages.challenge.id.toString(),
                            Math.round(originalExposure),
                        );
                        if (success) {
                            logger
                                .withCategory('voting')
                                .debug(
                                    `Successfully updated mock metadata for challenge ${voteImages.challenge.id}: original exposure ${Math.round(originalExposure)}%`,
                                    null,
                                );
                            logger
                                .withCategory('voting')
                                .success(
                                    `Mock metadata updated for challenge ${voteImages.challenge.id}: original exposure ${Math.round(originalExposure)}%`,
                                    null,
                                    null,
                                );
                        } else {
                            logger
                                .withCategory('voting')
                                .debug(`Failed to update mock metadata for challenge ${voteImages.challenge.id}`, null);
                            logger
                                .withCategory('voting')
                                .warning(
                                    `Failed to update mock metadata for challenge ${voteImages.challenge.id}`,
                                    null,
                                );
                        }
                    }
                } catch (error) {
                    logger
                        .withCategory('voting')
                        .debug(
                            `Error updating mock metadata for challenge ${voteImages.challenge.id}: ${error.message}`,
                            null,
                        );
                    logger.withCategory('voting').error(`Error updating mock metadata: ${error.message}`, null);
                }

                return simulateApiResponse(voting.mockVoteSubmissionSuccess, 2000);
            } else {
                logger.withCategory('voting').error('No vote images, returning error', null);
                return simulateApiError(voting.mockVoteSubmissionFailure, 1000);
            }
        },
    ),

    /**
     * Simulate applying boost
     */
    applyBoost: mockMethod(
        {
            name: 'applyBoost',
            tokenArg: 1,
            debug: (challenge, token) => {
                logger.withCategory('challenges').debug(`Challenge: ${challenge.title}`, null);
                logger.withCategory('voting').debug(`Boost state: ${challenge.member.boost.state}`, null);
                logger.withCategory('api').debug(`Token provided: ${!!token}`, null);
            },
            onNoToken: () => simulateApiError(errors.mockAuthErrors.invalidToken, 500),
        },
        async (challenge) => {
            const boostState = challenge.member.boost.state;
            if (boostState === 'AVAILABLE' || boostState === 'AVAILABLE_KEY') {
                logger.withCategory('voting').debug('Applying boost successfully', null);
                return simulateApiResponse(boost.mockBoostSuccess, 1500);
            } else if (boostState === 'USED') {
                logger.withCategory('voting').info('Boost already used', null);
                return simulateApiError(boost.mockBoostAlreadyUsed, 800);
            } else {
                logger.withCategory('voting').info('Boost not available', null);
                return simulateApiError(boost.mockBoostFailure, 800);
            }
        },
    ),

    /**
     * Simulate applying boost to a specific entry
     */
    applyBoostToEntry: mockMethod(
        {
            name: 'applyBoostToEntry',
            tokenArg: 2,
            debug: (challengeId, imageId, token) => {
                logger.withCategory('challenges').debug(`Challenge ID: ${challengeId}`, null);
                logger.withCategory('voting').debug(`Image ID: ${imageId}`, null);
                logger.withCategory('general').debug(`Token provided: ${token ? 'yes' : 'none'}`);
            },
            onNoToken: () => simulateApiError(errors.mockAuthErrors.invalidToken, 500),
        },
        async () => {
            logger.withCategory('voting').debug('Applying boost to specific entry successfully', null);
            return simulateApiResponse(boost.mockBoostSuccess, 1500);
        },
    ),

    /**
     * Simulate applying a won Turbo to a specific entry. The shape mirrors
     * the live /rest/set_challenge_turbo response: { ok, raw }.
     */
    applyTurbo: mockMethod(
        {
            name: 'applyTurbo',
            tokenArg: 2,
            debug: (challengeId, imageId) => {
                logger.withCategory('challenges').debug(`Challenge ID: ${challengeId}`, null);
                logger.withCategory('voting').debug(`Image ID: ${imageId}`, null);
            },
            onNoToken: () => ({ ok: false, raw: null }),
        },
        async () => {
            await simulateApiResponse({}, 800);
            return { ok: true, raw: { success: true } };
        },
    ),

    /**
     * Simulate playing the Turbo mini-game. Mirrors the real
     * api/main.runTurboMiniGame result shape ({ played, correct, flipped,
     * doubleFailed, won }) so the manual-turbo IPC handler behaves the same
     * in mock mode instead of reaching the live battle endpoints.
     */
    runTurboMiniGame: mockMethod(
        {
            name: 'runTurboMiniGame',
            category: 'turbo',
            tokenArg: 1,
            debug: (challenge) => {
                logger.withCategory('challenges').debug(`Challenge ID: ${challenge?.id}`, null);
            },
            noTokenMessage: 'No token provided, no battles played',
            onNoToken: () => ({ played: 0, correct: 0, flipped: 0, doubleFailed: 0, won: false }),
        },
        async () => {
            await simulateApiResponse({}, 800);
            return { played: 1, correct: 1, flipped: 0, doubleFailed: 0, won: true };
        },
    ),

    /**
     * Simulate fetching the user's challenge-eligible photo library.
     * Mirrors /rest/get_photos_private; returns an array of items each
     * with the fields the picker uses (id, labels, votes, views,
     * upload_date, permission). Eight photos with varied labels so the
     * tag-match picker has something to differentiate. (The live endpoint
     * returns votes=0 for library photos and a populated views count, so
     * views carry per-photo varied values here too.)
     *
     * When options.search is a non-empty string, mirror the server's
     * library filter by returning only items whose labels contain the
     * term (case-insensitive substring) — so the auto-fill search path
     * and its unfiltered fallback can both be exercised in mock mode.
     */
    getEligiblePhotos: mockMethod(
        {
            name: 'getEligiblePhotos',
            tokenArg: 1,
            debug: (challengeId) => {
                logger.withCategory('challenges').debug(`Challenge ID: ${challengeId}`, null);
            },
            noTokenMessage: 'No token provided, returning empty',
            onNoToken: () => [],
        },
        async (challengeId, token, options = {}) => {
            const now = Math.floor(Date.now() / 1000);
            const items = [
                {
                    id: 'photo_pink_flower_001',
                    labels: ['Pink', 'Flower', 'Petal', 'Plant'],
                    votes: 312,
                    views: 1820,
                    upload_date: now - 86400 * 2,
                    permission: { allowed: true, message: null },
                },
                {
                    id: 'photo_nature_landscape_002',
                    labels: ['Nature', 'Landscape', 'Tree', 'Sky'],
                    votes: 178,
                    views: 1110,
                    upload_date: now - 86400 * 5,
                    permission: { allowed: true, message: null },
                },
                {
                    id: 'photo_urban_003',
                    labels: ['Architecture', 'Building', 'Urban'],
                    votes: 89,
                    views: 640,
                    upload_date: now - 86400 * 7,
                    permission: { allowed: true, message: null },
                },
                {
                    id: 'photo_recent_004',
                    labels: ['Portrait', 'Person'],
                    votes: 24,
                    views: 95,
                    upload_date: now - 3600,
                    permission: { allowed: true, message: null },
                },
                {
                    id: 'photo_pink_petal_005',
                    labels: ['Pink', 'Petal', 'Macro'],
                    votes: 401,
                    views: 2230,
                    upload_date: now - 86400 * 4,
                    permission: { allowed: true, message: null },
                },
                {
                    id: 'photo_animal_006',
                    labels: ['Animal', 'Wildlife', 'Bird'],
                    votes: 156,
                    views: 980,
                    upload_date: now - 86400 * 10,
                    permission: { allowed: true, message: null },
                },
                {
                    id: 'photo_blocked_007',
                    labels: ['Pink', 'Flower'],
                    votes: 999,
                    views: 5000,
                    upload_date: now - 86400 * 1,
                    permission: { allowed: false, message: 'Already used in another challenge' },
                },
                {
                    id: 'photo_old_008',
                    labels: ['Misc'],
                    votes: 12,
                    views: 70,
                    upload_date: now - 86400 * 30,
                    permission: { allowed: true, message: null },
                },
            ];
            await simulateApiResponse({}, 400);
            const search = typeof options.search === 'string' ? options.search.trim().toLowerCase() : '';
            if (search === '') {
                return items;
            }
            return items.filter((item) =>
                (Array.isArray(item.labels) ? item.labels : []).some((label) =>
                    String(label).toLowerCase().includes(search),
                ),
            );
        },
    ),

    /**
     * Simulate submitting one or more photos to a challenge. Mirrors
     * /rest/submit_to_challenge; returns { ok, raw }.
     */
    submitToChallenge: mockMethod(
        {
            name: 'submitToChallenge',
            tokenArg: 2,
            debug: (challengeId, imageIds) => {
                logger
                    .withCategory('challenges')
                    .debug(
                        `Challenge ID: ${challengeId}, photos: ${Array.isArray(imageIds) ? imageIds.join(',') : 'invalid'}`,
                        null,
                    );
            },
            onNoToken: () => ({ ok: false, raw: null }),
        },
        async (challengeId, imageIds) => {
            if (!Array.isArray(imageIds) || imageIds.length === 0) {
                return { ok: false, raw: { success: false, error: 'No image_ids provided' } };
            }
            await simulateApiResponse({}, 600);
            return {
                ok: true,
                raw: {
                    success: true,
                    challenge_id: Number(challengeId),
                    member_challenge_count: 5,
                    join: false,
                    show_join_message: false,
                },
            };
        },
    ),

    /**
     * Simulate the main voting process — runs the SAME orchestration as the
     * real strategy (services/votingOrchestrator.js) over the mock
     * endpoints, so mock mode exercises auto-fill, emergency fill,
     * turbo-earn, timer-ordered deadline actions, and the shared
     * cancellation/logging path instead of a hand-maintained fork.
     *
     * cleanupStaleMetadata is deliberately null: the metadata store is
     * shared and un-namespaced, and mock challenge ids never match real
     * ones — running cleanup here would purge the user's real voting
     * metadata.
     */
    fetchChallengesAndVote: async (token, _exposureThreshold = null, challengeIdFilter = null) => {
        logger.withCategory('voting').api('Mock fetchChallengesAndVote', null);
        logger.withCategory('api').debug(`Token provided: ${!!token}`, null);
        if (!token) {
            logger.withCategory('authentication').error('No token provided, returning error', null);
            return simulateApiError(errors.mockAuthErrors.invalidToken, 500);
        }
        return runVotingPass(token, challengeIdFilter, {
            api: {
                getActiveChallenges: mockApiClient.getActiveChallenges,
                getVoteImages: mockApiClient.getVoteImages,
                submitVotes: mockApiClient.submitVotes,
                applyBoost: mockApiClient.applyBoost,
                applyBoostToEntry: mockApiClient.applyBoostToEntry,
                applyTurbo: mockApiClient.applyTurbo,
                getEligiblePhotos: mockApiClient.getEligiblePhotos,
                submitToChallenge: mockApiClient.submitToChallenge,
                runTurboMiniGame: mockApiClient.runTurboMiniGame,
            },
            cleanupStaleMetadata: null,
            // Short fixed spacing — mock cycles should stay fast.
            interChallengeDelay: () => 500,
        });
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

    // Session cache control
    clearSessionCache,
};
