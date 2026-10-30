import { useLayoutEffect, useRef } from 'react';
import { deriveChallengeCardView, minimalCardView, needsSecondTick, nextBoundaryFlip } from '@/utils/challengeCardView';
import { isMinimalCardChallenge } from '@/utils/challengeAlerts';
import { isMarkedChallenge } from '../../../challengeMarks';
import { useDeadlineActions } from '@/api/useDeadlineActions';
import { useSwapBacks } from '@/api/useSwapBacks';
import { useEntryPins } from '@/api/useEntryPins';
import { useScenarioStatus } from '@/api/useScenarioStatus';
import { useChallengeSettings } from '@/hooks/useChallengeSettings';
import { useTick, useRerenderAt } from '@/hooks/useTick';
import { useTranslation } from '@/contexts/TranslationContext';
import { formatEndTime } from '@/utils/formatters';
import { ToneNote } from '@/components/ui/ToneNote';
import { ChallengeCardCompact } from './ChallengeCardCompact';
import { ChallengeCardDetail } from './ChallengeCardDetail';
import { Countdown } from './Countdown';
import type { TimeRemaining } from './Countdown';
import { useChallengeCardActions, buildCompactActionRow } from './ChallengeCardActions';

import type { Bankroll, Challenge } from '../../../types/gurushots';
import type { DeadlineActionsState } from '@/api/useDeadlineActions';
import type { Translate } from '../../../translations/translator';

/**
 * Everything the card derives from its challenge at one tick (see
 * utils/challengeCardView), shared by the detailed and compact layouts.
 */
export type ChallengeCardView = ReturnType<typeof deriveChallengeCardView>;

/**
 * Why a boost or turbo can't be placed, in words for what blocks it — null when nothing does. A flag
 * (every entry carries the other feature) asks for another entry; a pin asks to unpin, and says when
 * the pin gives way when it will.
 *
 * @param kind - the blocked feature
 * @param blockedBy - what blocks it (useDeadlineActions)
 * @param releaseAt - when the pin gives way (Unix seconds), or null
 */
const conflictWarning = (
    t: Translate,
    timezone: string,
    kind: 'boost' | 'turbo',
    blockedBy: DeadlineActionsState['boostBlockedBy'],
    releaseAt: number | null,
): string | null => {
    if (blockedBy === null) return null;
    const key =
        blockedBy === 'flag'
            ? 'app.conflictFlag'
            : releaseAt === null
              ? 'app.conflictPinNever'
              : 'app.conflictPinReleases';
    return t(key, {
        kind: t(kind === 'boost' ? 'app.boost' : 'app.turbo'),
        other: t(kind === 'boost' ? 'app.turbo' : 'app.boost'),
        time: releaseAt === null ? '' : formatEndTime(releaseAt, timezone),
    });
};

/**
 * Focus is nowhere: on nothing, on the page itself, or on an element that has
 * just been removed.
 */
const focusIsLost = (): boolean => {
    const active = document.activeElement;
    return active === null || active === document.body || !active.isConnected;
};

/**
 * Challenge card. Renders either the full detailed card (every stat and every
 * action) or, when compactCards is on for this challenge, the
 * ChallengeCardCompact tile. `compactActions` (the global compactCardActions
 * setting) gives that tile a row of the challenge-level actions; per-entry
 * actions stay in the detailed card. A minimal-card challenge (marked by the
 * boundary, or without its member standing — see utils/challengeAlerts) renders
 * the minimal card instead of both. The root element is the grid item in
 * ChallengesSection's #challenges-container: a detailed card spans the full
 * row, compact tiles share one.
 *
 * @param props.timeRemaining - live countdown from useTimers
 * @param props.onCurrencySpent - called after a key / swap / fill spend
 */
