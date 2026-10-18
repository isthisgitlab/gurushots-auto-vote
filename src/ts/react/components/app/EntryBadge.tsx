import type { Bankroll, Challenge, RankingEntry } from '../../../types/gurushots';
import type { EntryPinKind, EntryPins } from '../../../types/settings';
import type { SwapBackOffer } from '@/api/useSwapBacks';
import type { OpenSwapPick } from './SwapEntryButton';
import { useTranslation } from '@/contexts/TranslationContext';
import { useBoost } from '@/api/useBoost';
import { ipcErrorText } from '@/api/ipcErrorText';
import { useTurbo } from '@/api/useTurbo';
import { getEntryStatus } from '@/utils/formatters';
import { ActionButton } from '@/components/ui/ActionButton';
import { InlineError } from '@/components/ui/InlineError';
import { BusyContent } from '@/components/ui/LoadingSpinner';

import { EntryPhoto } from './EntryPhoto';
import { EntryTime } from './EntryTime';
import { SwapEntryButton, SwapBackButton } from './SwapEntryButton';

/**
 * What an entry badge needs to pin its photo for Boost or Turbo.
 *
 * @property pins - the challenge's stored pins
 * @property canPin - per feature, whether it can still fire (a toggle for a spent feature stays hidden)
 * @property livePin - the feature this entry is live-pinned for (the Swap warning names it)
 * @property busy - a pin write is in flight: the toggles are aria-disabled and ignore a press (focus stays put), so a
 *   second press cannot repeat a stale action
 * @property onToggle - pin this entry, or clear the pin when it already holds it
 */
export type EntryPinControls = {
    pins: EntryPins;
    canPin: Record<EntryPinKind, boolean>;
    livePin: EntryPinKind | null;
    busy: boolean;
    onToggle: (kind: EntryPinKind, imageId: string) => void | Promise<void>;
};

// A pressed pin is solid in its feature's colour. An unpressed one is a plain `btn-outline`, which daisyUI draws in
// `base-content` (border and label) in every theme; the label names the feature, so no colour cue is needed.
const PIN_PRESSED_VARIANTS = { boost: 'success', turbo: 'warning' } as const;

/**
 * One "Pin for Boost / Turbo" toggle: `aria-pressed` carries the state, and the visible text says it too ("Pinned
 * for Boost", as the compact tile does), which is also its accessible name.
 */
function PinToggle({
    kind,
    pressed,
    busy,
    onToggle,
}: {
    kind: EntryPinKind;
    pressed: boolean;
    busy: boolean;
    onToggle: () => void | Promise<void>;
}) {
    const { t } = useTranslation();
    const name = t(kind === 'boost' ? 'app.pinForBoost' : 'app.pinForTurbo');
    const pinnedName = t(kind === 'boost' ? 'app.pinnedForBoost' : 'app.pinnedForTurbo');
    return (
        <ActionButton
            variant={pressed ? PIN_PRESSED_VARIANTS[kind] : 'plain'}
            className={[pressed ? '' : 'btn-outline', busy ? 'btn-disabled' : ''].filter(Boolean).join(' ')}
            aria-pressed={pressed}
            // aria-disabled, not disabled: a disabled button drops the keyboard focus to <body> mid-write.
            onClick={() => {
                if (!busy) void onToggle();
            }}
            aria-disabled={busy}
            aria-busy={busy}
        >
            <span aria-hidden="true">📌</span> {pressed ? pinnedName : name}
        </ActionButton>
    );
}

/**
 * Which pin toggles an entry shows: a toggle shows while its feature can still fire, and not on a photo that carries
 * the other feature.
 */
const visiblePins = (pin: EntryPinControls | undefined, carriesBoost: boolean, carriesTurbo: boolean) => ({
    boost: pin !== undefined && pin.canPin.boost && !carriesTurbo,
    turbo: pin !== undefined && pin.canPin.turbo && !carriesBoost,
});

/**
 * The pin toggles of one entry, direct children of the actions row so its gap keeps them apart from the spend buttons.
 */
