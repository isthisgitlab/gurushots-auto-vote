import { useTranslation } from '@/contexts/TranslationContext';
import { useTurbo } from '@/api/useTurbo';
import { useFillChallenge } from '@/api/useFillChallenge';
import { useAutoClear } from '@/hooks/useAutoClear';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';
import { VoteButton } from './VoteButton';
import { RunButton } from './RunButton';
import { CurrencyCellButton } from './CurrencyActionButton';

const TURBO_ERROR_DISPLAY_MS = 5000;
const FILL_ERROR_DISPLAY_MS = 5000;

/**
 * "Earn turbo" mini-game button (detailed turbo cell, compact action row).
 * Locked while a play is in flight or the autovote loop (which plays turbo
 * itself) is running.
 */
function EarnTurboButton({ turboError, playingTurbo, disabled, onPlay, label }) {
    return (
        <button
            className={`btn btn-xs mt-1 ${turboError ? 'btn-error' : 'btn-info'}`}
            onClick={onPlay}
            disabled={disabled}
        >
            {playingTurbo ? <span className="loading loading-spinner loading-xs" /> : <>🎯 {label}</>}
        </button>
    );
}

/**
 * "+1" / "+N" submit buttons (detailed entries cell, compact action row). "+N"
 * only appears when more than one slot is open. `icon` prefixes both labels
 * where the entries cell isn't there to say what they add.
 */
export function FillButtons({ fillError, filling, slotsRemaining, onFill, icon = '' }) {
    const disabled = filling;
    const spinner = <span className="loading loading-spinner loading-xs" />;
    return (
        <>
            <button
                className={`btn btn-xs ${fillError ? 'btn-error' : 'btn-info'}`}
                onClick={() => onFill('one')}
                disabled={disabled}
            >
                {filling ? spinner : `${icon}+1`}
            </button>
            {slotsRemaining > 1 && (
                <button className="btn btn-xs btn-warning" onClick={() => onFill('all')} disabled={disabled}>
                    {filling ? spinner : `${icon}+${slotsRemaining}`}
                </button>
            )}
        </>
    );
}

/**
 * Per-challenge settings button (detailed header, compact action row).
 */
function SettingsButton({ onClick, label }) {
    return (
        <button className="btn btn-ghost btn-xs px-1" onClick={onClick}>
            <StrokeIcon d={ICON_PATHS.cog} className="w-3 h-3 mr-1" />
            {label}
        </button>
    );
}

/**
 * Challenge-level action elements, shared by the detailed card's header and
 * cells and the compact tile's action row, so both offer the same actions
 * under the same gates. Each element is `false` when the action isn't offered
 * right now. Also owns the turbo-play / photo-submit calls and their
 * auto-clearing inline errors.
 *
 * @param {object} args
 * @param {object} args.challenge
 * @param {ReturnType<typeof import('@/utils/challengeCardView').deriveChallengeCardView>} args.view
 * @param {object|null} args.bankroll
 * @param {boolean} args.autovoteRunning
 * @param {Function} args.onVoteComplete
 * @param {Function} args.onSettingsClick
 * @param {Function} [args.onCurrencySpent]
 */
export function useChallengeCardActions({
    challenge,
    view,
    bankroll,
    autovoteRunning,
    onVoteComplete,
    onSettingsClick,
    onCurrencySpent,
}) {
    const { t } = useTranslation();
    const { playAutoTurbo, loading: playingTurbo, error: turboError, clearError: clearTurboError } = useTurbo();
    const { fillNow, loading: filling, error: fillError, clearError: clearFillError } = useFillChallenge();

    useAutoClear(turboError, clearTurboError, TURBO_ERROR_DISPLAY_MS);
    useAutoClear(fillError, clearFillError, FILL_ERROR_DISPLAY_MS);

    const handlePlayAutoTurbo = async () => {
        const result = await playAutoTurbo(challenge.id, challenge.title);
        if (result?.success) onVoteComplete();
    };

    const handleFill = async (mode) => {
        const result = await fillNow(challenge.id, mode);
        if (result?.success) onVoteComplete();
    };

    return {
        turboError,
        fillError,
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
                disabled={playingTurbo || autovoteRunning}
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
            slotsRemaining: view.slotsRemaining,
            onFill: handleFill,
        },
    };
}

/**
 * The compact tile's optional footer row of challenge-level actions. `false`
 * when the compactCardActions setting is off or nothing is offered right now.
 * [&>.btn]:mt-0 drops the top margin the cell-placed buttons carry.
 *
 * @param {{ actions: ReturnType<typeof useChallengeCardActions>, canFill: boolean, enabled: boolean }} props
 */
export function buildCompactActionRow({ actions, canFill, enabled }) {
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
                {actions.turboError && <div className="text-error text-xs">{actions.turboError}</div>}
                {actions.fillError && <div className="text-error text-xs">{actions.fillError}</div>}
            </div>
        )
    );
}
