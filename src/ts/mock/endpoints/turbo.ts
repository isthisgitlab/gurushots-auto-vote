/**
 * Mock counterpart to api/turbo.ts's apply and the real strategy's Turbo
 * game (strategies/real/index.ts#runTurboGame).
 */

import * as logger from '../../logger';
import { simulateApiResponse, mockMethod } from '../simulate';
import type * as turboModule from '../../api/turbo';
import type { TurboGameResult } from '../../types/gurushots';
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
 * Simulate playing a turbo game. Mirrors the real strategies/real runTurboGame result (the classic mini-game's
 * { played, correct, flipped, doubleFailed, won } or the Snap game's { answered, total, meanAgreement, won,
 * stopReason }, by the challenge's mode) so the manual-turbo IPC handler behaves the same in mock mode instead of
 * reaching the live endpoints.
 */
const runTurboGame: typeof realModule.runTurboGame = mockMethod(
    {
        name: 'runTurboGame',
        category: 'turbo',
        tokenArg: 1,
        debug: (challenge) => {
            logger.withCategory('challenges').debug(`Challenge ID: ${challenge?.id}`, null);
        },
        noTokenMessage: 'No token provided, no battles played',
        onNoToken: () => ({ kind: 'classic', played: 0, correct: 0, flipped: 0, doubleFailed: 0, won: false }),
    },
    async (challenge): Promise<TurboGameResult> => {
        await simulateApiResponse({}, 800);
        if (challenge?.member?.turbo?.mode === 'snap') {
            return { kind: 'snap', answered: 10, total: 10, meanAgreement: 72, won: true, stopReason: 'completed' };
        }
        return { kind: 'classic', played: 1, correct: 1, flipped: 0, doubleFailed: 0, won: true };
    },
);

export { applyTurbo, runTurboGame };
