/** @import { Challenge } from '../../../types/gurushots' */
import { useTranslation } from '@/contexts/TranslationContext';
import { lowExposureChallenges } from '@/utils/challengeAlerts';
import { ChallengeAlertPanel } from './ChallengeChips';

/** @param {{ exposure: number }} c */
const pulseAtZero = (c) => c.exposure === 0;
/** @param {{ exposure: number }} c */
const exposureDetail = (c) => <span className="font-semibold">· {c.exposure}%</span>;

/**
 * Summary placed above the challenge list naming the running challenges whose
 * exposure is at or near zero, lowest first, each chip showing the percentage
 * and scrolling to its card. Renders nothing when none are low. Mirrors
 * BoostWindowBanner. No tick: exposure only changes on a challenge refetch.
 * Filled btn-error (error-content on error) rather than soft/outline, which
 * would paint the label in the raw error colour and lose contrast.
 *
 * @param {{ challenges: Challenge[] }} props
 */
export function LowExposureBanner({ challenges }) {
    const { t } = useTranslation();

    return (
        <ChallengeAlertPanel
            icon="👁"
            label={t('app.lowExposure')}
            items={lowExposureChallenges(challenges, Math.floor(Date.now() / 1000))}
            chipClassName="btn-error"
            dotVariant="error"
            pulse={pulseAtZero}
            detail={exposureDetail}
        />
    );
}
