import type { Bankroll, Challenge, RankingEntry } from '../../../types/gurushots';
import type { EntryPinKind, EntryPins } from '../../../types/settings';
import type { SwapBackOffer } from '@/api/useSwapBacks';
import { useTranslation } from '@/contexts/TranslationContext';
import { useBoost } from '@/api/useBoost';
import { ipcErrorText } from '@/api/ipcErrorText';
import { useTurbo } from '@/api/useTurbo';
import { getEntryStatus } from '@/utils/formatters';
import { ActionButton } from '@/components/ui/ActionButton';
import { InlineError } from '@/components/ui/InlineError';
import { BusyContent } from '@/components/ui/LoadingSpinner';

import { EntryPhoto } from './EntryPhoto';
import { SwapEntryButton, SwapBackButton } from './SwapEntryButton';

/**
 * What an entry badge needs to pin its photo for Boost or Turbo.
 *
 * @property pins - the challenge's stored pins
 * @property canPin - per feature, whether it can still fire (a toggle for a spent feature stays hidden)
 * @property livePin - the feature this entry is live-pinned for (the Swap warning names it)
 * @property onToggle - pin this entry, or clear the pin when it already holds it
 */
export type EntryPinControls = {
    pins: EntryPins;
    canPin: Record<EntryPinKind, boolean>;
    livePin: EntryPinKind | null;
    onToggle: (kind: EntryPinKind, imageId: string) => void | Promise<void>;
};

/**
 * One "Pin for Boost / Turbo" toggle: a fixed name, with `aria-pressed` carrying the state.
 */
function PinToggle({
    kind,
    pressed,
    onToggle,
}: {
    kind: EntryPinKind;
    pressed: boolean;
    onToggle: () => void | Promise<void>;
}) {
    const { t } = useTranslation();
    return (
        <ActionButton
            variant={kind === 'boost' ? 'success' : 'warning'}
            className={pressed ? '' : 'btn-outline'}
            aria-pressed={pressed}
            onClick={() => void onToggle()}
        >
            <span aria-hidden="true">📌</span> {t(kind === 'boost' ? 'app.pinForBoost' : 'app.pinForTurbo')}
        </ActionButton>
    );
}

/**
 * The pin toggles of one entry, grouped apart from the spend buttons by the same 8px step as Swap. A toggle shows
 * while its feature can still fire, and not on a photo that carries the other feature.
 */
function PinToggles({
    entry,
    pin,
    carriesBoost,
    carriesTurbo,
}: {
    entry: RankingEntry;
    pin: EntryPinControls;
    carriesBoost: boolean;
    carriesTurbo: boolean;
}) {
    const imageId = String(entry.id);
    const showBoost = pin.canPin.boost && !carriesTurbo;
    const showTurbo = pin.canPin.turbo && !carriesBoost;
    if (!showBoost && !showTurbo) return null;
    return (
        <span className="ml-2 inline-flex flex-wrap items-center gap-2">
            {showBoost && (
                <PinToggle
                    kind="boost"
                    pressed={pin.pins.boost === imageId}
                    onToggle={() => pin.onToggle('boost', imageId)}
                />
            )}
            {showTurbo && (
                <PinToggle
                    kind="turbo"
                    pressed={pin.pins.turbo === imageId}
                    onToggle={() => pin.onToggle('turbo', imageId)}
                />
            )}
        </span>
    );
}

/**
 * Entry badge component showing entry details and per-entry action buttons.
 *
 * @param props.entry     - Entry record from challenge.member.ranking.entries
 * @param props.boostAvailable - Boost is currently usable on the parent challenge
 * @param props.turboAvailable - A won Turbo is held and unapplied
 * @param props.onBoostApplied - called after a successful boost
 * @param props.onTurboApplied - called after a successful turbo
 * @param props.swapAvailable - A swap can be spent on this challenge (balance + challenge flags)
 * @param props.bankroll - For the swap confirm modal's balance line
 * @param props.onSwapped - called after a swap / swap back spent
 * @param props.swapBack - Swap-back offer for this slot (the original was swapped out while boosted/turbo'd)
 * @param props.pin - the pin toggles (absent = none shown)
 */
