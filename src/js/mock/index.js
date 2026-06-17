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
const autoFill = require('../services/autoFill');
const logger = require('../logger');
const cancellation = require('../voting/cancellation');

// Thin delegate kept for backward compatibility with index.js + tests.
const setCancellationFlag = (cancel) => {
    cancellation.setCancelled(cancel);
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
    getActiveChallenges: async (token) => {
        logger.withCategory('api').api('Mock getActiveChallenges', null);
        logger.withCategory('api').debug(`Token provided: ${!!token}`, null);
        logger.withCategory('api').debug(`Token starts with mock_: ${token ? token.startsWith('mock_') : false}`, null);

        // In mock mode, accept any token (including real ones)
        if (token) {
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
                sessionMockCache.lastCacheTime = Date.now();
            } else {
                logger
                    .withCategory('challenges')
                    .info(`Using cached mock challenges: ${sessionMockCache.challenges.challenges.length}`, null);
            }
            return simulateApiResponse(sessionMockCache.challenges, 800);
        } else {
            logger.withCategory('authentication').error('No token provided, returning error', null);
            return simulateApiError(errors.mockAuthErrors.invalidToken, 500);
        }
    },

    /**
     * Simulate getting vote images
     */
    getVoteImages: async (challenge, token) => {
        logger.withCategory('api').api('Mock getVoteImages', null);
        logger.withCategory('challenges').debug(`Challenge: ${challenge.title}`, null);
        logger.withCategory('api').debug(`Token provided: ${!!token}`, null);

        // In mock mode, accept any token (including real ones)
        if (token) {
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
        } else {
            logger.withCategory('authentication').error('No token provided, returning error', null);
            return simulateApiError(errors.mockAuthErrors.invalidToken, 500);
        }
    },

    /**
     * Simulate submitting votes
     */
    submitVotes: async (voteImages, token, exposureThreshold = settings.SETTINGS_SCHEMA.exposure.default) => {
        logger.withCategory('api').api('Mock submitVotes', null);
        logger
            .withCategory('voting')
            .debug(`Vote images count: ${voteImages.images ? voteImages.images.length : 0}`, null);
        logger.withCategory('api').debug(`Token provided: ${!!token}`, null);
        logger.withCategory('voting').debug(`Exposure threshold: ${exposureThreshold}`, null);

        // In mock mode, accept any token (including real ones)
        if (token) {
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
        } else {
            logger.withCategory('authentication').error('No token provided, returning error', null);
            return simulateApiError(errors.mockAuthErrors.invalidToken, 500);
        }
    },

    /**
     * Simulate applying boost
     */
    applyBoost: async (challenge, token) => {
        logger.withCategory('api').api('Mock applyBoost', null);
        logger.withCategory('challenges').debug(`Challenge: ${challenge.title}`, null);
        logger.withCategory('voting').debug(`Boost state: ${challenge.member.boost.state}`, null);
        logger.withCategory('api').debug(`Token provided: ${!!token}`, null);

        // In mock mode, accept any token (including real ones)
        if (token) {
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
        } else {
            logger.withCategory('authentication').error('No token provided, returning error', null);
            return simulateApiError(errors.mockAuthErrors.invalidToken, 500);
        }
    },

    /**
     * Simulate applying boost to a specific entry
     */
    applyBoostToEntry: async (challengeId, imageId, token) => {
        logger.withCategory('api').api('Mock applyBoostToEntry', null);
        logger.withCategory('challenges').debug(`Challenge ID: ${challengeId}`, null);
        logger.withCategory('voting').debug(`Image ID: ${imageId}`, null);
        logger.withCategory('general').debug(`Token provided: ${token ? `${token.substring(0, 10)}...` : 'none'}`);

        // In mock mode, accept any token (including real ones)
        if (token) {
            logger.withCategory('voting').debug('Applying boost to specific entry successfully', null);
            return simulateApiResponse(boost.mockBoostSuccess, 1500);
        } else {
            logger.withCategory('authentication').error('No token provided, returning error', null);
            return simulateApiError(errors.mockAuthErrors.invalidToken, 500);
        }
    },

    /**
     * Simulate applying a won Turbo to a specific entry. The shape mirrors
     * the live /rest/set_challenge_turbo response: { ok, raw }.
     */
    applyTurbo: async (challengeId, imageId, token) => {
        logger.withCategory('api').api('Mock applyTurbo', null);
        logger.withCategory('challenges').debug(`Challenge ID: ${challengeId}`, null);
        logger.withCategory('voting').debug(`Image ID: ${imageId}`, null);
        if (!token) {
            logger.withCategory('authentication').error('No token provided, returning error', null);
            return { ok: false, raw: null };
        }
        await simulateApiResponse({}, 800);
        return { ok: true, raw: { success: true } };
    },

    /**
     * Simulate playing the Turbo mini-game. Mirrors the real
     * api/main.runTurboMiniGame result shape ({ played, correct, flipped,
     * doubleFailed, won }) so the manual-turbo IPC handler behaves the same
     * in mock mode instead of reaching the live battle endpoints.
     */
    runTurboMiniGame: async (challenge, token) => {
        logger.withCategory('turbo').api('Mock runTurboMiniGame', null);
        logger.withCategory('challenges').debug(`Challenge ID: ${challenge?.id}`, null);
        if (!token) {
            logger.withCategory('authentication').error('No token provided, no battles played', null);
            return { played: 0, correct: 0, flipped: 0, doubleFailed: 0, won: false };
        }
        await simulateApiResponse({}, 800);
        return { played: 1, correct: 1, flipped: 0, doubleFailed: 0, won: true };
    },

    /**
     * Simulate fetching the user's challenge-eligible photo library.
     * Mirrors /rest/get_photos_private; returns an array of items each
     * with the fields the picker uses (id, labels, votes, upload_date,
     * permission). Eight photos with varied labels so the tag-match
     * picker has something to differentiate.
     *
     * When options.search is a non-empty string, mirror the server's
     * library filter by returning only items whose labels contain the
     * term (case-insensitive substring) — so the auto-fill search path
     * and its unfiltered fallback can both be exercised in mock mode.
     */
    getEligiblePhotos: async (challengeId, token, options = {}) => {
        logger.withCategory('api').api('Mock getEligiblePhotos', null);
        logger.withCategory('challenges').debug(`Challenge ID: ${challengeId}`, null);
        if (!token) {
            logger.withCategory('authentication').error('No token provided, returning empty', null);
            return [];
        }
        const now = Math.floor(Date.now() / 1000);
        const items = [
            {
                id: 'photo_pink_flower_001',
                labels: ['Pink', 'Flower', 'Petal', 'Plant'],
                votes: 312,
                upload_date: now - 86400 * 2,
                permission: { allowed: true, message: null },
            },
            {
                id: 'photo_nature_landscape_002',
                labels: ['Nature', 'Landscape', 'Tree', 'Sky'],
                votes: 178,
                upload_date: now - 86400 * 5,
                permission: { allowed: true, message: null },
            },
            {
                id: 'photo_urban_003',
                labels: ['Architecture', 'Building', 'Urban'],
                votes: 89,
                upload_date: now - 86400 * 7,
                permission: { allowed: true, message: null },
            },
            {
                id: 'photo_recent_004',
                labels: ['Portrait', 'Person'],
                votes: 24,
                upload_date: now - 3600,
                permission: { allowed: true, message: null },
            },
            {
                id: 'photo_pink_petal_005',
                labels: ['Pink', 'Petal', 'Macro'],
                votes: 401,
                upload_date: now - 86400 * 4,
                permission: { allowed: true, message: null },
            },
            {
                id: 'photo_animal_006',
                labels: ['Animal', 'Wildlife', 'Bird'],
                votes: 156,
                upload_date: now - 86400 * 10,
                permission: { allowed: true, message: null },
            },
            {
                id: 'photo_blocked_007',
                labels: ['Pink', 'Flower'],
                votes: 999,
                upload_date: now - 86400 * 1,
                permission: { allowed: false, message: 'Already used in another challenge' },
            },
            {
                id: 'photo_old_008',
                labels: ['Misc'],
                votes: 12,
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

    /**
     * Simulate submitting one or more photos to a challenge. Mirrors
     * /rest/submit_to_challenge; returns { ok, raw }.
     */
    submitToChallenge: async (challengeId, imageIds, token) => {
        logger.withCategory('api').api('Mock submitToChallenge', null);
        logger
            .withCategory('challenges')
            .debug(
                `Challenge ID: ${challengeId}, photos: ${Array.isArray(imageIds) ? imageIds.join(',') : 'invalid'}`,
                null,
            );
        if (!token) {
            logger.withCategory('authentication').error('No token provided, returning error', null);
            return { ok: false, raw: null };
        }
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

    /**
     * Simulate the main voting process (fetchChallengesAndVote)
     */
    fetchChallengesAndVote: async (
        token,
        exposureThreshold = settings.SETTINGS_SCHEMA.exposure.default,
        challengeIdFilter = null,
    ) => {
        logger.withCategory('voting').info('Mock Voting Process Started', null);
        logger.withCategory('api').debug(`Token provided: ${!!token}`, null);
        logger.withCategory('voting').debug(`Exposure threshold type: ${typeof exposureThreshold}`, null);

        // In mock mode, accept any token (including real ones)
        if (token) {
            // Simulate getting challenges
            const challengesResponse = await simulateApiResponse(challenges.mockActiveChallenges, 800);
            // Keep the full active list (parity with real main.js): callers reuse
            // it for threshold scheduling, so it must not be the filtered subset.
            const allChallenges = challengesResponse.challenges;
            let challengeList = allChallenges;
            if (challengeIdFilter != null) {
                const idStr = String(challengeIdFilter);
                challengeList = challengeList.filter((c) => String(c.id) === idStr);
                if (challengeList.length === 0) {
                    return { success: false, error: `Challenge ${idStr} is not active`, challenges: allChallenges };
                }
            }
            logger.withCategory('challenges').info(`Found ${challengeList.length} active challenges`, null);

            // Simulate processing each challenge
            for (const challenge of challengeList) {
                // Check for cancellation before processing each challenge
                if (cancellation.isCancelled()) {
                    logger.withCategory('voting').info('Mock voting cancelled by user', null);
                    return { success: false, message: 'Mock voting cancelled by user', challenges: allChallenges };
                }

                logger.withCategory('challenges').debug(`Processing challenge: ${challenge.title}`, null);

                // Get the effective exposure threshold for this challenge
                const effectiveThreshold =
                    typeof exposureThreshold === 'function'
                        ? exposureThreshold(challenge.id.toString())
                        : exposureThreshold;

                logger
                    .withCategory('voting')
                    .debug(`Challenge ${challenge.id} exposure threshold: ${effectiveThreshold}`, null);

                const now = Math.floor(Date.now() / 1000);

                // Deps for the shared fill-new helper, wired to the mock photo API.
                const fillDeps = {
                    settings,
                    logger,
                    getEligiblePhotos: mockApiClient.getEligiblePhotos,
                    submitToChallenge: mockApiClient.submitToChallenge,
                };

                // Simulate boost application when due (mirrors real main.js,
                // including the emergency override that applies an available
                // boost near the deadline even when Auto-Apply Boost is off).
                if (votingLogic.shouldApplyBoost(challenge, now, { emergency: true })) {
                    // Check for cancellation before boost
                    if (cancellation.isCancelled()) {
                        logger.withCategory('voting').info('Mock voting cancelled by user before boost', null);
                        return { success: false, message: 'Mock voting cancelled by user', challenges: allChallenges };
                    }

                    logger.withCategory('voting').debug(`Applying boost to challenge: ${challenge.title}`, null);
                    const cid = challenge.id.toString();
                    if (settings.getEffectiveSetting('boostFillNew', cid) === true) {
                        // Fill-new: submit a fresh photo and boost that entry instead
                        // of an existing one; fall back to the configured entry when
                        // no fresh photo can be submitted (full / none / failed).
                        const filled = await autoFill.submitNewEntryForAction(challenge, token, fillDeps);
                        if (filled.ok) {
                            autoFill.reflectNewEntry(challenge, filled.imageId);
                            await mockApiClient.applyBoostToEntry(cid, filled.imageId, token);
                        } else {
                            await mockApiClient.applyBoost(challenge, token);
                        }
                    } else {
                        await mockApiClient.applyBoost(challenge, token);
                    }
                }

                // Auto-apply a won turbo when eligible (mirrors real main.js,
                // including the emergency override that applies near the deadline
                // even when Auto-Apply Turbo is off).
                const turboApply = votingLogic.shouldApplyTurbo(challenge, now, { emergency: true });
                if (turboApply.apply) {
                    let imageId = turboApply.imageId;
                    if (turboApply.fillNew) {
                        const filled = await autoFill.submitNewEntryForAction(challenge, token, fillDeps);
                        if (filled.ok) {
                            autoFill.reflectNewEntry(challenge, filled.imageId);
                            imageId = filled.imageId;
                        }
                    }
                    if (imageId) {
                        logger.withCategory('voting').debug(`Applying turbo to entry ${imageId}`, null);
                        await mockApiClient.applyTurbo(challenge.id, imageId, token);
                    } else {
                        // Parity with real main.js: log why turbo was skipped so a
                        // dev reading mock-mode logs can tell a fill-new miss from
                        // a turbo that simply wasn't eligible.
                        logger
                            .withCategory('turbo')
                            .info(
                                `${logger.challengeTag(challenge)} turbo fill-new could not submit a photo and there is no existing entry — skipped`,
                                null,
                            );
                    }
                }

                // Use the centralized voting logic service
                const { shouldVote, voteReason } = votingLogic.evaluateVotingDecision(challenge, now);

                // Simulate voting if conditions are met
                if (shouldVote) {
                    // Check for cancellation before voting
                    if (cancellation.isCancelled()) {
                        logger.withCategory('voting').info('Mock voting cancelled by user before voting', null);
                        return { success: false, message: 'Mock voting cancelled by user', challenges: allChallenges };
                    }

                    logger.withCategory('voting').debug(`Voting on challenge: ${challenge.title}`, null);
                    const challengeUrl = challenge.url;
                    if (voting.mockVoteImagesByChallenge[challengeUrl]) {
                        const voteImages = await simulateApiResponse(
                            voting.mockVoteImagesByChallenge[challengeUrl],
                            1200,
                        );
                        if (voteImages && voteImages.images && voteImages.images.length > 0) {
                            // Check for cancellation before vote submission
                            if (cancellation.isCancelled()) {
                                logger
                                    .withCategory('voting')
                                    .info('Mock voting cancelled by user before vote submission', null);
                                return {
                                    success: false,
                                    message: 'Mock voting cancelled by user',
                                    challenges: allChallenges,
                                };
                            }

                            await simulateApiResponse(voting.mockVoteSubmissionSuccess, 2000);
                        }
                    }
                } else {
                    // Log why voting was skipped
                    logger
                        .withCategory('voting')
                        .debug(`Skipping voting on challenge: ${challenge.title} - ${voteReason}`, null);
                }

                // Check for cancellation before delay
                if (cancellation.isCancelled()) {
                    logger.withCategory('voting').info('Mock voting cancelled by user before delay', null);
                    return { success: false, message: 'Mock voting cancelled by user', challenges: allChallenges };
                }

                // Simulate delay between challenges
                await new Promise((resolve) => setTimeout(resolve, 500));
            }

            logger.withCategory('voting').info('Mock Voting Process Completed', null);
            return { success: true, message: 'Mock voting process completed', challenges: allChallenges };
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
