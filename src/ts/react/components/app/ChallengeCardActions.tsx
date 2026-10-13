import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useTurbo } from '@/api/useTurbo';
import { useFillChallenge } from '@/api/useFillChallenge';
import { useSubmitPicked } from '@/api/useSubmitPicked';
import { ipcErrorText } from '@/api/ipcErrorText';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';
import { ActionButton } from '@/components/ui/ActionButton';
import { InlineError } from '@/components/ui/InlineError';
import { BusyContent } from '@/components/ui/LoadingSpinner';

import { VoteButton } from './VoteButton';
import { RunButton } from './RunButton';
import { CurrencyCellButton } from './CurrencyActionButton';
import { PhotoSubmitModal } from './PhotoSubmitModal';

import type { Bankroll, Challenge } from '../../../types/gurushots';
import type { ChallengeCardView } from './ChallengeCard';
import type { PickOutcome } from './PhotoSubmitModal';

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
            variant="info"
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

/**
 * "+1" / "+N" submit buttons and "Pick…" (detailed entries cell, compact action
 * row). "+N" only appears when more than one slot is open. `icon` prefixes the
 * "+1" / "+N" labels where the entries cell isn't there to say what they add.
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
    return (
        <>
            <ActionButton
                variant="info"
                error={fillError}
                onClick={() => void onFill('one')}
                disabled={filling || picking}
                aria-busy={filling}
            >
                <BusyContent busy={filling} label="+1">
                    {`${icon}+1`}
                </BusyContent>
            </ActionButton>
            {slotsRemaining > 1 && (
                <button
                    className="btn btn-sm btn-warning"
                    onClick={() => void onFill('all')}
                    disabled={filling || picking}
                    aria-busy={filling}
                >
                    <BusyContent busy={filling} label={`+${slotsRemaining}`}>
                        {`${icon}+${slotsRemaining}`}
                    </BusyContent>
                </button>
            )}
            <button
                className="btn btn-sm btn-outline"
                title={t('app.fillPickLabel')}
                onClick={onPick}
                disabled={filling || picking}
            >
                {t('app.fillPick')}
            </button>
        </>
    );
}

/**
 * Per-challenge settings button (detailed header, compact action row).
 */
function SettingsButton({ onClick, label }: { onClick: () => void; label: string }) {
    return (
        <button className="btn btn-outline btn-sm" onClick={onClick}>
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
        if (result?.error === 'invalid-args' || result?.error === 'not-logged-in') return 'failed';
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
                onSubmit={submit}
            />
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
 * cannot unmount it or lose a submit's answer).
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

    const turboError = ipcErrorText(turboFailure, t);
    const fillError = ipcErrorText(fillFailure, t);

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
        clearTurboError,
        clearFillError,
        voteButton: view.showVoteButton && (
            <VoteButton challengeId={challenge.id} challengeTitle={challenge.title} onVoteComplete={onVoteComplete} />
        ),
        runButton: view.showRunButton && <RunButton challengeId={challenge.id} onVoteComplete={onVoteComplete} />,
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
                {actions.turboError && (
                    <InlineError onDismiss={actions.clearTurboError}>{actions.turboError}</InlineError>
                )}
                {actions.fillError && <InlineError onDismiss={actions.clearFillError}>{actions.fillError}</InlineError>}
            </div>
        )
    );
}