export function ChallengeCard({
    challenge,
    settingsVersion = 0,
    passVersion = 0,
    defaultCompact = false,
    compactActions = false,
    timeRemaining,
    timezone,
    autovoteRunning,
    onVoteComplete,
    onSettingsClick,
    bankroll = null,
    onCurrencySpent,
}: {
    challenge: Challenge;
    settingsVersion?: number;
    /** Autovote cycles plus manual passes; also the deadline preview's cycle signal while the last result said boostPinSubmits. */
    passVersion?: number;
    defaultCompact?: boolean;
    compactActions?: boolean;
    timeRemaining?: TimeRemaining;
    timezone: string;
    autovoteRunning: boolean;
    onVoteComplete: () => void;
    onSettingsClick: (challengeId: Challenge['id'], challengeTitle: string) => void;
    bankroll?: Bankroll | null;
    onCurrencySpent: () => void;
}) {
    const { hasCustomSettings, autoSubmitEnabled, manualPhotosOnly, isCompact, hasCompactOverride, toggleCompact } =
        useChallengeSettings(challenge.id, defaultCompact, settingsVersion);
    // Advisory deadline-action preview + boost/turbo conflict flags (read-only,
    // computed main-side). Failure yields empty actions / false — the card just
    // renders without them, never an error surface.
    const deadline = useDeadlineActions(challenge, settingsVersion, passVersion);
    const { t } = useTranslation();
    const boostWarning = conflictWarning(t, timezone, 'boost', deadline.boostBlockedBy, deadline.boostReleaseAt);
    const turboWarning = conflictWarning(t, timezone, 'turbo', deadline.turboBlockedBy, deadline.turboReleaseAt);
    const swapBacks = useSwapBacks(challenge);
    // Read once per card: the detailed layout toggles pins, the compact tile shows them.
    const entryPins = useEntryPins(challenge.id, settingsVersion);
    const scenarioStatus = useScenarioStatus(challenge, settingsVersion, passVersion);

    // The card re-renders once a second only while something on it counts down — a turbo cooldown (so
    // canPlayAutoTurbo flips the moment it elapses, without waiting for an external poll) or a timed boost
    // window's time left. Every other render reads the clock afresh; the live countdown text is the
    // Countdown leaf's own signal binding, so it never re-renders the card. The start- and close-gated
    // buttons flip on one re-render scheduled for the boundary itself.
    const now = Math.floor(Date.now() / 1000);
    useTick(1000, needsSecondTick(challenge, now));
    useRerenderAt(nextBoundaryFlip(challenge, now));

    // Marked-or-minimal is a render decision, so every hook above stays
    // unconditional and only the JSX below branches. The full-card derivation
    // reads the member standing unguarded, so a minimal card never runs it —
    // the action hooks, which cannot branch, run on a neutral view instead
    // (utils/challengeCardView).
    const marked = isMarkedChallenge(challenge);
    const minimal = isMinimalCardChallenge(challenge);
    // End time and countdown only for a close time the card can read as a
    // number; the boundary converts numeric strings, so what survives is never
    // a usable time.
    const closeTime =
        typeof challenge.close_time === 'number' && Number.isFinite(challenge.close_time) ? challenge.close_time : null;
    const view = minimal
        ? minimalCardView()
        : deriveChallengeCardView(challenge, {
              now,
              bankroll,
              autovoteRunning,
              autoSubmitEnabled,
              manualPhotosOnly,
          });
    const actions = useChallengeCardActions({
        challenge,
        view,
        bankroll,
        onVoteComplete,
        onSettingsClick,
        onCurrencySpent,
    });

    // When a modal the full card owned (Pick…, the swap confirm) closes because
    // the card turned minimal, its trigger unmounted with the full body, so
    // Modal's own focus return lands nowhere; focus then moves to the minimal
    // card's heading. The previous render's focus tells that case apart: an
    // element inside a dialog that has since left the page.
    const headingRef = useRef<HTMLHeadingElement | null>(null);
    const lastFocusRef = useRef<Element | null>(null);
    useLayoutEffect(() => {
        const last = lastFocusRef.current;
        const active = document.activeElement;
        lastFocusRef.current = active;
        if (!minimal || !last || last.isConnected || last.closest('[role="dialog"]') === null) return;
        if (focusIsLost()) headingRef.current?.focus({ preventScroll: true });
    });

    // id + scroll-mt make the card a smooth-scroll target for the anchor chips
    // in BoostWindowBanner and ChallengeNav (both go through scrollToChallenge,
    // which looks the card up by this exact id); scroll-mt keeps it off the top
    // edge after scrollIntoView. Keep `challenge-${id}` in sync with
    // scrollToChallenge. Shared by both layouts.
    const cardId = `challenge-${challenge.id}`;
    const cardClass = `${view.cardAlertClass} rounded-lg p-3 bg-base-100 scroll-mt-4 focus-visible:outline focus-visible:outline-4 focus-visible:outline-base-content focus-visible:outline-offset-4 data-[landed]:outline data-[landed]:outline-4 data-[landed]:outline-base-content data-[landed]:outline-offset-4`;
    const badgeRowProps = {
        challenge,
        boostOpen: view.boostOpen,
        boostTimeLeft: view.boostTimeLeft,
        lowExposure: view.lowExposure,
        exposureFactor: view.exposureFactor,
        showAutoSubmitBadge: view.showAutoSubmitBadge,
        showManualPhotosBadge: view.showManualPhotosBadge,
        hasCustomSettings,
    };

    // The Pick… and swap-picker modals sit beside the card, in the same place whichever layout shows, so
    // switching layouts (or a refresh that hides the buttons) never unmounts them.
    const card = minimal ? (
        // The minimal card: title, the end time and countdown when the close
        // time is readable, the notice, and the settings button alone — no
        // stats and no actions off a challenge whose fields cannot be used
        // safely. Full row, like the detailed card: the notice is sentences.
        <div id={cardId} className={`${cardClass} col-span-full`} tabIndex={-1}>
            <div className="space-y-2">
                <h3 ref={headingRef} tabIndex={-1} className="font-bold text-base wrap-anywhere">
                    {challenge.title}
                </h3>
                {closeTime !== null && (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                        <Countdown source={timeRemaining} closeTime={closeTime} />
                        <span className="font-semibold tabular-nums">{formatEndTime(closeTime, timezone)}</span>
                    </div>
                )}
                <ToneNote as="div" tone={marked ? 'warning' : 'info'} role="status" className="text-sm">
                    {t(marked ? 'app.challengeDataUnreadable' : 'app.rankingDataPending')}
                </ToneNote>
                {actions.settingsButton && <div className="flex flex-wrap gap-1">{actions.settingsButton}</div>}
            </div>
        </div>
    ) : isCompact ? (
        <div id={cardId} className={cardClass} tabIndex={-1}>
            <ChallengeCardCompact
                challenge={challenge}
                badgeRowProps={badgeRowProps}
                timeRemaining={timeRemaining}
                exposureFactor={view.exposureFactor}
                exposureTone={view.exposureTone}
                boostStatus={view.boostStatus}
                turboStatus={view.turboStatus}
                entries={view.entries}
                pins={entryPins.pins}
                manualOnly={view.manualOnly}
                hasCompactOverride={hasCompactOverride}
                onToggleCompact={toggleCompact}
                boostWarning={boostWarning}
                turboWarning={turboWarning}
                deadlineActions={deadline.actions}
                boostPinSubmits={deadline.boostPinSubmits}
                scenarioStatus={scenarioStatus}
                actions={buildCompactActionRow({ actions, canFill: view.canFill, enabled: compactActions })}
            />
        </div>
    ) : (
        // col-span-full: a detailed card takes a whole row of the grid.
        <div id={cardId} className={`${cardClass} col-span-full`} tabIndex={-1}>
            <ChallengeCardDetail
                challenge={challenge}
                view={view}
                badgeRowProps={badgeRowProps}
                timeRemaining={timeRemaining}
                timezone={timezone}
                actions={actions}
                hasCompactOverride={hasCompactOverride}
                onToggleCompact={toggleCompact}
                boostWarning={boostWarning}
                turboWarning={turboWarning}
                deadlineActions={deadline.actions}
                scenarioStatus={scenarioStatus}
                swapBacks={swapBacks}
                entryPins={entryPins}
                bankroll={bankroll}
                onVoteComplete={onVoteComplete}
                onCurrencySpent={onCurrencySpent}
                boostPinSubmits={deadline.boostPinSubmits}
            />
        </div>
    );

    return (
        <>
            {card}
            {/* A minimal card owns no modals: one open while the card turns
                minimal closes with the full body, and focus moves to the
                heading (the layout effect above). */}
            {!minimal && actions.pickModal}
            {!minimal && actions.swapPickModal}
        </>
    );
}
