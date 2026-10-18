import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useTurbo } from '@/api/useTurbo';
import { useFillChallenge } from '@/api/useFillChallenge';
import { useSubmitPicked } from '@/api/useSubmitPicked';
import { useSwapPhoto } from '@/api/useCurrencyActions';
import { alreadyEntered, spentOrStale } from '@/utils/spentOrStale';
import { ipcErrorText } from '@/api/ipcErrorText';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';
import { ActionButton } from '@/components/ui/ActionButton';
import { InlineError } from '@/components/ui/InlineError';
import { BusyContent } from '@/components/ui/LoadingSpinner';

import { VoteButton } from './VoteButton';
import { RunButton } from './RunButton';
import { CurrencyCellButton } from './CurrencyActionButton';
import { PhotoSubmitModal, PICK_TEXTS } from './PhotoSubmitModal';
import { currencyOutcomeText } from './CurrencyConfirmModal';
import { SwapConfirmModal, SwapWarningLines } from './SwapEntryButton';
import { CURRENCY_OUTCOME, swapExcludedIds } from '../../../voting/currencyActions';

import type { Bankroll, Challenge, RankingEntry } from '../../../types/gurushots';
import type { SwapCandidate } from '../../../services/currencyActions';
import type { ChallengeCardView } from './ChallengeCard';
import type { PickOutcome } from './PhotoSubmitModal';
import type { OpenSwapPick, SwapWarnings } from './SwapEntryButton';

/**
 * The challenge-level action elements and fill-button props one card shares
 * between its layouts.
 */
export type ChallengeCardActionSet = ReturnType<typeof useChallengeCardActions>;

/**
 * "Earn turbo" mini-game button (detailed turbo cell, compact action row).
 * Locked while a play is in flight.
 */
function EarnTurboButton({
    turboError,
    playingTurbo,
    onPlay,
    label,
}: {
    turboError: string | null;
    playingTurbo: boolean;
    onPlay: () => Promise<void>;
    label: string;
}) {
    return (
        <ActionButton
            variant="neutral"
            error={turboError}
            className="mt-1"
            onClick={() => void onPlay()}
            disabled={playingTurbo}
            aria-busy={playingTurbo}
        >
            <BusyContent busy={playingTurbo} label={label}>
                🎯 {label}
            </BusyContent>
        </ActionButton>
    );
}

/** A button's decorative prefix, kept out of its accessible name. */
const Icon = ({ icon }: { icon: string }) => (icon ? <span aria-hidden="true">{icon}</span> : null);

/**
 * "+1" / "+N" submit buttons and "Pick…" (detailed entries cell, compact action
 * row). "+N" only appears when more than one slot is open. `icon` prefixes the
 * labels where the entries cell isn't there to say what they add.
 * A running fill or pick-submit (`picking`) disables all of them.
 */
export function FillButtons({
    fillError,
    filling,
    picking,
    slotsRemaining,
    onFill,
    onPick,
    icon = '',
}: {
    fillError: string | null;
    filling: boolean;
    picking: boolean;
    slotsRemaining: number;
    onFill: (mode: 'one' | 'all') => Promise<void>;
    onPick: () => void;
    icon?: string;
}) {
    const { t } = useTranslation();
    const pickHintId = useId();
    return (
        <>
            <ActionButton
                variant="neutral"
                error={fillError}
                onClick={() => void onFill('one')}
                disabled={filling || picking}
                aria-busy={filling}
            >
                <BusyContent busy={filling} label="+1">
                    <Icon icon={icon} />
                    +1
                </BusyContent>
            </ActionButton>
            {slotsRemaining > 1 && (
                <button
                    className="btn btn-sm btn-neutral"
                    onClick={() => void onFill('all')}
                    disabled={filling || picking}
                    aria-busy={filling}
                >
                    <BusyContent busy={filling} label={`+${slotsRemaining}`}>
                        <Icon icon={icon} />+{slotsRemaining}
                    </BusyContent>
                </button>
            )}
            {/* "Pick…" alone does not say what it does; the sentence is its description (a title is lost on touch). */}
            <button
                className="btn btn-sm btn-outline"
                title={t('app.fillPickLabel')}
                aria-describedby={pickHintId}
                onClick={onPick}
                disabled={filling || picking}
            >
                <Icon icon={icon} />
                {t('app.fillPick')}
            </button>
            <span id={pickHintId} className="sr-only">
                {t('app.fillPickLabel')}
            </span>
        </>
    );
}

/**
 * Per-challenge settings button (detailed header, compact action row).
 */
