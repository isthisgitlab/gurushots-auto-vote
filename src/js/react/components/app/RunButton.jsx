import { useState, useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';

/**
 * Run button for a single challenge — fires one full auto-strategy
 * cycle (boost / turbo / auto-fill / threshold-aware vote) scoped
 * to this card. Distinct from VoteButton which votes-to-100% only.
 */
export function RunButton({ challengeId, onVoteComplete }) {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(false);

    const handleRun = useCallback(async () => {
        setLoading(true);
        try {
            const result = await window.api.runVotingCycleForChallenge(challengeId);
            if (result?.success) {
                if (onVoteComplete) onVoteComplete();
            } else {
                await window.api.logError(`Run failed: ${result?.error || 'Unknown error'}`);
            }
        } catch (err) {
            await window.api.logError(`Error running cycle: ${err.message || err}`);
        } finally {
            setLoading(false);
        }
    }, [challengeId, onVoteComplete]);

    return (
        <button className="btn btn-latvian btn-xs px-1" onClick={handleRun} disabled={loading}>
            {loading ? (
                <>
                    <span className="loading loading-spinner loading-xs" />
                    {t('app.running')}
                </>
            ) : (
                <>
                    <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
    );
}
