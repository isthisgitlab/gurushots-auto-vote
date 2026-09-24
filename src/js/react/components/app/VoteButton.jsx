import { useTranslation } from '@/contexts/TranslationContext';
import { IconActionButton } from '@/components/ui/IconActionButton';
import { ICON_PATHS } from '@/components/ui/StrokeIcon';

/**
 * Vote button for a single challenge
 */
export function VoteButton({ challengeId, challengeTitle, onVoteComplete }) {
    const { t } = useTranslation();

    return (
        <IconActionButton
            className="btn btn-latvian btn-sm"
            title={t('app.voteTitle')}
            action={() => window.api.voteOnChallengeManual(challengeId, challengeTitle)}
            onSuccess={onVoteComplete}
            failureLogPrefix="Voting failed"
            errorLogPrefix="Error voting on challenge"
            loadingLabel={t('app.voting')}
            icon={ICON_PATHS.vote}
            label={t('app.vote')}
        />
    );
}
