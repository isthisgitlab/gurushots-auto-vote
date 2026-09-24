import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useChallenges } from '@/contexts/ChallengesContext';
import { useTimers } from '@/hooks/useTimers';
import { ChallengeCard } from './ChallengeCard';
import { BoostWindowBanner } from './BoostWindowBanner';
import { LowExposureBanner } from './LowExposureBanner';
import { ChallengeNav } from './ChallengeNav';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { IconActionButton } from '@/components/ui/IconActionButton';
import { ResetIcon } from '@/components/ui/ResetButton';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';
import * as ipc from '@/api/ipc';

/**
 * Global card density: the compactCards default and the compactCardActions
 * switch, kept in sync with settings-changed events, plus `refreshKey` — bumped
 * whenever a setting changes and handed to each ChallengeCard as
 * `settingsVersion`, so the card re-reads its effective settings and its
 * deadline-action preview in place (no remount).
 */
function useGlobalCardDensity() {
    const [globalCompact, setGlobalCompact] = useState(false);
    const [compactActions, setCompactActions] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);

    // Read the global compactCards default and the compactCardActions switch
    // + listen for settings-changed events so the toggle below stays in sync
    // if it gets flipped elsewhere (e.g. via the Settings modal).
    useEffect(() => {
        const sync = async () => {
            try {
                const [compact, actions] = await Promise.all([
                    ipc.getGlobalDefault('compactCards'),
                    ipc.getGlobalDefault('compactCardActions'),
                ]);
                setGlobalCompact(compact === true);
                setCompactActions(actions === true);
            } catch {
                /* default to false (detailed cards, action-free compact tiles) */
            }
        };
        sync();
        const off = ipc.onSettingsChanged(() => {
            sync();
            // Bump refreshKey so each ChallengeCard re-reads its effective
            // settings (any per-challenge override + the new global default)
            // in place — cards are not remounted, so an in-flight action
            // keeps its busy state.
            setRefreshKey((k) => k + 1);
        });
        return () => {
            if (typeof off === 'function') off();
        };
    }, []);

    const toggleGlobalCompact = useCallback(async () => {
        const next = !globalCompact;
        try {
            await ipc.setGlobalDefault('compactCards', next);
            setGlobalCompact(next);
            setRefreshKey((k) => k + 1);
        } catch {
            /* leave UI as-is on failure */
        }
    }, [globalCompact]);

    return { globalCompact, compactActions, refreshKey, toggleGlobalCompact };
}

/**
 * Challenges section with Vote All, Refresh buttons, and challenge cards
 */