function SettingsButton({ onClick, label }: { onClick: () => void; label: string }) {
    return (
        <button className="btn btn-ghost btn-sm" onClick={onClick}>
            <StrokeIcon d={ICON_PATHS.cog} className="w-4 h-4 mr-1" />
            {label}
        </button>
    );
}

/**
 * The Pick… picker's state: whether it is open, the submit call, and the modal element itself. A failure
 * before anything was sent changes nothing; any other leaves the card stale, so the card refreshes.
 */
function usePickModal({
    challenge,
    slotsRemaining,
    onVoteComplete,
}: {
    challenge: Challenge;
    slotsRemaining: number;
    onVoteComplete: () => void;
}) {
    const { t } = useTranslation();
    const { submitPicked, loading: picking, error: failure, clearError } = useSubmitPicked();
    const [isOpen, setOpen] = useState(false);

    const submit = async (imageIds: string[]): Promise<PickOutcome> => {
        const result = await submitPicked(challenge.id, imageIds);
        if (result?.success) {
            setOpen(false);
            onVoteComplete();
            return 'done';
        }
        // Answered before anything was sent: bad arguments, no login, or another submit already running.
        if (
            result?.error === 'invalid-args' ||
            result?.error === 'No authentication token found' ||
            result?.error === 'submit-busy'
        ) {
            return 'failed';
        }
        onVoteComplete();
        return 'refreshed';
    };

    const close = () => {
        clearError();
        setOpen(false);
    };

    return {
        picking,
        open: () => setOpen(true),
        modal: (
            <PhotoSubmitModal
                isOpen={isOpen}
                onClose={close}
                challengeId={challenge.id}
                max={slotsRemaining}
                submitting={picking}
                error={ipcErrorText(failure, t)}
                suggest
                onSubmit={submit}
            />
        ),
    };
}

// What the swap picker says: the Pick… submit's lines, with the ones about slots and submitting made to fit
// choosing the one photo that takes an entry's place (overCap, full and noSlots can't be reached with one).
const SWAP_PICK_TEXTS = {
    ...PICK_TEXTS,
    title: 'app.swapPickTitle',
    help: 'app.swapPickHelp',
    count: 'app.swapPickCount',
    submit: 'app.swapPickSubmit',
    submitCount: 'app.swapPickSubmit',
};

/**
 * One chosen swap in progress: the entry being replaced, then the picker (no `candidate`) and the confirm
 * modal for the photo picked (`candidate`). `returnFocusEl` is the Swap button that started it. `held` is the
 * outcome that keeps the confirm open with Spend off: the spend may have landed (`unclear`) or cannot (`no-balance`).
 */
type SwapPickFlow = {
    entry: RankingEntry;
    warnings: SwapWarnings;
    notice: string | null;
    returnFocusEl: HTMLElement | null;
    candidate: SwapCandidate | null;
    held: typeof CURRENCY_OUTCOME.unclear | typeof CURRENCY_OUTCOME.noBalance | null;
};

/**
 * The chosen swap's state: the library picker for the photo that takes an entry's place, then the confirm
 * modal for that photo. Owned by the card (not by the entry's Swap button, which a refresh can unmount), so
 * a long library browse or a preview in flight survives it. It has its own swap actions, so its errors never
 * mix with the button's inline one. Like Pick…, nothing is ranked: the photo is sent as chosen and the server
 * has the final say on whether the challenge accepts it.
 */
