/**
 * Entry details — the entry-level half of ChallengeCardDetail: the per-entry
 * boost / turbo badges and actions (EntryBadge), the pin toggles they ride in
 * on, and the notes for pins that no longer apply. The shared offer/pin state
 * types stay exported on ChallengeCardDetail and come back here as a type-only
 * import, so the value import points one way only.
 */

import { useId, useRef } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { isBoostAvailable } from '@/utils/formatters';
import { EntryBadge } from './EntryBadge';
import { InlineError } from '@/components/ui/InlineError';
import { ipcErrorText } from '@/api/ipcErrorText';
import { useFocusRestore } from '@/hooks/useFocusRestore';
import { canStillFire, livePinKindOf, unusablePins } from '../../../voting/entryPins';

import type { Bankroll, Challenge } from '../../../types/gurushots';
import type { ChallengeCardView } from './ChallengeCard';
import type { OpenSwapPick } from './SwapEntryButton';
import type { EntryPinKind } from '../../../types/settings';
import type { EntryPinsState, SwapBackOffers } from './ChallengeCardDetail';

/**
 * A stored pin that cannot take its feature right now (its photo left the challenge, or carries the other
 * feature), with a way to clear it. Only while the feature can still fire: a spent feature's pin is inert.
 * A gone Boost pin with the Boost-pinned submit eligible gets the submit note instead of the plain wait
 * note. The button is inert while a pin write is in flight, like the pin toggles: aria-disabled, never `disabled`.
 */
function DanglingPinNote({
    kind,
    state,
    busy,
    boostPinSubmits,
    onClear,
}: {
    kind: EntryPinKind;
    state: 'gone' | 'conflict';
    busy: boolean;
    /** The Boost-pinned submit can place the boost on this gone pin; picks the note's text. */
    boostPinSubmits: boolean;
    onClear: (button: HTMLButtonElement) => void | Promise<void>;
}) {
    const { t } = useTranslation();
    const text =
        kind === 'boost' && state === 'gone' && boostPinSubmits
            ? t('app.pinGoneSubmitNote')
            : t(state === 'gone' ? 'app.pinGoneNote' : 'app.pinConflictNote', {
                  kind: t(kind === 'boost' ? 'app.boost' : 'app.turbo'),
                  other: t(kind === 'boost' ? 'app.turbo' : 'app.boost'),
              });
    return (
        <div className="alert alert-info py-2 text-xs" role="status">
            <span>{text}</span>
            <button
                type="button"
                className={`btn btn-sm max-sm:min-h-10${busy ? ' btn-disabled' : ''}`}
                aria-disabled={busy}
                aria-busy={busy}
                onClick={(event) => {
                    if (!busy) void onClear(event.currentTarget);
                }}
            >
                {t('app.pinClear')}
            </button>
        </div>
    );
}

/**
 * Entry details — entry-level boost / turbo badges and actions, the pin toggles and the notes for pins that no
 * longer apply.
 */
export function EntryDetails({
    challenge,
    view,
    swapBacks,
    entryPins,
    bankroll,
    onVoteComplete,
    onCurrencySpent,
    onChooseSwap,
    timezone,
    boostPinSubmits = false,
}: {
    challenge: Challenge;
    view: ChallengeCardView;
    swapBacks: SwapBackOffers;
    entryPins: EntryPinsState;
    bankroll: Bankroll | null;
    onVoteComplete: () => void;
    onCurrencySpent: () => void;
    onChooseSwap: OpenSwapPick;
    timezone: string;
    /** The Boost-pinned submit can place the boost on its gone pin; forwarded to each DanglingPinNote. */
    boostPinSubmits?: boolean;
}) {
    const { t } = useTranslation();
    const { pins, togglePin, setPin, loading: pinBusy, error: pinError, clearError: clearPinError } = entryPins;
    const canPin = { boost: canStillFire(challenge, 'boost'), turbo: canStillFire(challenge, 'turbo') };
    const detailsRef = useRef<HTMLDivElement>(null);
    const labelId = useId();
    // A cleared pin's note unmounts with the focused button inside it: focus would drop to <body>, so it moves to
    // the section instead.
    const recordClearedTrigger = useFocusRestore(() => detailsRef.current);

    const clearPin = async (kind: EntryPinKind, button: HTMLButtonElement) => {
        recordClearedTrigger(button);
        await setPin(kind, null);
    };

    return (
        <div ref={detailsRef} tabIndex={-1} role="group" aria-labelledby={labelId}>
            <div className="text-xs text-base-content/70 mb-1">
                <span id={labelId}>{t('app.entryDetails')}</span>:
            </div>
            <div className="flex flex-col items-start gap-1">
                {view.entries.map((entry) => (
                    <EntryBadge
                        key={entry.id}
                        entry={entry}
                        challengeId={challenge.id}
                        boostAvailable={isBoostAvailable(view.boostStatus)}
                        turboAvailable={view.member.turbo?.state === 'WON'}
                        onBoostApplied={onVoteComplete}
                        onTurboApplied={onVoteComplete}
                        swapAvailable={view.swapAvailable}
                        bankroll={bankroll}
                        onSwapped={onCurrencySpent}
                        onChooseSwap={onChooseSwap}
                        swapBack={swapBacks.find((r) => r.currentId === String(entry.id)) ?? null}
                        pin={{
                            pins,
                            canPin,
                            livePin: livePinKindOf(challenge, entry, pins),
                            busy: pinBusy,
                            onToggle: togglePin,
                        }}
                        timezone={timezone}
                    />
                ))}
            </div>
            {/* Manual Only: a pin only steers the automatic spends, which do not run, so its notes stay hidden. */}
            {(view.manualOnly ? [] : unusablePins(challenge, pins)).map(({ kind, state }) => (
                <DanglingPinNote
                    key={kind}
                    kind={kind}
                    state={state}
                    busy={pinBusy}
                    boostPinSubmits={boostPinSubmits}
                    onClear={(button) => clearPin(kind, button)}
                />
            ))}
            {pinError && (
                <InlineError className="mt-1" onDismiss={clearPinError}>
                    {ipcErrorText(pinError, t)}
                </InlineError>
            )}
        </div>
    );
}
