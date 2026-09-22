import { useTranslation } from '@/contexts/TranslationContext';
import { lowExposureChallenges } from '@/utils/challengeAlerts';
import { ChipListPanel, ChallengeChip } from './ChallengeChips';
import { PulseDot } from '../ui/PulseDot';

/**
 * Summary placed above the challenge list naming the running challenges whose
 * exposure is at or near zero, lowest first, each chip showing the percentage
 * and scrolling to its card. Renders nothing when none are low. Mirrors
 * BoostWindowBanner. No tick: exposure only changes on a challenge refetch.
 * Filled btn-error (error-content on error) rather than soft/outline, which
 * would paint the label in the raw error colour and lose contrast.
 */
export function LowExposureBanner({ challenges }) {
    const { t } = useTranslation();
    const low = lowExposureChallenges(challenges, Math.floor(Date.now() / 1000));

    if (low.length === 0) return null;

    return (
        <ChipListPanel icon="👁" label={t('app.lowExposure')} count={low.length}>
            {low.map((c) => (
                <ChallengeChip key={c.id} challengeId={c.id} className="btn-error">
                    <PulseDot variant="error" pulse={c.exposure === 0} size="status-sm" />
                    <span>{c.title}</span>
                    <span className="font-semibold">· {c.exposure}%</span>
                </ChallengeChip>
            ))}
        </ChipListPanel>
    );
}