export function ChallengesSection({
    timezone,
    autovoteRunning,
    isLoggedIn,
    onChallengeSettingsClick,
    bankroll = null,
    onBankrollChanged,
}) {
    const { t } = useTranslation();
    const { challenges, loading, error, refetch } = useChallenges();
    const times = useTimers(challenges);
    const { globalCompact, compactActions, refreshKey, toggleGlobalCompact } = useGlobalCardDensity();

    // Shared success path for the Vote All / Run buttons below (awaited, so
    // their spinner holds until the refreshed list lands).
    const refetchAfterAction = useCallback(() => refetch(true), [refetch]);

    // Per-card success path: refresh without holding the card's spinner.
    const handleVoteComplete = useCallback(() => {
        refetch(true);
    }, [refetch]);

    const handleRefresh = useCallback(() => {
        refetch();
    }, [refetch]);

    // A key / swap / fill spend changes both the challenge and the balance.
    const handleCurrencySpent = useCallback(() => {
        handleVoteComplete();
        if (onBankrollChanged) onBankrollChanged();
    }, [handleVoteComplete, onBankrollChanged]);

    // Transient-failure banner: a failed fetch (retries exhausted) surfaces
    // here instead of being silently shown as "no challenges". Auto-clears on
    // the next successful refresh.
    const fetchErrorBanner = error ? (
        <div role="alert" className="alert alert-warning text-sm mb-4">
            <span>{t('errors.fetchFailed')}</span>
        </div>
    ) : null;

    if (loading && challenges.length === 0) {
        return (
            <div className="flex justify-center py-8">
                <LoadingSpinner size="lg" />
            </div>
        );
    }

    if (challenges.length === 0) {
        return (
            <div>
                {fetchErrorBanner}
                <div className="text-center py-4 text-base-content/60">
                    {isLoggedIn ? t('app.noActiveChallenges') : t('app.pleaseLogin')}
                </div>
                {error && isLoggedIn && (
                    <div className="text-center">
                        <button type="button" className="btn btn-outline btn-sm" onClick={handleRefresh}>
                            {t('common.refresh')}
                        </button>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div>
            {fetchErrorBanner}
            {/* Action Buttons — flex-wrap so the Compact toggle wraps
                to a second row on narrow viewports instead of clipping
                off the right edge. */}
            <div className="flex flex-wrap gap-2 mb-4 items-center">
                {!autovoteRunning && (
                    <>
                        <IconActionButton
                            className="btn btn-latvian btn-sm"
                            action={() => ipc.voteAllChallengesManual()}
                            onSuccess={refetchAfterAction}
                            failureLogPrefix="Vote All failed"
                            errorLogPrefix="Error during Vote All"
                            loadingLabel={t('app.votingAll')}
                            icon={ICON_PATHS.vote}
                            label={t('app.voteAll')}
                        />
                        <IconActionButton
                            className="btn btn-latvian btn-sm"
                            action={() => ipc.runVotingCycle()}
                            onSuccess={refetchAfterAction}
                            failureLogPrefix="Run failed"
                            errorLogPrefix="Error during Run"
                            loadingLabel={t('app.running')}
                            icon={ICON_PATHS.run}
                            label={t('app.run')}
                        />
                        <button className="btn btn-outline btn-sm" onClick={handleRefresh} disabled={loading}>
                            {loading ? <span className="loading loading-spinner loading-xs" /> : <ResetIcon />}
                            {t('app.refresh')}
                        </button>
                    </>
                )}
                {/* Global compact-mode toggle. Sets the default density
                    for all cards; per-card overrides on individual
                    challenges remain.

                    The label names the ACTION, not the current state — this is
                    a button, so while the cards are compact it reads "Details"
                    ("click to get details"), matching the per-card toggle in
                    ChallengeCard. The icon follows the same rule: it depicts
                    the view you are about to switch TO. */}
                <button className="btn btn-outline btn-sm sm:ml-auto" onClick={toggleGlobalCompact}>
                    <StrokeIcon
                        d={globalCompact ? ICON_PATHS.listCompact : ICON_PATHS.listDetailed}
                        className="w-4 h-4 mr-1"
                    />
                    {globalCompact ? t('app.details') : t('app.compact')}
                </button>
            </div>

            {/* Boost-window summary: anchors to the challenges whose boost
                window is open right now. Self-hides when none are open. */}
            <BoostWindowBanner challenges={challenges} />

            {/* Low-exposure summary: anchors to running challenges whose
                exposure is at or near zero. Self-hides when none are low. */}
            <LowExposureBanner challenges={challenges} />

            {/* Jump-to-challenge index: anchors to every card by title so the
                user can click a name instead of scrolling. */}
            <ChallengeNav challenges={challenges} />

            {/* Challenge Cards — a grid where each card picks its own span:
                a detailed card is col-span-full, compact tiles share a row,
                as many per row as fit at >= 16rem each. */}
            <div id="challenges-container" className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
                {challenges.map((challenge) => (
                    <ChallengeCard
                        key={challenge.id}
                        settingsVersion={refreshKey}
                        challenge={challenge}
                        defaultCompact={globalCompact}
                        compactActions={compactActions}
                        timeRemaining={times[challenge.id]}
                        timezone={timezone}
                        autovoteRunning={autovoteRunning}
                        onVoteComplete={handleVoteComplete}
                        onSettingsClick={onChallengeSettingsClick}
                        bankroll={bankroll}
                        onCurrencySpent={handleCurrencySpent}
                    />
                ))}
            </div>
        </div>
    );
}
