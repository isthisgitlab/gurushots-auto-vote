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
import { isIdArg } from './isIdArg';
import * as logger from '../logger';
import * as apiFactory from '../apiFactory';
import * as auth from '../services/auth';
import * as currencyActions from '../services/currencyActions';
import { CURRENCY_OUTCOME } from '../voting/currencyActions';
import { swapBackLedger, mockSwapBackLedger } from '../swapBackStore';

import type { IpcMain } from 'electron';
import type { IpcHandlerMap, IpcReplyFn } from './registerHandlers';
import type { ApiStrategy } from '../apiFactory';
import type { SpendOutcome } from '../services/currencyActions';

const sanitizeForLog = logger.sanitizeLogString;

// Swap previews awaiting confirmation, keyed `challengeId:imageId`. The commit
// must name the exact candidate the user was shown; an entry is single-use
// (deleted on any commit attempt) and expires after PREVIEW_TTL_MS. Bounded so
// a long session cannot grow it without limit.
const swapPreviews: Map<string, { candidateId: string; expiresAt: number }> = new Map();
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_SWAP_PREVIEWS = 32;

const previewKey = (challengeId: string | number, imageId: string | number) => `${challengeId}:${imageId}`;

const rememberSwapPreview = (key: string, candidateId: string) => {
    const now = Date.now();
    for (const [k, v] of swapPreviews) {
        if (v.expiresAt <= now) swapPreviews.delete(k);
    }
    if (swapPreviews.size >= MAX_SWAP_PREVIEWS) {
        // Non-empty here (size >= MAX_SWAP_PREVIEWS), so the oldest key exists.
        swapPreviews.delete(swapPreviews.keys().next().value as string);
    }
    swapPreviews.set(key, { candidateId, expiresAt: now + PREVIEW_TTL_MS });
};

const takeSwapPreview = (key: string): string | null => {
    const entry = swapPreviews.get(key);
    swapPreviews.delete(key);
    return entry && entry.expiresAt > Date.now() ? entry.candidateId : null;
};

// Mock mode keeps its swap-back records in memory — it must never touch the
// real ledger file (same rule as metadata/join state). The in-memory ledger is
// the one the mock voting pass also records automatic swaps into.
const ledgerFor = (strategy: ApiStrategy | null | undefined) =>
    strategy?.getStrategyType?.() === 'MockAPI' ? mockSwapBackLedger : swapBackLedger;

const currencyFailure = ((outcome: string | undefined) => ({
    success: false as const,
    outcome,
    error: outcome,
})) satisfies IpcReplyFn;

/**
 * Shared shell of every spend handler: argument validation, auth, the explicit
 * confirmation gate, and the cross-channel spend lock. `spend(token, strategy)`
 * returns the service's {ok, outcome}. Never throws to the renderer.
 */
const runCurrencySpend = (async (
    label: string,
    idArgs: ReadonlyArray<string | number>,
    confirmed: boolean,
    spend: (token: string, strategy: ApiStrategy) => Promise<SpendOutcome>,
) => {
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
        return result?.ok ? { success: true as const, outcome: CURRENCY_OUTCOME.ok } : currencyFailure(result?.outcome);
    } catch (error) {
        logger.withCategory('currency').error(`Error handling ${label} request:`, error);
        return currencyFailure(CURRENCY_OUTCOME.apiFailed);
    }
}) satisfies IpcReplyFn;

const buildHandlers = () =>
    ({
        // Spend a KEY to unlock a LOCKED boost (unlock only — never applies it).
        // Requires confirmed === true; otherwise returns outcome 'needs-confirm'.
        'key-unlock-boost': async (event: unknown, challengeId: string | number, confirmed: boolean) => {
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
        'preview-swap-photo': async (event: unknown, challengeId: string | number, imageId: string | number) => {
            if (!isIdArg(challengeId) || !isIdArg(imageId)) return currencyFailure(CURRENCY_OUTCOME.invalidArgs);
            // isIdArg admits numbers; the service and the preview key work on strings.
            const image = String(imageId);
            try {
                logger
                    .withCategory('currency')
                    .info(
                        `🔄 Swap preview request: Challenge=${sanitizeForLog(challengeId)}, Image=${sanitizeForLog(imageId)}`,
                        null,
                    );
                const guard = auth.requireAuthToken('swap preview');
                if (!guard.ok) return guard.response;
                const result = await currencyActions.previewSwap(challengeId, image, guard.token, {
                    strategy: apiFactory.getApiStrategy(),
                    logger,
                    settings,
                });
                if (!result?.ok || !result.candidate) return currencyFailure(result?.outcome);
                rememberSwapPreview(previewKey(challengeId, image), result.candidate.id);
                return { success: true as const, outcome: CURRENCY_OUTCOME.ok, candidate: result.candidate };
            } catch (error) {
                logger.withCategory('currency').error('Error handling preview-swap-photo request:', error);
                return currencyFailure(CURRENCY_OUTCOME.apiFailed);
            }
        },

        // Spend a SWAP: replace `imageId` with `newImageId`, which must be the
        // unexpired candidate preview-swap-photo returned for this entry.
        'swap-entry-photo': async (
            event: unknown,
            challengeId: string | number,
            imageId: string | number,
            newImageId: string | number,
            confirmed: boolean,
        ) => {
            logger
                .withCategory('currency')
                .info(
                    `🔄 Swap request: Challenge=${sanitizeForLog(challengeId)}, Image=${sanitizeForLog(imageId)} → ${sanitizeForLog(newImageId)}, confirmed=${confirmed === true}`,
                    null,
                );
            return runCurrencySpend('swap', [challengeId, imageId, newImageId], confirmed, async (token, strategy) => {
                // Validated by runCurrencySpend, which admits numbers; the service works on strings.
                const image = String(imageId);
                const newImage = String(newImageId);
                const previewed = takeSwapPreview(previewKey(challengeId, image));
                if (previewed === null || previewed !== newImage) {
                    return { ok: false, outcome: CURRENCY_OUTCOME.staleCandidate };
                }
                return currencyActions.swapEntry(challengeId, image, newImage, token, {
                    strategy,
                    logger,
                    ledger: ledgerFor(strategy),
                });
            });
        },

        // Slots in this challenge that hold a replacement for a photo swapped out
        // while boosted/turbo'd — each can be swapped back to restore it. Reads
        // only the local ledger; spends nothing.
        'get-swap-backs': async (event: unknown, challengeId: string | number) => {
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
                return { success: true as const, items };
            } catch (error) {
                logger.withCategory('currency').error('Error handling get-swap-backs request:', error);
                return { success: false as const, items: [], error: CURRENCY_OUTCOME.apiFailed };
            }
        },

        // Spend a SWAP to put the recorded boosted/turbo'd original back into the
        // slot now holding `currentImageId`. The original comes from the ledger.
        'swap-back-entry-photo': async (
            event: unknown,
            challengeId: string | number,
            currentImageId: string,
            confirmed: boolean,
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
        'fill-exposure': async (event: unknown, challengeId: string | number, confirmed: boolean) => {
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
    }) satisfies IpcHandlerMap;

const register = (ipcMain: IpcMain) => {
    registerHandlers(ipcMain, buildHandlers());
};

export { register, buildHandlers };
