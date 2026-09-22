/**
 * IPC handlers for the bankroll-currency spends on an entered challenge:
 * key-unlock-boost, preview-swap-photo, swap-entry-photo and fill-exposure.
 *
 * Every spend requires an explicit confirmed === true (the renderer's confirm
 * modal / the CLI's --yes); without it the handler returns outcome
 * 'needs-confirm' and nothing is spent. The service layer
 * (services/currencyActions.js) re-checks the live challenge and bankroll
 * before calling the API. Results carry an outcome code
 * (voting/currencyActions CURRENCY_OUTCOME) that the renderer and CLI map to
 * their own wording. Handlers never throw to the renderer.
 */

const settings = require('../settings');
const { registerHandlers } = require('./registerHandlers');
const logger = require('../logger');
const apiFactory = require('../apiFactory');
const auth = require('../services/auth');
const currencyActions = require('../services/currencyActions');
const { CURRENCY_OUTCOME } = require('../voting/currencyActions');

const sanitizeForLog = logger.sanitizeLogString;

// ONE lock across all three spend channels: a single spend in flight at a time.
// Stops a double click and a scripted loop across challenges alike; the others
// get `busy`. Released in `finally` so a throw can never wedge it.
let currencySpendInFlight = false;

// Swap previews awaiting confirmation, keyed `challengeId:imageId`. The commit
// must name the exact candidate the user was shown; an entry is single-use
// (deleted on any commit attempt) and expires after PREVIEW_TTL_MS. Bounded so
// a long session cannot grow it without limit.
const swapPreviews = new Map();
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_SWAP_PREVIEWS = 32;

const previewKey = (challengeId, imageId) => `${challengeId}:${imageId}`;

const rememberSwapPreview = (key, candidateId) => {
    const now = Date.now();
    for (const [k, v] of swapPreviews) {
        if (v.expiresAt <= now) swapPreviews.delete(k);
    }
    if (swapPreviews.size >= MAX_SWAP_PREVIEWS) {
        swapPreviews.delete(swapPreviews.keys().next().value);
    }
    swapPreviews.set(key, { candidateId, expiresAt: now + PREVIEW_TTL_MS });
};

const takeSwapPreview = (key) => {
    const entry = swapPreviews.get(key);
    swapPreviews.delete(key);
    return entry && entry.expiresAt > Date.now() ? entry.candidateId : null;
};

const isIdArg = (value) => (typeof value === 'string' && value.trim() !== '') || Number.isFinite(value);

const currencyFailure = (outcome) => ({ success: false, outcome, error: outcome });

/**
 * Shared shell of every spend handler: argument validation, auth, the explicit
 * confirmation gate, and the cross-channel spend lock. `spend(token, strategy)`
 * returns the service's {ok, outcome}. Never throws to the renderer.
 */
const runCurrencySpend = async (label, idArgs, confirmed, spend) => {
    if (!idArgs.every(isIdArg)) return currencyFailure(CURRENCY_OUTCOME.invalidArgs);
    const guard = auth.requireAuthToken(label);
    if (!guard.ok) return guard.response;
    if (confirmed !== true) return currencyFailure(CURRENCY_OUTCOME.needsConfirm);
    if (currencySpendInFlight) return currencyFailure(CURRENCY_OUTCOME.busy);
    currencySpendInFlight = true;
    try {
        const result = await spend(guard.token, apiFactory.getApiStrategy());
        return result?.ok ? { success: true, outcome: CURRENCY_OUTCOME.ok } : currencyFailure(result?.outcome);
    } catch (error) {
        logger.withCategory('currency').error(`Error handling ${label} request:`, error);
        return currencyFailure(CURRENCY_OUTCOME.apiFailed);
    } finally {
        currencySpendInFlight = false;
    }
};

const buildHandlers = () => ({
    // Spend a KEY to unlock a LOCKED boost (unlock only — never applies it).
    // Requires confirmed === true; otherwise returns outcome 'needs-confirm'.
    'key-unlock-boost': async (event, challengeId, confirmed) => {
        logger
            .withCategory('currency')
            .info(
                `🔑 Key unlock request: Challenge=${sanitizeForLog(challengeId)}, confirmed=${confirmed === true}`,
                null,
            );
        return runCurrencySpend('key unlock', [challengeId], confirmed, (token, strategy) =>
            currencyActions.unlockBoostWithKey(challengeId, token, { strategy, logger }),
        );
    },

    // Suggest the replacement a swap of `imageId` would use. Spends nothing;
    // the candidate is remembered so swap-entry-photo can require it.
    'preview-swap-photo': async (event, challengeId, imageId) => {
        if (!isIdArg(challengeId) || !isIdArg(imageId)) return currencyFailure(CURRENCY_OUTCOME.invalidArgs);
        try {
            logger
                .withCategory('currency')
                .info(
                    `🔄 Swap preview request: Challenge=${sanitizeForLog(challengeId)}, Image=${sanitizeForLog(imageId)}`,
                    null,
                );
            const guard = auth.requireAuthToken('swap preview');
            if (!guard.ok) return guard.response;
            const result = await currencyActions.previewSwap(challengeId, imageId, guard.token, {
                strategy: apiFactory.getApiStrategy(),
                logger,
                settings,
            });
            if (!result?.ok || !result.candidate) return currencyFailure(result?.outcome);
            rememberSwapPreview(previewKey(challengeId, imageId), result.candidate.id);
            return { success: true, outcome: CURRENCY_OUTCOME.ok, candidate: result.candidate };
        } catch (error) {
            logger.withCategory('currency').error('Error handling preview-swap-photo request:', error);
            return currencyFailure(CURRENCY_OUTCOME.apiFailed);
        }
    },

    // Spend a SWAP: replace `imageId` with `newImageId`, which must be the
    // unexpired candidate preview-swap-photo returned for this entry.
    'swap-entry-photo': async (event, challengeId, imageId, newImageId, confirmed) => {
        logger
            .withCategory('currency')
            .info(
                `🔄 Swap request: Challenge=${sanitizeForLog(challengeId)}, Image=${sanitizeForLog(imageId)} → ${sanitizeForLog(newImageId)}, confirmed=${confirmed === true}`,
                null,
            );
        return runCurrencySpend('swap', [challengeId, imageId, newImageId], confirmed, (token, strategy) => {
            const previewed = takeSwapPreview(previewKey(challengeId, imageId));
            if (previewed === null || previewed !== String(newImageId)) {
                return { ok: false, outcome: CURRENCY_OUTCOME.staleCandidate };
            }
            return currencyActions.swapEntry(challengeId, imageId, newImageId, token, { strategy, logger });
        });
    },

    // Spend a FILL to top the challenge's exposure up to 100%.
    'fill-exposure': async (event, challengeId, confirmed) => {
        logger
            .withCategory('currency')
            .info(
                `📈 Fill exposure request: Challenge=${sanitizeForLog(challengeId)}, confirmed=${confirmed === true}`,
                null,
            );
        return runCurrencySpend('fill exposure', [challengeId], confirmed, (token, strategy) =>
            currencyActions.fillExposure(challengeId, token, { strategy, logger }),
        );
    },
});

const register = (ipcMain) => {
    registerHandlers(ipcMain, buildHandlers());
};

module.exports = { register, buildHandlers };
