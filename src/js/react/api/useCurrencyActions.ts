import { useAsyncIpcAction } from './useAsyncIpcAction';

// Every spend passes confirmed=true: these hooks are only invoked from the
// confirm modal's Spend button. The main process refuses a spend without it.

const SPEND_LABELS = { failureMessage: 'api-failed', errorMessage: 'api-failed' };

/**
 * Spend a KEY to unlock a challenge's locked boost (unlock only).
 * Returns { run(challengeId), loading, error, clearError }; `error` is the
 * outcome code the handler returned (see voting/currencyActions CURRENCY_OUTCOME).
 */
export const useKeyUnlock = () =>
    useAsyncIpcAction((challengeId: string | number) => window.api.keyUnlockBoost(challengeId, true), SPEND_LABELS);

/**
 * Spend a FILL to top a challenge's exposure up to 100%. Same shape as useKeyUnlock.
 */
export const useFillExposure = () =>
    useAsyncIpcAction((challengeId: string | number) => window.api.fillExposure(challengeId, true), SPEND_LABELS);

/**
 * Swap flow: `preview` (spends nothing) suggests the replacement for one
 * entry; `commit` spends a SWAP to put exactly that suggestion in place.
 */
export function useSwapPhoto() {
    const preview = useAsyncIpcAction(
        (challengeId: string | number, imageId: string) => window.api.previewSwapPhoto(challengeId, imageId),
        SPEND_LABELS,
    );
    const commit = useAsyncIpcAction(
        (challengeId: string | number, imageId: string, newImageId: string) =>
            window.api.swapEntryPhoto(challengeId, imageId, newImageId, true),
        SPEND_LABELS,
    );
    return { preview, commit };
}

/**
 * Spend a SWAP to put the recorded boosted/turbo'd original back into the slot
 * now holding `currentImageId`. Same shape as useKeyUnlock.
 */
export const useSwapBack = () =>
    useAsyncIpcAction(
        (challengeId: string | number, currentImageId: string) =>
            window.api.swapBackEntryPhoto(challengeId, currentImageId, true),
        SPEND_LABELS,
    );
