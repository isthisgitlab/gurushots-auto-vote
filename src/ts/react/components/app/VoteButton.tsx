import type { Challenge } from '../../../types/gurushots';
import { useTranslation } from '@/contexts/TranslationContext';
import { IconActionButton } from '@/components/ui/IconActionButton';
import { ICON_PATHS } from '@/components/ui/StrokeIcon';
import * as ipc from '@/api/ipc';

/**
 * Vote button for a single challenge
 */
export function VoteButton({
    challengeId,
    challengeTitle,
    onVoteComplete,
    onError,
}: {
    challengeId: Challenge['id'];
    challengeTitle: string;
    onVoteComplete: () => void;
    onError: (message: string | null) => void;
}) {
    const { t } = useTranslation();

    return (
        <IconActionButton
            className="btn btn-neutral btn-sm"
            title={t('app.voteTitle')}
            action={() => ipc.voteOnChallengeManual(challengeId, challengeTitle)}
            onSuccess={onVoteComplete}
            onError={onError}
            failureLogPrefix="Voting failed"
            errorLogPrefix="Error voting on challenge"
            loadingLabel={t('app.voting')}
            icon={ICON_PATHS.vote}
            label={t('app.vote')}
        />
    );
}
