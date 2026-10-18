import { deriveChallengeCardView, needsSecondTick, nextBoundaryFlip } from '@/utils/challengeCardView';
import { useDeadlineActions } from '@/api/useDeadlineActions';
import { useSwapBacks } from '@/api/useSwapBacks';
import { useEntryPins } from '@/api/useEntryPins';
import { useScenarioStatus } from '@/api/useScenarioStatus';
import { useChallengeSettings } from '@/hooks/useChallengeSettings';
import { useTick, useRerenderAt } from '@/hooks/useTick';
import { useTranslation } from '@/contexts/TranslationContext';
import { formatEndTime } from '@/utils/formatters';
import { interp } from '@/utils/interp';
import { ChallengeCardCompact } from './ChallengeCardCompact';
import { ChallengeCardDetail } from './ChallengeCardDetail';
import type { TimeRemaining } from './Countdown';
import { useChallengeCardActions, buildCompactActionRow } from './ChallengeCardActions';

import type { Bankroll, Challenge } from '../../../types/gurushots';
import type { DeadlineActionsState } from '@/api/useDeadlineActions';

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
    t: (key: string) => string,
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
    return interp(t(key), {
        kind: t(kind === 'boost' ? 'app.boost' : 'app.turbo'),
        other: t(kind === 'boost' ? 'app.turbo' : 'app.boost'),
        time: releaseAt === null ? '' : formatEndTime(releaseAt, timezone),
    });
};

/**
 * Challenge card. Renders either the full detailed card (every stat and every
 * action) or, when compactCards is on for this challenge, the
 * ChallengeCardCompact tile. `compactActions` (the global compactCardActions
 * setting) gives that tile a row of the challenge-level actions; per-entry
 * actions stay in the detailed card. The root element is the grid item in
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
    const deadline = useDeadlineActions(challenge, settingsVersion);
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

    const view = deriveChallengeCardView(challenge, {
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
    const card = isCompact ? (
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
            />
        </div>
    );

    return (
        <>
            {card}
            {actions.pickModal}
            {actions.swapPickModal}
        </>
    );
}
