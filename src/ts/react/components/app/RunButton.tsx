import type { Challenge } from '../../../types/gurushots';
import { useTranslation } from '@/contexts/TranslationContext';
import { IconActionButton } from '@/components/ui/IconActionButton';
import { ICON_PATHS } from '@/components/ui/StrokeIcon';
import * as ipc from '@/api/ipc';

/**
 * Run button for a single challenge — fires one full auto-strategy
 * cycle (boost / turbo / auto-fill / threshold-aware vote) scoped
 * to this card. Distinct from VoteButton which votes-to-100% only.
 */
export function RunButton({
    challengeId,
    onVoteComplete,
    onError,
}: {
    challengeId: Challenge['id'];
    onVoteComplete: () => void;
    onError: (message: string | null) => void;
}) {
    const { t } = useTranslation();

    return (
        <IconActionButton
            className="btn btn-neutral btn-sm max-sm:min-h-10"
            action={() => ipc.runVotingCycleForChallenge(challengeId)}
            onSuccess={onVoteComplete}
            onError={onError}
            failureLogPrefix="Run failed"
            errorLogPrefix="Error running cycle"
            loadingLabel={t('app.running')}
            icon={ICON_PATHS.run}
            label={t('app.run')}
        />
    );
}