export function EntryBadge({
    entry,
    challengeId,
    boostAvailable,
    turboAvailable,
    onBoostApplied,
    onTurboApplied,
    swapAvailable = false,
    bankroll = null,
    onSwapped,
    swapBack = null,
    pin,
}: {
    entry: RankingEntry;
    challengeId: Challenge['id'];
    boostAvailable: boolean;
    turboAvailable?: boolean;
    onBoostApplied: () => void;
    onTurboApplied: () => void;
    swapAvailable?: boolean;
    bankroll?: Bankroll | null;
    onSwapped: () => void;
    swapBack?: SwapBackOffer | null;
    pin?: EntryPinControls;
}) {
    const { t } = useTranslation();
    const { applyBoost, loading: boosting, error: boostError, clearError: clearBoostError } = useBoost();
    const { applyTurbo, loading: turboing, error: turboError, clearError: clearTurboError } = useTurbo();

    // Shared with the compact card's glyph row so both read one mapping.
    const {
        isBoosted: isEntryBoosted,
        isTurboed: isEntryTurboed,
        className: entryTypeClass,
        icon,
    } = getEntryStatus(entry);
    // Boost and turbo are mutually exclusive on a single entry —
    // applying one locks out the other on the same photo. Hide both
    // buttons whenever the entry is already in either state.
    const isEntryActioned = isEntryBoosted || isEntryTurboed;
    const showBoostButton = boostAvailable && !isEntryActioned;
    const showTurboButton = turboAvailable && !isEntryActioned;

    // A failed action's message stays until it is dismissed or the next action starts (each run clears the
    // previous error), so it can be read; the red button is still a retry.
    const dismissError = () => {
        clearBoostError();
        clearTurboError();
    };

    const handleBoost = async () => {
        const result = await applyBoost(challengeId, entry.id);
        if (result?.success) onBoostApplied();
    };

    const handleTurbo = async () => {
        const result = await applyTurbo(challengeId, entry.id);
        if (result?.success) onTurboApplied();
    };

    return (
        // h-auto + py-1: a stock DaisyUI badge is ~20px tall, which would clip
        // the thumbnail. Growing the badge keeps the chip, the text and the
        // action buttons on one baseline.
        <div className={`badge badge-outline badge-sm ${entryTypeClass} flex h-auto items-center gap-1 py-1`}>
            <EntryPhoto entry={entry} />
            <span>{icon}</span>
            <span>
                {t('app.rank')} {entry.rank} ({entry.votes} {t('app.votes')})
            </span>
            {showBoostButton && (
                <ActionButton
                    variant="success"
                    error={boostError}
                    className="ml-1"
                    onClick={() => void handleBoost()}
                    disabled={boosting}
                    aria-busy={boosting}
                >
                    <BusyContent busy={boosting} label={t('app.boost')}>
                        {`🚀 ${t('app.boost')}`}
                    </BusyContent>
                </ActionButton>
            )}
            {showTurboButton && (
                <ActionButton
                    variant="warning"
                    error={turboError}
                    className="ml-1"
                    onClick={() => void handleTurbo()}
                    disabled={turboing}
                    aria-busy={turboing}
                >
                    <BusyContent busy={turboing} label={t('app.turbo')}>
                        {`⚡ ${t('app.turbo')}`}
                    </BusyContent>
                </ActionButton>
            )}
            {pin && <PinToggles entry={entry} pin={pin} carriesBoost={isEntryBoosted} carriesTurbo={isEntryTurboed} />}
            {swapAvailable && (
                // ml-2 + gap: keep Swap an 8px step away from Boost/Turbo so
                // adjacent touch targets aren't flush on Android.
                <span className="ml-2 inline-flex items-center gap-2">
                    <SwapEntryButton
                        entry={entry}
                        challengeId={challengeId}
                        bankroll={bankroll}
                        warnActioned={isEntryActioned}
                        warnPinned={pin?.livePin ?? null}
                        onSpent={onSwapped}
                    />
                    {swapBack && (
                        <SwapBackButton
                            entry={entry}
                            swapBack={swapBack}
                            challengeId={challengeId}
                            bankroll={bankroll}
                            onSpent={onSwapped}
                        />
                    )}
                </span>
            )}
            {(boostError || turboError) && (
                <InlineError className="ml-1" onDismiss={dismissError}>
                    {ipcErrorText(boostError || turboError, t)}
                </InlineError>
            )}
        </div>
    );
}
