/**
 * IPC handlers for the bankroll-currency spends on an entered challenge:
 * key-unlock-boost, preview-swap-photo, swap-entry-photo, get-swap-backs,
 * swap-back-entry-photo and fill-exposure.
 *
 * Every spend requires an explicit confirmed === true (the renderer's confirm
 * modal / the CLI's --yes); without it the handler returns outcome
 * 'needs-confirm' and nothing is spent. The service layer
 * (services/currencyActions.ts) re-checks the live challenge and bankroll
 * before calling the API. Results carry an outcome code
 * (voting/currencyActions CURRENCY_OUTCOME) that the renderer and CLI map to
 * their own wording. Handlers never throw to the renderer.
 */

import * as settings from '../settings';
import { registerHandlers } from './registerHandlers';
import * as logger from '../logger';
import * as apiFactory from '../apiFactory';
import * as auth from '../services/auth';
import * as currencyActions from '../services/currencyActions';
import { CURRENCY_OUTCOME } from '../voting/currencyActions';
import { swapBackLedger, mockSwapBackLedger } from '../swapBackStore';

/**
 * @import { IpcMain } from 'electron'
 * @import { IpcHandlerMap, IpcReplyFn } from './registerHandlers'
 * @import { ApiStrategy } from '../apiFactory'
 * @import { SpendOutcome } from '../services/currencyActions'
 */

const sanitizeForLog = logger.sanitizeLogString;

// Swap previews awaiting confirmation, keyed `challengeId:imageId`. The commit
// must name the exact candidate the user was shown; an entry is single-use
// (deleted on any commit attempt) and expires after PREVIEW_TTL_MS. Bounded so
// a long session cannot grow it without limit.
/** @type {Map<string, { candidateId: string, expiresAt: number }>} */
const swapPreviews = new Map();
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_SWAP_PREVIEWS = 32;

/**
 * @param {string | number} challengeId
 * @param {string | number} imageId
 */
const previewKey = (challengeId, imageId) => `${challengeId}:${imageId}`;

/**
 * @param {string} key
 * @param {string} candidateId
 */
const rememberSwapPreview = (key, candidateId) => {
    const now = Date.now();
    for (const [k, v] of swapPreviews) {
        if (v.expiresAt <= now) swapPreviews.delete(k);
    }
    if (swapPreviews.size >= MAX_SWAP_PREVIEWS) {
        // Non-empty here (size >= MAX_SWAP_PREVIEWS), so the oldest key exists.
        swapPreviews.delete(/** @type {string} */ (swapPreviews.keys().next().value));
    }
    swapPreviews.set(key, { candidateId, expiresAt: now + PREVIEW_TTL_MS });
};

/**
 * @param {string} key
 * @returns {string | null}
 */
const takeSwapPreview = (key) => {
    const entry = swapPreviews.get(key);
    swapPreviews.delete(key);
    return entry && entry.expiresAt > Date.now() ? entry.candidateId : null;
};

// Mock mode keeps its swap-back records in memory — it must never touch the
// real ledger file (same rule as metadata/join state). The in-memory ledger is
// the one the mock voting pass also records automatic swaps into.
/** @param {ApiStrategy | null | undefined} strategy */
const ledgerFor = (strategy) => (strategy?.getStrategyType?.() === 'MockAPI' ? mockSwapBackLedger : swapBackLedger);

/**
 * @param {unknown} value
 * @returns {value is string | number}
 */
const isIdArg = (value) => (typeof value === 'string' && value.trim() !== '') || Number.isFinite(value);

/**
 * @param {string | undefined} outcome
 * @satisfies {IpcReplyFn}
 */
const currencyFailure = (outcome) => ({ success: false, outcome, error: outcome });

/**
 * Shared shell of every spend handler: argument validation, auth, the explicit
 * confirmation gate, and the cross-channel spend lock. `spend(token, strategy)`
 * returns the service's {ok, outcome}. Never throws to the renderer.
 *
 * @param {string} label
 * @param {ReadonlyArray<string | number>} idArgs
 * @param {boolean} confirmed
 * @param {(token: string, strategy: ApiStrategy) => Promise<SpendOutcome>} spend
 * @satisfies {IpcReplyFn}
 */
