/**
 * Mock counterpart to the active-challenge read (strategies/real/activeChallenges.js
 * over api/challenges.js): session-stable generated challenges.
 */

const challenges = require('../challenges');
const settings = require('../../settings');
const logger = require('../../logger');
const { simulateApiResponse, mockMethod } = require('../simulate');
const { getSessionCache } = require('../sessionCache');

/**
 * Simulate getting active challenges
 */
const getActiveChallenges = mockMethod(
    {
        name: 'getActiveChallenges',
        tokenArg: 0,
        debug: (token) => {
            logger.withCategory('api').debug(`Token provided: ${!!token}`, null);
            logger
                .withCategory('api')
                .debug(`Token starts with mock_: ${token ? token.startsWith('mock_') : false}`, null);
        },
        // Real getActiveChallenges resolves a flagged empty list on failure, and a
        // missing token is a failure to fetch — not an account with nothing active.
        // Mirroring the flag keeps the mock strategy on the same contract, so the
        // shared voting pass reports an outage identically on both surfaces.
        onNoToken: () => ({ challenges: [], fetchFailed: true }),
    },
    async () => {
        const sessionMockCache = getSessionCache();
        // Use cached challenges for session stability, generate only once per session
        if (!sessionMockCache.challenges) {
            sessionMockCache.challenges = challenges.generateMockChallenges();
            logger
                .withCategory('challenges')
                .info(
                    `Generated session-stable mock challenges: ${sessionMockCache.challenges.challenges.length}`,
                    null,
                );
        } else {
            logger
                .withCategory('challenges')
                .info(`Using cached mock challenges: ${sessionMockCache.challenges.challenges.length}`, null);
        }
        // Match the real API's title-profile behavior without persisting
        // mock challenge ids into the user's real settings.
        settings.rememberChallengeTitles(sessionMockCache.challenges.challenges);
        return simulateApiResponse(sessionMockCache.challenges, 800);
    },
);

module.exports = { getActiveChallenges };
