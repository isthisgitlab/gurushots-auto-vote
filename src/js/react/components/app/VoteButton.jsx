import { useState, useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';

/**
 * Vote button for a single challenge
 */
export function VoteButton({ challengeId, challengeTitle, onVoteComplete }) {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(false);

    const handleVote = useCallback(async () => {
        setLoading(true);
        try {
            const result = await window.api.voteOnChallengeManual(challengeId, challengeTitle);

            if (result?.success) {
                if (onVoteComplete) {
                    onVoteComplete();
                }
            } else {
                await window.api.logError(`Voting failed: ${result?.error || 'Unknown error'}`);
            }
        } catch (err) {
            await window.api.logError(`Error voting on challenge: ${err.message || err}`);
        } finally {
            setLoading(false);
        }
    }, [challengeId, challengeTitle, onVoteComplete]);

    return (
        <button className="btn btn-latvian btn-sm" onClick={handleVote} disabled={loading} title={t('app.voteTitle')}>
            {loading ? (
                <>
                    <span className="loading loading-spinner loading-xs" />
                    {t('app.voting')}
                </>
            ) : (
                <>
                    <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                    </svg>
                    {t('app.vote')}
                </>
            )}
        </button>
    );
}
