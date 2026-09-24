/**
 * Mock counterpart to api/currency.js: the three bankroll spends
 * (/rest/key_unlock, /rest/swap, /rest/exposure_autofill). Stateless;
 * fixture 900004 fails (success:false) so every spend-failure path can be
 * exercised in mock mode.
 */

const { simulateApiResponse, mockMethod } = require('../simulate');

// Shared body of the mock currency spends: fixture 900004 is the failure sentinel.
const mockSpendResult = async (challengeId) => {
    await simulateApiResponse({}, 300);
    if (String(challengeId) === '900004') {
        return { ok: false, raw: { success: false } };
    }
    return { ok: true, raw: { success: true } };
};

const keyUnlock = mockMethod(
    { name: 'keyUnlock', tokenArg: 1, onNoToken: () => ({ ok: false, raw: null }) },
    async (challengeId) => mockSpendResult(challengeId),
);

const swapPhoto = mockMethod(
    { name: 'swapPhoto', tokenArg: 3, onNoToken: () => ({ ok: false, raw: null }) },
    async (challengeId) => mockSpendResult(challengeId),
);

const exposureAutofill = mockMethod(
    { name: 'exposureAutofill', tokenArg: 2, onNoToken: () => ({ ok: false, raw: null }) },
    async (challengeId) => mockSpendResult(challengeId),
);

module.exports = { keyUnlock, swapPhoto, exposureAutofill };
