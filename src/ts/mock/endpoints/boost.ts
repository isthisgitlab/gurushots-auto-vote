/**
 * Mock counterpart to the auto-cycle boost (strategies/real/applyBoost.ts)
 * and api/boost.ts's entry-targeted boost.
 */

import * as boost from '../boost';
import * as logger from '../../logger';
import { simulateApiResponse, mockMethod } from '../simulate';

import * as applyBoostModule from '../../strategies/real/applyBoost';

import type * as boostModule from '../../api/boost';

/**
 * Simulate applying boost from the boost state the challenge carries; a
 * challenge without one reads as boost not available.
 */
const applyBoost: typeof applyBoostModule.applyBoost = mockMethod(
    {
        name: 'applyBoost',
        tokenArg: 1,
        debug: (challenge, token) => {
            logger.withCategory('challenges').debug(`Challenge: ${challenge.title}`, null);
            logger.withCategory('voting').debug(`Boost state: ${challenge.member?.boost?.state}`, null);
            logger.withCategory('api').debug(`Token provided: ${!!token}`, null);
        },
        // Real applyBoost resolves null on failure
        onNoToken: () => null,
    },
    async (challenge, token) => {
        // Fake the server side of the boost post, not the strategy: the entry pick and
        // its failure handling stay in the real applyBoost this delegates to. The state
        // is read off the challenge this endpoint has in scope — the wire args carry
        // only ids. A non-available state resolves null, the transport failure contract
        // (api-client: body or null) — never a failure-shaped body, which the real
        // applyBoost would read as success and raise the boosted flag on.
        const fakeBoostPost: applyBoostModule.BoostImagePost = async (_challengeId, _imageId, _token) => {
            const boostState = challenge.member?.boost?.state;
            if (boostState === 'AVAILABLE' || boostState === 'AVAILABLE_KEY') {
                logger.withCategory('voting').debug('Applying boost successfully', null);
                return simulateApiResponse(boost.mockBoostSuccess, 1500);
            }
            if (boostState === 'USED') {
                logger.withCategory('voting').info('Boost already used', null);
            } else {
                logger.withCategory('voting').info('Boost not available', null);
            }
            return simulateApiResponse(null, 800);
        };
        return applyBoostModule.applyBoost(challenge, token, fakeBoostPost);
    },
);

/**
 * Simulate applying boost to a specific entry
 */
const applyBoostToEntry: typeof boostModule.applyBoostToEntry = mockMethod(
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

export { applyBoost, applyBoostToEntry };
