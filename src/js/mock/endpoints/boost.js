/**
 * Mock counterpart to the auto-cycle boost (strategies/real/applyBoost.js)
 * and api/boost.js's entry-targeted boost.
 */

const boost = require('../boost');
const logger = require('../../logger');
const votingLogic = require('../../services/VotingLogic');
const autoFill = require('../../services/autoFill');
const { simulateApiResponse, simulateApiError, mockMethod } = require('../simulate');

/**
 * Simulate applying boost
 */
const applyBoost = mockMethod(
    {
        name: 'applyBoost',
        tokenArg: 1,
        debug: (challenge, token) => {
            logger.withCategory('challenges').debug(`Challenge: ${challenge.title}`, null);
            logger.withCategory('voting').debug(`Boost state: ${challenge.member.boost.state}`, null);
            logger.withCategory('api').debug(`Token provided: ${!!token}`, null);
        },
        // Real applyBoost resolves null on failure
        onNoToken: () => null,
    },
    async (challenge) => {
        const boostState = challenge.member.boost.state;
        if (boostState === 'AVAILABLE' || boostState === 'AVAILABLE_KEY') {
            logger.withCategory('voting').debug('Applying boost successfully', null);
            // Mirror the real surface's side effect: resolve the same entry via the
            // shared picker and raise its conflict flag, so a turbo later in this same
            // mock pass avoids it. Without this the "boost and turbo never share an
            // entry" rule held only on the real surface and mock runs diverged.
            const picked = votingLogic.pickBoostEntry(challenge, challenge.id?.toString?.() || '');
            if (picked) autoFill.reflectEntryFlag(challenge, picked.id, 'boosted');
            return simulateApiResponse(boost.mockBoostSuccess, 1500);
        } else if (boostState === 'USED') {
            logger.withCategory('voting').info('Boost already used', null);
            return simulateApiError(boost.mockBoostAlreadyUsed, 800);
        } else {
            logger.withCategory('voting').info('Boost not available', null);
            return simulateApiError(boost.mockBoostFailure, 800);
        }
    },
);

/**
 * Simulate applying boost to a specific entry
 */
const applyBoostToEntry = mockMethod(
    {
        name: 'applyBoostToEntry',
        tokenArg: 2,
        debug: (challengeId, imageId, token) => {
            logger.withCategory('challenges').debug(`Challenge ID: ${challengeId}`, null);
            logger.withCategory('voting').debug(`Image ID: ${imageId}`, null);
            logger.withCategory('general').debug(`Token provided: ${token ? 'yes' : 'none'}`);
        },
        // Real applyBoostToEntry resolves null on failure
        onNoToken: () => null,
    },
    async () => {
        logger.withCategory('voting').debug('Applying boost to specific entry successfully', null);
        return simulateApiResponse(boost.mockBoostSuccess, 1500);
    },
);

module.exports = { applyBoost, applyBoostToEntry };
