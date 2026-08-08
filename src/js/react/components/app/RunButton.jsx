import { useTranslation } from '@/contexts/TranslationContext';
import { AsyncActionButton } from '@/components/ui/AsyncActionButton';

/**
 * Run button for a single challenge — fires one full auto-strategy
 * cycle (boost / turbo / auto-fill / threshold-aware vote) scoped
 * to this card. Distinct from VoteButton which votes-to-100% only.
 */
export function RunButton({ challengeId, onVoteComplete }) {
    const { t } = useTranslation();

    return (
        <AsyncActionButton
            className="btn btn-latvian btn-xs px-1"
            action={() => window.api.runVotingCycleForChallenge(challengeId)}
            onSuccess={onVoteComplete}
            failureLogPrefix="Run failed"
            errorLogPrefix="Error running cycle"
            loadingLabel={t('app.running')}
            idleContent={
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
            }
        />
    );
}
