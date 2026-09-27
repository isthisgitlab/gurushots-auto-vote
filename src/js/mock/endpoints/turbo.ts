/**
 * Mock counterpart to api/turbo.ts's apply and the real strategy's Turbo
 * mini-game (strategies/real/index.js#runTurboMiniGame).
 */

import * as logger from '../../logger';
import { simulateApiResponse, mockMethod } from '../simulate';
import type * as turboModule from '../../api/turbo';
import type * as realModule from '../../strategies/real';

/**
 * Simulate applying a won Turbo to a specific entry. The shape mirrors
 * the live /rest/set_challenge_turbo response: { ok, raw }.
 */
const applyTurbo: typeof turboModule.applyTurbo = mockMethod(
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
);

/**
 * Simulate playing the Turbo mini-game. Mirrors the real
 * strategies/real runTurboMiniGame result shape ({ played, correct, flipped,
 * doubleFailed, won }) so the manual-turbo IPC handler behaves the same
 * in mock mode instead of reaching the live battle endpoints.
 */
const runTurboMiniGame: typeof realModule.runTurboMiniGame = mockMethod(
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
);

export { applyTurbo, runTurboMiniGame };
