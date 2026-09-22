import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSwapPhoto } from '@/api/useCurrencyActions';
import { useAutoClear } from '@/hooks/useAutoClear';
import { entryPhotoUrl } from '@/utils/formatters';
import { CurrencyConfirmModal, currencyOutcomeText } from './CurrencyConfirmModal';

const ERROR_DISPLAY_MS = 5000;
const PREVIEW_PX = 240;

/**
 * One side of the swap comparison: the photo plus a visible caption, so the
 * current/replacement distinction never rests on left/right position alone.
 */
function SwapPhoto({ photo, caption }) {
    const url = entryPhotoUrl(photo, { size: PREVIEW_PX, fit: true });
    return (
        <figure className="flex flex-1 flex-col items-center gap-1">
            {url ? (
                <img
                    src={url}
                    alt={caption}
                    referrerPolicy="no-referrer"
                    className="aspect-square w-full rounded object-contain bg-base-200"
                />
            ) : (
                <div className="aspect-square w-full rounded bg-base-200" aria-hidden="true" />
            )}
            <figcaption className="text-xs font-medium">{caption}</figcaption>
        </figure>
    );
}

/**
 * Per-entry Swap button. Click → the app suggests a replacement (spends
 * nothing; the button spins meanwhile) → confirm modal shows current vs
 * replacement → Spend swaps exactly that suggestion. A swap that can't happen
 * (no different photo) is reported inline without opening the modal.
 *
 * @param {object} props
 * @param {object} props.entry - entry record (id, member_id)
 * @param {boolean} props.warnActioned - the entry is boosted or turbo'd (warn it may not carry over)
 * @param {string|number} props.challengeId
 * @param {object|null} props.bankroll
 * @param {boolean} props.disabled
 * @param {function} [props.onSpent] - called after a successful swap
 */
export function SwapEntryButton({ entry, challengeId, bankroll, warnActioned, disabled, onSpent }) {
    const { t } = useTranslation();
    const { preview, commit } = useSwapPhoto();
    const [candidate, setCandidate] = useState(null);
    const error = preview.error || commit.error;

    useAutoClear(preview.error, preview.clearError, ERROR_DISPLAY_MS);
    useAutoClear(commit.error, commit.clearError, ERROR_DISPLAY_MS);

    const handlePreview = async () => {
        commit.clearError();
        const result = await preview.run(challengeId, entry.id);
        if (result?.success && result.candidate) setCandidate(result.candidate);
    };

    const handleConfirm = async () => {
        const result = await commit.run(challengeId, entry.id, candidate.id);
        setCandidate(null);
        if ((result?.success || result?.outcome === 'not-available') && onSpent) onSpent();
    };

    const busy = preview.loading || commit.loading;

    return (
        <>
            <button
                className={`btn btn-xs ${error ? 'btn-error' : 'btn-accent'}`}
                onClick={handlePreview}
                disabled={disabled || busy}
            >
                {busy ? <span className="loading loading-spinner loading-xs" /> : `🔄 ${t('app.currencySwap')}`}
            </button>
            {error && (
                <span className="text-error" role="alert">
                    {currencyOutcomeText(t, error)}
                </span>
            )}
            <CurrencyConfirmModal
                isOpen={candidate !== null}
                onClose={() => setCandidate(null)}
                onConfirm={handleConfirm}
                title={t('app.currencySwapTitle')}
                field="swaps"
                bankroll={bankroll}
                spending={commit.loading}
            >
                <div className="flex gap-3">
                    <SwapPhoto photo={entry} caption={t('app.currencySwapCurrent')} />
                    {candidate && <SwapPhoto photo={candidate} caption={t('app.currencySwapReplacement')} />}
                </div>
                <p>{t('app.currencySwapBody')}</p>
                {warnActioned && <p className="text-warning">{t('app.currencySwapBoostedWarning')}</p>}
            </CurrencyConfirmModal>
        </>
    );
}
