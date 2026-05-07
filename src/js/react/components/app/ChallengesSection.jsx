import { useState, useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useChallenges } from '@/contexts/ChallengesContext';
import { useTimers } from '@/hooks/useTimers';
import { ChallengeCard } from './ChallengeCard';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

/**
 * Challenges section with Vote All, Refresh buttons, and challenge cards
 */
export function ChallengesSection({
    timezone,
    autovoteRunning,
    isLoggedIn,
    onChallengeSettingsClick,
}) {
    const { t } = useTranslation();
    const { challenges, loading, refetch } = useChallenges();
    const times = useTimers(challenges);
    const [votingAll, setVotingAll] = useState(false);

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

    const handleRefresh = useCallback(() => {
        refetch();
    }, [refetch]);

    const handleVoteComplete = useCallback(() => {
        // Refresh challenges after a vote
        refetch(true);
    }, [refetch]);

    if (loading && challenges.length === 0) {
        return (
            <div className="flex justify-center py-8">
                <LoadingSpinner size="lg" text={t('common.loading')} />
            </div>
        );
    }

    if (!challenges || challenges.length === 0) {
        return (
            <div className="text-center py-4 text-base-content/60">
                {isLoggedIn ? t('app.noActiveChallenges') : t('app.pleaseLogin')}
            </div>
        );
    }

    return (
        <div>
            {/* Action Buttons */}
            <div className="flex gap-2 mb-4">
                {!autovoteRunning && (
                    <>
                        <button
                            className="btn btn-latvian btn-sm"
                            onClick={handleVoteAll}
                            disabled={votingAll}
                        >
                            {votingAll ? (
                                <>
                                    <span className="loading loading-spinner loading-xs" />
                                    {t('app.votingAll')}
                                </>
                            ) : (
                                <>
                                    <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    {t('app.voteAll')}
                                </>
                            )}
                        </button>
                        <button
                            className="btn btn-ghost btn-sm"
                            onClick={handleRefresh}
                            disabled={loading}
                        >
                            {loading ? (
                                <span className="loading loading-spinner loading-xs" />
                            ) : (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                            )}
                            {t('app.refresh')}
                        </button>
                    </>
                )}
            </div>

            {/* Challenge Cards */}
            <div id="challenges-container">
                {challenges.map((challenge) => (
                    <ChallengeCard
                        key={challenge.id}
                        challenge={challenge}
                        timeRemaining={times[challenge.id] || 'Loading...'}
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
