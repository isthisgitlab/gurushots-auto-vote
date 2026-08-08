import { useTranslation } from '@/contexts/TranslationContext';
import { AsyncActionButton } from '@/components/ui/AsyncActionButton';

/**
 * Vote button for a single challenge
 */
export function VoteButton({ challengeId, challengeTitle, onVoteComplete }) {
    const { t } = useTranslation();

    return (
        <AsyncActionButton
            className="btn btn-latvian btn-sm"
            title={t('app.voteTitle')}
            action={() => window.api.voteOnChallengeManual(challengeId, challengeTitle)}
            onSuccess={onVoteComplete}
            failureLogPrefix="Voting failed"
            errorLogPrefix="Error voting on challenge"
            loadingLabel={t('app.voting')}
            idleContent={
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
            }
        />
    );
}
