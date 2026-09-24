import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSwapPhoto, useSwapBack } from '@/api/useCurrencyActions';
import { interp } from '@/utils/interp';
import { useAutoClear } from '@/hooks/useAutoClear';
import { entryPhotoUrl } from '@/utils/formatters';
import { spentOrStale } from '@/utils/spentOrStale';
import { ActionButton } from '@/components/ui/ActionButton';
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
 * The swap trigger button (spinner while busy, red after a failure) plus the
 * inline outcome text of that failure.
 */
function SwapTrigger({ variant, label, busy, error, onClick }) {
    const { t } = useTranslation();
    return (
        <>
            <ActionButton variant={variant} error={error} onClick={onClick} disabled={busy}>
                {busy ? <span className="loading loading-spinner loading-xs" /> : label}
            </ActionButton>
            {error && (
                <span className="text-error" role="alert">
                    {currencyOutcomeText(t, error)}
                </span>
            )}
        </>
    );
}

/**
 * Swap confirm modal: the current photo beside the one that would take its
 * slot (once known), then the caller's explanation.
 */
function SwapConfirmModal({ current, other, otherCaption, children, ...modalProps }) {
    const { t } = useTranslation();
    return (
        <CurrencyConfirmModal {...modalProps} field="swaps">
            <div className="flex gap-3">
                <SwapPhoto photo={current} caption={t('app.currencySwapCurrent')} />
                {other && <SwapPhoto photo={other} caption={otherCaption} />}
            </div>
            {children}
        </CurrencyConfirmModal>
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
 * @param {boolean} props.warnActioned - the entry is boosted or turbo'd (its boost/turbo stays with the photo, so the replacement won't get it)
 * @param {string|number} props.challengeId
 * @param {object|null} props.bankroll
 * @param {function} props.onSpent - called after a successful swap
 */
export function SwapEntryButton({ entry, challengeId, bankroll, warnActioned, onSpent }) {
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
        if (spentOrStale(result)) onSpent();
    };

    return (
        <>
            <SwapTrigger
                variant="accent"
                label={`🔄 ${t('app.currencySwap')}`}
                busy={preview.loading || commit.loading}
                error={error}
                onClick={handlePreview}
            />
            <SwapConfirmModal
                isOpen={candidate !== null}
                onClose={() => setCandidate(null)}
                onConfirm={handleConfirm}
                title={t('app.currencySwapTitle')}
                bankroll={bankroll}
                spending={commit.loading}
                current={entry}
                other={candidate}
                otherCaption={t('app.currencySwapReplacement')}
            >
                <p>{t('app.currencySwapBody')}</p>
                {warnActioned && <p className="text-warning">{t('app.currencySwapBoostedWarning')}</p>}
            </SwapConfirmModal>
        </>
    );
}

/**
 * Per-entry "Swap back" button, shown on the photo that replaced one swapped
 * out while boosted/turbo'd: spends a SWAP to put the original back, which
 * restores its boost/turbo. The original comes from the main-side ledger.
 *
 * @param {object} props
 * @param {object} props.entry - the entry now in the slot
 * @param {{previousId: string, previousMemberId: string, kind: 'boost'|'turbo'}} props.swapBack
 * @param {string|number} props.challengeId
 * @param {object|null} props.bankroll
 * @param {function} props.onSpent
 */
export function SwapBackButton({ entry, swapBack, challengeId, bankroll, onSpent }) {
    const { t } = useTranslation();
    const { run, loading, error, clearError } = useSwapBack();
    const [confirmOpen, setConfirmOpen] = useState(false);

    useAutoClear(error, clearError, ERROR_DISPLAY_MS);

    const handleConfirm = async () => {
        const result = await run(challengeId, entry.id);
        setConfirmOpen(false);
        if (spentOrStale(result)) onSpent();
    };

    const original = { id: swapBack.previousId, member_id: swapBack.previousMemberId };
    const kindLabel = t(swapBack.kind === 'turbo' ? 'app.turbo' : 'app.boost');

    return (
        <>
            <SwapTrigger
                variant="info"
                label={`↩️ ${t('app.currencySwapBack')}`}
                busy={loading}
                error={error}
                onClick={() => setConfirmOpen(true)}
            />
            <SwapConfirmModal
                isOpen={confirmOpen}
                onClose={() => setConfirmOpen(false)}
                onConfirm={handleConfirm}
                title={t('app.currencySwapBackTitle')}
                bankroll={bankroll}
                spending={loading}
                current={entry}
                other={original}
                otherCaption={t('app.currencySwapBackOriginal')}
            >
                <p>{interp(t('app.currencySwapBackBody'), { kind: kindLabel })}</p>
            </SwapConfirmModal>
        </>
    );
}
