import { useTranslation } from '@/contexts/TranslationContext';
import { StatusBadge } from '../ui/StatusBadge';
import { PulseDot } from '../ui/PulseDot';
import { ChallengeKindBadges } from './ChallengeKindBadges';
import { challengeKind, challengePhotoCount } from '../../../format/challengeListing';

import type { Challenge } from '../../../types/gurushots';
import type { ChallengeCardView } from './ChallengeCard';

export type ChallengeBadgeRowProps = Pick<
    ChallengeCardView,
    'boostOpen' | 'boostTimeLeft' | 'lowExposure' | 'exposureFactor' | 'showAutoSubmitBadge' | 'showManualPhotosBadge'
> & {
    challenge: Challenge;
    hasCustomSettings: boolean;
    showPhotoCount?: boolean;
};

/**
 * Challenge badge row, shared by the detailed card and the compact tile.
 *
 * Two categories: "logical/state" badges that reflect live challenge/automation
 * state, and an "override/config" badge that marks user-configured overrides.
 * They are styled differently (solid vs muted ghost) and separated so a config
 * marker is never mistaken for a live state. The two at-a-glance alerts (open
 * boost window, low exposure — see utils/challengeAlerts) lead the state group
 * and stay in the compact tile, where standing out without reading is the point.
 *
 * `boostTimeLeft` (preformatted, e.g. "23m") is shown in the boost badge for a
 * timed window — the tile's boost cell truncates, so the badge carries it.
 *
 * `showPhotoCount` is off in the compact tile, where the entries cell already
 * reads N/max and the "N photos" badge would only repeat the max.
 */
export function ChallengeBadgeRow({
    challenge,
    boostOpen,
    boostTimeLeft,
    lowExposure,
    exposureFactor,
    showAutoSubmitBadge,
    showManualPhotosBadge,
    hasCustomSettings,
    showPhotoCount = true,
}: ChallengeBadgeRowProps) {
    const { t } = useTranslation();
    const showPhotos = showPhotoCount && challengePhotoCount(challenge) !== null;
    const hasLogicalBadge = Boolean(
        boostOpen ||
        lowExposure ||
        challengeKind(challenge) ||
        showPhotos ||
        showAutoSubmitBadge ||
        showManualPhotosBadge,
    );

    if (!hasLogicalBadge && !hasCustomSettings) return null;

    return (
        <div className="flex flex-wrap items-center gap-1 mt-1">
            {boostOpen && (
                <StatusBadge variant="info" className="gap-1 font-semibold">
                    <PulseDot variant="info" size="status-sm" />
                    🚀 {t('app.boostOpenBadge')}
                    {boostTimeLeft && <span>· ⏳ {boostTimeLeft}</span>}
                </StatusBadge>
            )}
            {lowExposure && (
                <StatusBadge variant="error" className="gap-1 font-semibold">
                    <PulseDot variant="error" pulse={exposureFactor === 0} size="status-sm" />
                    👁 {t('app.exposure')} {exposureFactor}%
                </StatusBadge>
            )}
            <ChallengeKindBadges challenge={challenge} showPhotoCount={showPhotoCount} />
            {showAutoSubmitBadge && <StatusBadge variant="success">📥 {t('app.autoSubmitBadge')}</StatusBadge>}
            {showManualPhotosBadge && <StatusBadge variant="info">✋ {t('app.manualPhotosBadge')}</StatusBadge>}
            {hasLogicalBadge && hasCustomSettings && (
                <span data-testid="badge-divider" className="w-px h-3 bg-base-300 mx-0.5 self-center" />
            )}
            {hasCustomSettings && <StatusBadge variant="ghost">⚙️ {t('app.customBadge')}</StatusBadge>}
        </div>
    );
}
