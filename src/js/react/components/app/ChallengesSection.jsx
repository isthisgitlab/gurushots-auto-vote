import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useChallenges } from '@/contexts/ChallengesContext';
import { useTimers } from '@/hooks/useTimers';
import { ChallengeCard } from './ChallengeCard';
import { BoostWindowBanner } from './BoostWindowBanner';
import { ChallengeNav } from './ChallengeNav';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

/**
 * Challenges section with Vote All, Refresh buttons, and challenge cards
 */
export function ChallengesSection({ timezone, autovoteRunning, isLoggedIn, onChallengeSettingsClick }) {
    const { t } = useTranslation();
    const { challenges, loading, error, refetch } = useChallenges();
    const times = useTimers(challenges);
    const [votingAll, setVotingAll] = useState(false);
    const [runningCycle, setRunningCycle] = useState(false);
    const [globalCompact, setGlobalCompact] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);

    // Read the global compactCards default + listen for settings-changed
    // events so the toggle below stays in sync if it gets flipped
    // elsewhere (e.g. via the Settings modal).
    useEffect(() => {
        const sync = async () => {
            try {
                const value = await window.api.getGlobalDefault('compactCards');
                setGlobalCompact(value === true);
            } catch {
                /* default to false (cards open in detailed view) */
            }
        };
        sync();
        const off = window.api.onSettingsChanged?.(() => {
            sync();
            // Bump refreshKey so each ChallengeCard re-fetches its
            // effective setting (any per-challenge override + the new
            // global default).
            setRefreshKey((k) => k + 1);
        });
        return () => {
            if (typeof off === 'function') off();
        };
    }, []);

    const handleToggleGlobalCompact = useCallback(async () => {
        const next = !globalCompact;
        try {
            await window.api.setGlobalDefault('compactCards', next);
            setGlobalCompact(next);
            setRefreshKey((k) => k + 1);
        } catch {
            /* leave UI as-is on failure */
        }
    }, [globalCompact]);

    const handleVoteAll = useCallback(async () => {
        setVotingAll(true);
        try {
            const result = await window.api.voteAllChallengesManual();
            if (result?.success) {
                await refetch(true);
            } else {
                await window.api.logError(`Vote All failed: ${result?.error || 'Unknown error'}`);
            }
        } catch (err) {
            await window.api.logError(`Error during Vote All: ${err.message || err}`);
        } finally {
            setVotingAll(false);
        }
    }, [refetch]);

    const handleRun = useCallback(async () => {
        setRunningCycle(true);
        try {
            const result = await window.api.runVotingCycle();
            if (result?.success) {
                await refetch(true);
            } else {
                await window.api.logError(`Run failed: ${result?.error || 'Unknown error'}`);
            }
        } catch (err) {
            await window.api.logError(`Error during Run: ${err.message || err}`);
        } finally {
            setRunningCycle(false);
        }
    }, [refetch]);

    const handleRefresh = useCallback(() => {
        refetch();
    }, [refetch]);

    const handleVoteComplete = useCallback(() => {
        // Refresh challenges after a vote
        refetch(true);
    }, [refetch]);

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
                <LoadingSpinner size="lg" text={t('common.loading')} />
            </div>
        );
    }

    if (!challenges || challenges.length === 0) {
        return (
            <div>
                {fetchErrorBanner}
                <div className="text-center py-4 text-base-content/60">
                    {isLoggedIn ? t('app.noActiveChallenges') : t('app.pleaseLogin')}
                </div>
                {error && isLoggedIn && (
                    <div className="text-center">
                        <button type="button" className="btn btn-sm" onClick={handleRefresh}>
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
                        <button className="btn btn-latvian btn-sm" onClick={handleVoteAll} disabled={votingAll}>
                            {votingAll ? (
                                <>
                                    <span className="loading loading-spinner loading-xs" />
                                    {t('app.votingAll')}
                                </>
                            ) : (
                                <>
                                    <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth="2"
                                            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                                        />
                                    </svg>
                                    {t('app.voteAll')}
                                </>
                            )}
                        </button>
                        <button className="btn btn-latvian btn-sm" onClick={handleRun} disabled={runningCycle}>
                            {runningCycle ? (
                                <>
                                    <span className="loading loading-spinner loading-xs" />
                                    {t('app.running')}
                                </>
                            ) : (
                                <>
                                    <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth="2"
                                            d="M13 10V3L4 14h7v7l9-11h-7z"
                                        />
                                    </svg>
                                    {t('app.run')}
                                </>
                            )}
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={handleRefresh} disabled={loading}>
                            {loading ? (
                                <span className="loading loading-spinner loading-xs" />
                            ) : (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth="2"
                                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                                    />
                                </svg>
                            )}
                            {t('app.refresh')}
                        </button>
                    </>
                )}
                {/* Global compact-mode toggle. Sets the default density
                    for all cards; per-card overrides on individual
                    challenges remain. */}
                <button
                    className="btn btn-ghost btn-sm sm:ml-auto"
                    onClick={handleToggleGlobalCompact}
                    title={globalCompact ? 'Show full details' : 'Compact view'}
                >
                    <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        {globalCompact ? (
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                d="M4 6h16M4 12h16M4 18h7"
                            />
                        ) : (
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                d="M4 6h16M4 10h16M4 14h16M4 18h16"
                            />
                        )}
                    </svg>
                    {globalCompact ? 'Compact' : 'Detailed'}
                </button>
            </div>

            {/* Boost-window summary: anchors to the challenges whose boost
                window is open right now. Self-hides when none are open. */}
            <BoostWindowBanner challenges={challenges} />

            {/* Jump-to-challenge index: anchors to every card by title so the
                user can click a name instead of scrolling. */}
            <ChallengeNav challenges={challenges} />

            {/* Challenge Cards */}
            <div id="challenges-container">
                {challenges.map((challenge) => (
                    <ChallengeCard
                        key={`${challenge.id}-${refreshKey}`}
                        challenge={challenge}
                        timeRemaining={times[challenge.id]}
                        timezone={timezone}
                        autovoteRunning={autovoteRunning}
                        onVoteComplete={handleVoteComplete}
                        onSettingsClick={onChallengeSettingsClick}
                    />
                ))}
            </div>
        </div>
    );
}
