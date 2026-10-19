import { useId, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { ToneNote } from '@/components/ui/ToneNote';
import { useSwapPhoto, useSwapBack } from '@/api/useCurrencyActions';
import { interp } from '@/utils/interp';
import { entryPhotoUrl } from '@/utils/formatters';
import { alreadyEntered, spentOrStale } from '@/utils/spentOrStale';
import { CURRENCY_OUTCOME } from '../../../voting/currencyActions';
import { ActionButton } from '@/components/ui/ActionButton';
import { InlineError } from '@/components/ui/InlineError';
import { BusyContent } from '@/components/ui/LoadingSpinner';

import { CurrencyConfirmModal, currencyOutcomeText } from './CurrencyConfirmModal';

import type { Bankroll, Challenge, RankingEntry } from '../../../types/gurushots';
import type { SwapCandidate } from '../../../services/currencyActions';
import type { EntryPinKind } from '../../../types/settings';
import type { SwapBackOffer } from '@/api/useSwapBacks';
import type { ComponentChildren, Ref } from 'preact';
import type { ActionButtonVariant } from '@/components/ui/ActionButton';
import type { CurrencyConfirmModalProps } from './CurrencyConfirmModal';

const PREVIEW_PX = 240;

/**
 * One side of the swap comparison: the photo plus a visible caption, so the
 * current/replacement distinction never rests on left/right position alone.
 */
function SwapPhoto({ photo, caption }: { photo: Pick<RankingEntry, 'id' | 'member_id'>; caption: string }) {
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
function SwapTrigger({
    variant,
    label,
    busy,
    error,
    buttonRef,
    onClick,
    onDismiss,
    children,
}: {
    variant: ActionButtonVariant;
    label: string;
    busy: boolean;
    error: string | null;
    buttonRef?: Ref<HTMLButtonElement>;
    onClick: () => void | Promise<void>;
    onDismiss: () => void;
    /** Sits right after the button, before the inline error. */
    children?: ComponentChildren;
}) {
    const { t } = useTranslation();
    return (
        <>
            <ActionButton
                ref={buttonRef}
                variant={variant}
                error={error}
                onClick={() => void onClick()}
                disabled={busy}
                aria-busy={busy}
            >
                <BusyContent busy={busy} label={label} />
            </ActionButton>
            {children}
            {error && <InlineError onDismiss={onDismiss}>{currencyOutcomeText(t, error)}</InlineError>}
        </>
    );
}

/**
 * Swap confirm modal: the current photo beside the one that would take its
 * slot (once known), then the caller's explanation.
 */
export function SwapConfirmModal({
    current,
    other,
    otherCaption,
    children,
    ...modalProps
}: Omit<CurrencyConfirmModalProps, 'field'> & {
    current: Pick<RankingEntry, 'id' | 'member_id'>;
    other: Pick<RankingEntry, 'id' | 'member_id'> | null;
    otherCaption: string;
}) {
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
 * What swapping an entry out puts at risk: the entry is boosted or turbo'd (its boost/turbo stays with the
 * photo, so the replacement won't get it), and the feature it is live-pinned for (the pin would be left with
 * no photo). Shown in both confirm modals of a swap.
 */
export type SwapWarnings = { actioned: boolean; pinned: EntryPinKind | null };

/**
 * The warning lines of a swap's confirm modal.
 */
export function SwapWarningLines({ actioned, pinned }: SwapWarnings) {
    const { t } = useTranslation();
    return (
        <>
            {actioned && <ToneNote tone="warning">{t('app.currencySwapBoostedWarning')}</ToneNote>}
            {pinned && (
                <ToneNote tone="warning">
                    {interp(t('app.pinSwapWarning'), { kind: t(pinned === 'boost' ? 'app.boost' : 'app.turbo') })}
                </ToneNote>
            )}
        </>
    );
}

/**
 * Opens the card's swap picker for one entry (ChallengeCardActions' useSwapPickModal): the user picks the
 * replacement from the library. `returnFocusEl` is where focus goes when the flow ends; `notice` says why the
 * picker opened.
 */
export type OpenSwapPick = (
    entry: RankingEntry,
    warnings: SwapWarnings,
    returnFocusEl: HTMLElement | null,
    notice?: string | null,
) => void;

/**
 * Per-entry Swap button, with a "Pick…" button beside it that opens the card's swap picker straight away.
 * Swap click → the app suggests a replacement (spends
 * nothing; the button spins meanwhile) → confirm modal shows current vs
 * replacement → Spend swaps exactly that suggestion. The modal's "Choose
 * another photo…" hands over to the card's swap picker (`onChoose`), which owns
 * the rest of a chosen swap; so does a suggestion that can't be made (no
 * different photo), which opens the picker with that reason instead of an error.
 *
 * @param props.entry - entry record (id, member_id)
 * @param props.warnActioned - the entry is boosted or turbo'd (its boost/turbo stays with the photo, so the replacement won't get it)
 * @param props.warnPinned - the feature the entry is live-pinned for (the pin would be left with no photo)
 * @param props.onSpent - called after a successful swap
 * @param props.onChoose - opens the card's swap picker for this entry
 */
export function SwapEntryButton({
    entry,
    challengeId,
    bankroll,
    warnActioned,
    warnPinned = null,
    onSpent,
    onChoose,
}: {
    entry: RankingEntry;
    warnActioned: boolean;
    warnPinned?: EntryPinKind | null;
    challengeId: Challenge['id'];
    bankroll: Bankroll | null;
    onSpent: () => void;
    onChoose: OpenSwapPick;
}) {
    const { t } = useTranslation();
    const { preview, commit } = useSwapPhoto();
    const [candidate, setCandidate] = useState<SwapCandidate | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const pickRef = useRef<HTMLButtonElement>(null);
    const pickHintId = useId();
    const error = preview.error || commit.error;

    const warnings = { actioned: warnActioned, pinned: warnPinned };

    const dismissError = () => {
        preview.clearError();
        commit.clearError();
    };

    const handlePreview = async () => {
        commit.clearError();
        const result = await preview.run(challengeId, entry.id);
        if (result?.success && result.candidate) setCandidate(result.candidate);
        else if (!result?.success && result?.error === CURRENCY_OUTCOME.noAlternative) {
            // No suggestion to offer: the picker opens and says why, instead of an error under the button.
            preview.clearError();
            onChoose(entry, warnings, triggerRef.current, t('app.swapPickNoSuggestion'));
        }
    };

    const handlePick = () => {
        dismissError();
        onChoose(entry, warnings, pickRef.current);
    };

    const handleChoose = () => {
        setCandidate(null);
        dismissError();
        onChoose(entry, warnings, triggerRef.current);
    };

    const handleConfirm = async () => {
        // Only reachable from the confirm modal, which is open only while a candidate is held.
        const result = await commit.run(challengeId, entry.id, (candidate as SwapCandidate).id);
        setCandidate(null);
        // A photo that is entered already is refused with nothing spent; the card still offers it until refreshed.
        if (spentOrStale(result) || alreadyEntered(result)) onSpent();
    };

    return (
        <>
            <SwapTrigger
                variant="cost"
                label={`🔄 ${t('app.currencySwap')}`}
                busy={preview.loading || commit.loading}
                error={error}
                buttonRef={triggerRef}
                onClick={handlePreview}
                onDismiss={dismissError}
            >
                {/* "Pick…" alone does not say what it does; the sentence is its description (a title is lost on touch). */}
                <button
                    ref={pickRef}
                    type="button"
                    className="btn btn-sm btn-outline"
                    title={t('app.swapPickLabel')}
                    aria-describedby={pickHintId}
                    disabled={preview.loading || commit.loading}
                    onClick={handlePick}
                >
                    {`🔄 ${t('app.swapPick')}`}
                </button>
                <span id={pickHintId} className="sr-only">
                    {t('app.swapPickLabel')}
                </span>
            </SwapTrigger>
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
                <SwapWarningLines {...warnings} />
                <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    disabled={commit.loading}
                    onClick={handleChoose}
                >
                    {t('app.currencySwapChoose')}
                </button>
            </SwapConfirmModal>
        </>
    );
}

/**
 * Per-entry "Swap back" button, shown on the photo that replaced one swapped
 * out while boosted/turbo'd: spends a SWAP to put the original back, which
 * restores its boost/turbo. The original comes from the main-side ledger.
 *
 * @param props.entry - the entry now in the slot
 */
export function SwapBackButton({
    entry,
    swapBack,
    challengeId,
    bankroll,
    onSpent,
}: {
    entry: RankingEntry;
    /** The boosted/turbo'd original to put back. */
    swapBack: Pick<SwapBackOffer, 'previousId' | 'previousMemberId' | 'kind'>;
    challengeId: Challenge['id'];
    bankroll: Bankroll | null;
    onSpent: () => void;
}) {
    const { t } = useTranslation();
    const { run, loading, error, clearError } = useSwapBack();
    const [confirmOpen, setConfirmOpen] = useState(false);

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
                variant="cost"
                label={`↩️ ${t('app.currencySwapBack')}`}
                busy={loading}
                error={error}
                onClick={() => setConfirmOpen(true)}
                onDismiss={clearError}
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
