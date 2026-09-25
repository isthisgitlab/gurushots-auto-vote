import { useTranslation } from '@/contexts/TranslationContext';
import { deriveChallengeCardView } from '@/utils/challengeCardView';
import { useDeadlineActions } from '@/api/useDeadlineActions';
import { useSwapBacks } from '@/api/useSwapBacks';
import { useScenarioStatus } from '@/api/useScenarioStatus';
import { useChallengeSettings } from '@/hooks/useChallengeSettings';
import { useTick } from '@/hooks/useTick';
import { ChallengeCardCompact } from './ChallengeCardCompact';
import { ChallengeCardDetail } from './ChallengeCardDetail';
import { useChallengeCardActions, buildCompactActionRow } from './ChallengeCardActions';

/**
 * Challenge card. Renders either the full detailed card (every stat and every
 * action) or, when compactCards is on for this challenge, the
 * ChallengeCardCompact tile. `compactActions` (the global compactCardActions
 * setting) gives that tile a row of the challenge-level actions; per-entry
 * actions stay in the detailed card. The root element is the grid item in
 * ChallengesSection's #challenges-container: a detailed card spans the full
 * row, compact tiles share one.
 */
export function ChallengeCard({
    challenge,
    settingsVersion = 0,
    defaultCompact = false,
    compactActions = false,
    timeRemaining,
    timezone,
    autovoteRunning,
    onVoteComplete,
    onSettingsClick,
    bankroll = null,
    onCurrencySpent,
}) {
    const { t } = useTranslation();
    const { hasCustomSettings, autoFillEnabled, isCompact, hasCompactOverride, toggleCompact } = useChallengeSettings(
        challenge.id,
        defaultCompact,
        settingsVersion,
    );
    // Advisory deadline-action preview + boost/turbo conflict flag (read-only,
    // computed main-side). Failure yields empty actions / false — the card just
    // renders without them, never an error surface.
    const { actions: deadlineActions, boostBlocked } = useDeadlineActions(challenge, settingsVersion);
    const swapBacks = useSwapBacks(challenge);
    const scenarioStatus = useScenarioStatus(challenge, settingsVersion);

    // Tick once a second — only meaningful when this challenge is in TIMER
    // state and we want canPlayAutoTurbo to flip to true the moment the
    // cooldown elapses without waiting for an external poll.
    const now = useTick(1000);

    // timeRemaining is a Signal<string> from useTimers — reading .value here
    // subscribes this card so the countdown text stays live. The badges smoke
    // test passes a plain string, so fall back to the raw value (or a loading
    // placeholder) when it isn't a signal.
    const timeText =
        timeRemaining && typeof timeRemaining === 'object' ? timeRemaining.value : timeRemaining || t('common.loading');

    const view = deriveChallengeCardView(challenge, { now, bankroll, autovoteRunning, autoFillEnabled });
    const actions = useChallengeCardActions({
        challenge,
        view,
        bankroll,
        autovoteRunning,
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
    const cardClass = `${view.cardAlertClass} rounded-lg p-3 bg-base-100 scroll-mt-4`;
    const badgeRowProps = {
        challenge,
        boostOpen: view.boostOpen,
        boostTimeLeft: view.boostTimeLeft,
        lowExposure: view.lowExposure,
        exposureFactor: view.exposureFactor,
        showAutoFillBadge: view.showAutoFillBadge,
        hasCustomSettings,
    };

    if (isCompact) {
        return (
            <div id={cardId} className={cardClass}>
                <ChallengeCardCompact
                    challenge={challenge}
                    badgeRowProps={badgeRowProps}
                    timeText={timeText}
                    exposureFactor={view.exposureFactor}
                    exposureClass={view.exposureClass}
                    boostStatus={view.boostStatus}
                    turboStatus={view.turboStatus}
                    entries={view.entries}
                    hasCompactOverride={hasCompactOverride}
                    onToggleCompact={toggleCompact}
                    boostBlocked={boostBlocked}
                    deadlineActions={deadlineActions}
                    scenarioStatus={scenarioStatus}
                    actions={buildCompactActionRow({ actions, canFill: view.canFill, enabled: compactActions })}
                />
            </div>
        );
    }

    return (
        // col-span-full: a detailed card takes a whole row of the grid.
        <div id={cardId} className={`${cardClass} col-span-full`}>
            <ChallengeCardDetail
                challenge={challenge}
                view={view}
                badgeRowProps={badgeRowProps}
                timeText={timeText}
                timezone={timezone}
                actions={actions}
                autovoteRunning={autovoteRunning}
                hasCompactOverride={hasCompactOverride}
                onToggleCompact={toggleCompact}
                boostBlocked={boostBlocked}
                deadlineActions={deadlineActions}
                scenarioStatus={scenarioStatus}
                swapBacks={swapBacks}
                bankroll={bankroll}
                onVoteComplete={onVoteComplete}
                onCurrencySpent={onCurrencySpent}
            />
        </div>
    );
}