function useSwapPickModal({
    challenge,
    bankroll,
    onCurrencySpent,
}: {
    challenge: Challenge;
    bankroll: Bankroll | null;
    onCurrencySpent?: () => void;
}) {
    const { t } = useTranslation();
    const { preview, commit } = useSwapPhoto();
    const [flow, setFlow] = useState<SwapPickFlow | null>(null);
    const returnFocusRef = useRef<HTMLElement | null>(null);
    // The listing does not say which photos are entered, so the picker blocks them itself.
    const entered = useMemo(() => swapExcludedIds(challenge), [challenge]);

    // The button that started the flow is focused once the flow's modals have gone: their own focus return
    // would land on the "Choose another photo…" button, which has unmounted by then.
    useEffect(() => {
        if (flow !== null) return;
        returnFocusRef.current?.focus();
        returnFocusRef.current = null;
    }, [flow]);

    const open: OpenSwapPick = (entry, warnings, returnFocusEl, notice = null) => {
        preview.clearError();
        commit.clearError();
        setFlow({ entry, warnings, notice, returnFocusEl, candidate: null, held: null });
    };

    const end = (current: SwapPickFlow) => {
        returnFocusRef.current = current.returnFocusEl;
        preview.clearError();
        commit.clearError();
        setFlow(null);
    };

    const endAndRefresh = (current: SwapPickFlow) => {
        end(current);
        onCurrencySpent?.();
    };

    // Closing a held confirm refreshes the card too: an unclear spend may have landed.
    const close = (current: SwapPickFlow) => {
        if (current.held) endAndRefresh(current);
        else end(current);
    };

    // A refusal leaves the picker open (its alert says why); a preview that went through moves on to the confirm.
    // "Not available" means the entry being replaced is no longer entered (or the challenge changed), and
    // "already entered" that the photo picked is: the picker stays open so its alert says so, and the card
    // refreshes behind it (the picker is card-level, so the refresh does not unmount it), which stops the
    // photo being offered again; the user closes it or picks another.
    const pick =
        (current: SwapPickFlow) =>
        async (imageIds: string[]): Promise<PickOutcome> => {
            commit.clearError();
            const result = await preview.run(challenge.id, current.entry.id, imageIds[0]);
            if (!result?.success) {
                if (
                    result?.error === CURRENCY_OUTCOME.notAvailable ||
                    result?.error === CURRENCY_OUTCOME.alreadyEntered
                ) {
                    onCurrencySpent?.();
                }
                return 'failed';
            }
            if (!result.candidate) return 'failed';
            setFlow({ ...current, candidate: result.candidate });
            return 'done';
        };

    // The spend consumes the preview whatever it comes to, so a spend that went through or found the card stale
    // ends the flow and refreshes the card. An `unclear` answer (the spend may have landed) or `no-balance` keeps
    // the confirm open with Spend off, so the swap is not sent again; closing it refreshes. Any other failure
    // goes back to the picker, whose alert gives the reason, for a new pick (and a new preview).
    const confirm = async (current: SwapPickFlow, candidate: SwapCandidate) => {
        const result = await commit.run(challenge.id, current.entry.id, candidate.id);
        const outcome = result.success ? null : result.error;
        if (spentOrStale(result)) {
            endAndRefresh(current);
            return;
        }
        // Refused for a photo that is entered already: nothing was spent, the picker reopens, and the card refreshes.
        if (alreadyEntered(result)) onCurrencySpent?.();
        const held = outcome === CURRENCY_OUTCOME.unclear || outcome === CURRENCY_OUTCOME.noBalance ? outcome : null;
        setFlow({ ...current, candidate: held ? candidate : null, held });
    };

    // A refused pick and a refused spend are told in the picker, which a refused spend reopens; a refused spend
    // that is held (`unclear`, `no-balance`) is told in the confirm instead.
    const pickError = preview.error || commit.error;
    const candidate = flow?.candidate ?? null;

    return {
        open,
        modal: flow && (
            <>
                <PhotoSubmitModal
                    isOpen={candidate === null}
                    onClose={() => close(flow)}
                    challengeId={challenge.id}
                    max={1}
                    submitting={preview.loading}
                    error={pickError && currencyOutcomeText(t, pickError)}
                    texts={SWAP_PICK_TEXTS}
                    notice={flow.notice}
                    blocked={{ ids: entered, reasonKey: 'app.swapPickBlocked' }}
                    onSubmit={pick(flow)}
                />
                {candidate && (
                    <SwapConfirmModal
                        isOpen
                        onClose={() => close(flow)}
                        onConfirm={() => confirm(flow, candidate)}
                        title={t('app.currencySwapTitle')}
                        bankroll={bankroll}
                        spending={commit.loading}
                        spendHeld={flow.held !== null}
                        current={flow.entry}
                        other={candidate}
                        otherCaption={t('app.currencySwapYourPick')}
                    >
                        <p>{t('app.currencySwapChosenBody')}</p>
                        <SwapWarningLines {...flow.warnings} />
                        {flow.held && (
                            <div role="alert" className="alert alert-error py-2 text-sm">
                                {currencyOutcomeText(t, flow.held)}
                            </div>
                        )}
                    </SwapConfirmModal>
                )}
            </>
        ),
    };
}

/**
 * Challenge-level action elements, shared by the detailed card's header and
 * cells and the compact tile's action row, so both offer the same actions
 * under the same gates. Each element is `false` when the action isn't offered
 * right now. Also owns the turbo-play / photo-submit calls and their
 * auto-clearing inline errors, and the Pick… modal (`pickModal`, rendered once
 * by the card, outside both layouts and the submit buttons' gate, so a refresh
 * cannot unmount it or lose a submit's answer) and the chosen swap's picker and confirm
 * (`swapPickModal`, rendered the same way; `openSwapPick` starts it from an entry's Swap button).
 */