function PinToggles({
    entry,
    pin,
    showBoost,
    showTurbo,
}: {
    entry: RankingEntry;
    pin: EntryPinControls;
    showBoost: boolean;
    showTurbo: boolean;
}) {
    const imageId = String(entry.id);
    return (
        <>
            {showBoost && (
                <PinToggle
                    kind="boost"
                    pressed={pin.pins.boost === imageId}
                    busy={pin.busy}
                    onToggle={() => pin.onToggle('boost', imageId)}
                />
            )}
            {showTurbo && (
                <PinToggle
                    kind="turbo"
                    pressed={pin.pins.turbo === imageId}
                    busy={pin.busy}
                    onToggle={() => pin.onToggle('turbo', imageId)}
                />
            )}
        </>
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
 * @param props.onChooseSwap - opens the card's swap picker for this entry
 * @param props.swapBack - Swap-back offer for this slot (the original was swapped out while boosted/turbo'd)
 * @param props.pin - the pin toggles (absent = none shown)
 * @param props.timezone - the timezone setting the entry's submit time is written in
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
    onChooseSwap,
    swapBack = null,
    pin,
    timezone,
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
    onChooseSwap: OpenSwapPick;
    swapBack?: SwapBackOffer | null;
    pin?: EntryPinControls;
    timezone: string;
}) {
    const { t } = useTranslation();
    const { applyBoost, loading: boosting, error: boostError, clearError: clearBoostError } = useBoost();
    const { applyTurbo, loading: turboing, error: turboError, clearError: clearTurboError } = useTurbo();

    // Shared with the compact card's glyph row so both read one mapping.
    const { isBoosted: isEntryBoosted, isTurboed: isEntryTurboed, icon } = getEntryStatus(entry);
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

    const pins = visiblePins(pin, isEntryBoosted, isEntryTurboed);
    const hasActions = showBoostButton || showTurboButton || pins.boost || pins.turbo || swapAvailable;

    return (
        // Two left-aligned rows in a column: what the entry is (photo, rank, when it went in), then what can be done
        // with it. Each row wraps on its own, so up to six buttons with longer translated labels do not overflow a
        // narrow (Android) width. gap-2 (8px) keeps adjacent touch targets apart, both between the buttons of the
        // actions row and between the rows: the photo chip (44px on touch) sits right above the first button, and
        // Boost / Turbo spend at once.
        <div className="rounded-box border-base-300 flex flex-col items-start gap-2 border p-2 text-left text-xs">
            <div className="flex flex-wrap items-center gap-1">
                <EntryPhoto entry={entry} />
                <span>{icon}</span>
                <span>
                    {t('app.rank')} {entry.rank} ({entry.votes} {t('app.votes')})
                </span>
                <EntryTime time={entry.appEntered} timezone={timezone} />
            </div>
            {hasActions && (
                <div className="flex flex-wrap items-center gap-2">
                    {showBoostButton && (
                        <ActionButton
                            variant="success"
                            error={boostError}
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
                            onClick={() => void handleTurbo()}
                            disabled={turboing}
                            aria-busy={turboing}
                        >
                            <BusyContent busy={turboing} label={t('app.turbo')}>
                                {`⚡ ${t('app.turbo')}`}
                            </BusyContent>
                        </ActionButton>
                    )}
                    {pin && <PinToggles entry={entry} pin={pin} showBoost={pins.boost} showTurbo={pins.turbo} />}
                    {swapAvailable && (
                        <>
                            <SwapEntryButton
                                entry={entry}
                                challengeId={challengeId}
                                bankroll={bankroll}
                                warnActioned={isEntryActioned}
                                warnPinned={pin?.livePin ?? null}
                                onSpent={onSwapped}
                                onChoose={onChooseSwap}
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
                        </>
                    )}
                </div>
            )}
            {(boostError || turboError) && (
                <InlineError onDismiss={dismissError}>{ipcErrorText(boostError || turboError, t)}</InlineError>
            )}
        </div>
    );
}