const runCurrencySpend = async (label, idArgs, confirmed, spend) => {
    if (!idArgs.every(isIdArg)) return currencyFailure(CURRENCY_OUTCOME.invalidArgs);
    const guard = auth.requireAuthToken(label);
    if (!guard.ok) return guard.response;
    if (confirmed !== true) return currencyFailure(CURRENCY_OUTCOME.needsConfirm);
    try {
        // The process-wide spend lock, shared with the automatic runners: a
        // double click, a scripted loop and a spend by the voting pass all get
        // `busy` while another spend is in flight.
        const locked = await currencyActions.withSpendLock(() => spend(guard.token, apiFactory.getApiStrategy()));
        if (locked.busy) return currencyFailure(CURRENCY_OUTCOME.busy);
        const result = locked.value;
        return result?.ok ? { success: true, outcome: CURRENCY_OUTCOME.ok } : currencyFailure(result?.outcome);
    } catch (error) {
        logger.withCategory('currency').error(`Error handling ${label} request:`, error);
        return currencyFailure(CURRENCY_OUTCOME.apiFailed);
    }
};

const buildHandlers = () =>
    /** @satisfies {IpcHandlerMap} */ ({
        // Spend a KEY to unlock a LOCKED boost (unlock only — never applies it).
        // Requires confirmed === true; otherwise returns outcome 'needs-confirm'.
        'key-unlock-boost': async (
            /** @type {unknown} */ event,
            /** @type {string | number} */ challengeId,
            /** @type {boolean} */ confirmed,
        ) => {
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
        'preview-swap-photo': async (
            /** @type {unknown} */ event,
            /** @type {string | number} */ challengeId,
            /** @type {string} */ imageId,
        ) => {
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
        'swap-entry-photo': async (
            /** @type {unknown} */ event,
            /** @type {string | number} */ challengeId,
            /** @type {string} */ imageId,
            /** @type {string} */ newImageId,
            /** @type {boolean} */ confirmed,
        ) => {
            logger
                .withCategory('currency')
                .info(
                    `🔄 Swap request: Challenge=${sanitizeForLog(challengeId)}, Image=${sanitizeForLog(imageId)} → ${sanitizeForLog(newImageId)}, confirmed=${confirmed === true}`,
                    null,
                );
            return runCurrencySpend('swap', [challengeId, imageId, newImageId], confirmed, async (token, strategy) => {
                const previewed = takeSwapPreview(previewKey(challengeId, imageId));
                if (previewed === null || previewed !== String(newImageId)) {
                    return { ok: false, outcome: CURRENCY_OUTCOME.staleCandidate };
                }
                return currencyActions.swapEntry(challengeId, imageId, newImageId, token, {
                    strategy,
                    logger,
                    ledger: ledgerFor(strategy),
                });
            });
        },

        // Slots in this challenge that hold a replacement for a photo swapped out
        // while boosted/turbo'd — each can be swapped back to restore it. Reads
        // only the local ledger; spends nothing.
        'get-swap-backs': async (/** @type {unknown} */ event, /** @type {string | number} */ challengeId) => {
            if (!isIdArg(challengeId)) return currencyFailure(CURRENCY_OUTCOME.invalidArgs);
            try {
                const items = ledgerFor(apiFactory.getApiStrategy())
                    .list(challengeId)
                    .map(({ currentId, previousId, previousMemberId, kind }) => ({
                        currentId,
                        previousId,
                        previousMemberId,
                        kind,
                    }));
                return { success: true, items };
            } catch (error) {
                logger.withCategory('currency').error('Error handling get-swap-backs request:', error);
                return { success: false, items: [], error: CURRENCY_OUTCOME.apiFailed };
            }
        },

        // Spend a SWAP to put the recorded boosted/turbo'd original back into the
        // slot now holding `currentImageId`. The original comes from the ledger.
        'swap-back-entry-photo': async (
            /** @type {unknown} */ event,
            /** @type {string | number} */ challengeId,
            /** @type {string} */ currentImageId,
            /** @type {boolean} */ confirmed,
        ) => {
            logger
                .withCategory('currency')
                .info(
                    `↩️ Swap back request: Challenge=${sanitizeForLog(challengeId)}, Image=${sanitizeForLog(currentImageId)}, confirmed=${confirmed === true}`,
                    null,
                );
            return runCurrencySpend('swap back', [challengeId, currentImageId], confirmed, (token, strategy) =>
                currencyActions.swapBack(challengeId, currentImageId, token, {
                    strategy,
                    logger,
                    ledger: ledgerFor(strategy),
                }),
            );
        },

        // Spend a FILL to top the challenge's exposure up to 100%.
        'fill-exposure': async (
            /** @type {unknown} */ event,
            /** @type {string | number} */ challengeId,
            /** @type {boolean} */ confirmed,
        ) => {
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

/** @param {IpcMain} ipcMain */
const register = (ipcMain) => {
    registerHandlers(ipcMain, buildHandlers());
};

export { register, buildHandlers };