export function useChallengeCardActions({
    challenge,
    view,
    bankroll,
    onVoteComplete,
    onSettingsClick,
    onCurrencySpent,
}: {
    challenge: Challenge;
    view: ChallengeCardView;
    bankroll: Bankroll | null;
    onVoteComplete: () => void;
    onSettingsClick: (challengeId: Challenge['id'], challengeTitle: string) => void;
    onCurrencySpent?: () => void;
}) {
    const { t } = useTranslation();
    const { playAutoTurbo, loading: playingTurbo, error: turboFailure, clearError: clearTurboError } = useTurbo();
    const { fillNow, loading: filling, error: fillFailure, clearError: clearFillError } = useFillChallenge();

    const pick = usePickModal({ challenge, slotsRemaining: view.slotsRemaining, onVoteComplete });
    const swapPick = useSwapPickModal({ challenge, bankroll, onCurrencySpent });

    const turboError = ipcErrorText(turboFailure, t);
    const fillError = ipcErrorText(fillFailure, t);
    // Vote and Run share it: the translated message of whichever failed last, cleared by the next press.
    const [pressError, setPressError] = useState<string | null>(null);
    const clearPressError = () => setPressError(null);

    const handlePlayAutoTurbo = async () => {
        const result = await playAutoTurbo(challenge.id, challenge.title);
        if (result?.success) onVoteComplete();
    };

    const handleFill = async (mode: 'one' | 'all') => {
        const result = await fillNow(challenge.id, mode);
        if (result?.success) onVoteComplete();
    };

    return {
        turboError,
        fillError,
        pressError,
        clearTurboError,
        clearFillError,
        clearPressError,
        voteButton: view.showVoteButton && (
            <VoteButton
                challengeId={challenge.id}
                challengeTitle={challenge.title}
                onVoteComplete={onVoteComplete}
                onError={setPressError}
            />
        ),
        runButton: view.showRunButton && (
            <RunButton challengeId={challenge.id} onVoteComplete={onVoteComplete} onError={setPressError} />
        ),
        settingsButton: challenge.type !== 'flash' && (
            <SettingsButton onClick={() => onSettingsClick(challenge.id, challenge.title)} label={t('app.settings')} />
        ),
        earnTurboButton: view.canPlayAutoTurbo && (
            <EarnTurboButton
                turboError={turboError}
                playingTurbo={playingTurbo}
                onPlay={handlePlayAutoTurbo}
                label={t('app.earnTurbo')}
            />
        ),
        fillExposureButton: view.showFillExposure && (
            <CurrencyCellButton kind="fill" challenge={challenge} bankroll={bankroll} onSpent={onCurrencySpent} />
        ),
        keyUnlockButton: view.showKeyUnlock && (
            <CurrencyCellButton kind="key" challenge={challenge} bankroll={bankroll} onSpent={onCurrencySpent} />
        ),
        fillButtonProps: {
            fillError,
            filling,
            picking: pick.picking,
            slotsRemaining: view.slotsRemaining,
            onFill: handleFill,
            onPick: pick.open,
        },
        pickModal: pick.modal,
        openSwapPick: swapPick.open,
        swapPickModal: swapPick.modal,
    };
}

/**
 * The compact tile's optional footer row of challenge-level actions. `false`
 * when the compactCardActions setting is off or nothing is offered right now.
 * [&>.btn]:mt-0 drops the top margin the cell-placed buttons carry.
 */
export function buildCompactActionRow({
    actions,
    canFill,
    enabled,
}: {
    actions: ChallengeCardActionSet;
    canFill: boolean;
    enabled: boolean;
}) {
    const { voteButton, runButton, earnTurboButton, fillExposureButton, keyUnlockButton, settingsButton } = actions;
    const hasActions =
        voteButton ||
        runButton ||
        earnTurboButton ||
        canFill ||
        fillExposureButton ||
        keyUnlockButton ||
        settingsButton;
    return (
        enabled &&
        hasActions && (
            <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-1 [&>.btn]:mt-0">
                    {voteButton}
                    {runButton}
                    {earnTurboButton}
                    {canFill && <FillButtons {...actions.fillButtonProps} icon="🖼 " />}
                    {fillExposureButton}
                    {keyUnlockButton}
                    {settingsButton}
                </div>
                {actions.pressError && (
                    <InlineError onDismiss={actions.clearPressError}>{actions.pressError}</InlineError>
                )}
                {actions.turboError && (
                    <InlineError onDismiss={actions.clearTurboError}>{actions.turboError}</InlineError>
                )}
                {actions.fillError && <InlineError onDismiss={actions.clearFillError}>{actions.fillError}</InlineError>}
            </div>
        )
    );
}
