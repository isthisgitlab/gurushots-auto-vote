import { useTranslation } from '@/contexts/TranslationContext';
import { IconActionButton } from '@/components/ui/IconActionButton';
import { ICON_PATHS } from '@/components/ui/StrokeIcon';

/**
 * Run button for a single challenge — fires one full auto-strategy
 * cycle (boost / turbo / auto-fill / threshold-aware vote) scoped
 * to this card. Distinct from VoteButton which votes-to-100% only.
 */
export function RunButton({ challengeId, onVoteComplete }) {
    const { t } = useTranslation();

    return (
        <IconActionButton
            className="btn btn-latvian btn-xs px-1"
            action={() => window.api.runVotingCycleForChallenge(challengeId)}
            onSuccess={onVoteComplete}
            failureLogPrefix="Run failed"
            errorLogPrefix="Error running cycle"
            loadingLabel={t('app.running')}
            icon={ICON_PATHS.run}
            label={t('app.run')}
        />
    );
}
