/**
 * Mock counterpart to api/currency.js: the three bankroll spends
 * (/rest/key_unlock, /rest/swap, /rest/exposure_autofill). Stateless;
 * fixture 900004 fails (success:false) so every spend-failure path can be
 * exercised in mock mode.
 */

import { simulateApiResponse, mockMethod } from '../simulate';

/** @import { ActionResult } from '../../types/gurushots' */

// Shared body of the mock currency spends: fixture 900004 is the failure sentinel.
/**
 * @param {string|number} challengeId
 * @returns {Promise<ActionResult>}
 */
const mockSpendResult = async (challengeId) => {
    await simulateApiResponse({}, 300);
    if (String(challengeId) === '900004') {
        return { ok: false, raw: { success: false } };
    }
    return { ok: true, raw: { success: true } };
};

/** @type {typeof import('../../api/currency').keyUnlock} */
const keyUnlock = mockMethod(
    { name: 'keyUnlock', tokenArg: 1, onNoToken: () => ({ ok: false, raw: null }) },
    async (challengeId) => mockSpendResult(challengeId),
);

/** @type {typeof import('../../api/currency').swapPhoto} */
const swapPhoto = mockMethod(
    { name: 'swapPhoto', tokenArg: 3, onNoToken: () => ({ ok: false, raw: null }) },
    async (challengeId) => mockSpendResult(challengeId),
);

/** @type {typeof import('../../api/currency').exposureAutofill} */
const exposureAutofill = mockMethod(
    { name: 'exposureAutofill', tokenArg: 2, onNoToken: () => ({ ok: false, raw: null }) },
    async (challengeId) => mockSpendResult(challengeId),
);

export { keyUnlock, swapPhoto, exposureAutofill };
