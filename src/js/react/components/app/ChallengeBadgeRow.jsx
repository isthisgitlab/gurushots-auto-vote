import { useTranslation } from '@/contexts/TranslationContext';
import { StatusBadge } from '../ui/StatusBadge';
import { PulseDot } from '../ui/PulseDot';

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
    showAutoFillBadge,
    hasCustomSettings,
    showPhotoCount = true,
}) {
    const { t } = useTranslation();
    const showPhotos = showPhotoCount && challenge.max_photo_submits > 1;
    const hasLogicalBadge = Boolean(
        boostOpen || lowExposure || challenge.type || challenge.badge || showPhotos || showAutoFillBadge,
    );

    if (!hasLogicalBadge && !hasCustomSettings) return null;

    return (
        <div className="flex flex-wrap items-center gap-1 mt-1">
            {boostOpen && (
                <span className="badge badge-info badge-sm gap-1 font-semibold">
                    <PulseDot variant="info" size="status-sm" />
                    🚀 {t('app.boostOpenBadge')}
                    {boostTimeLeft && <span>· ⏳ {boostTimeLeft}</span>}
                </span>
            )}
            {lowExposure && (
                <span className="badge badge-error badge-sm gap-1 font-semibold">
                    <PulseDot variant="error" pulse={exposureFactor === 0} size="status-sm" />
                    👁 {t('app.exposure')} {exposureFactor}%
                </span>
            )}
            {challenge.type && (
                <StatusBadge variant="warning" size="xs">
                    🏁 {challenge.type.toUpperCase()}
                </StatusBadge>
            )}
            {!challenge.type && challenge.badge && (
                <StatusBadge variant="info" size="xs">
                    🏁 {challenge.badge}
                </StatusBadge>
            )}
            {showPhotos && (
                <StatusBadge variant="warning" size="xs">
                    🖼 {challenge.max_photo_submits} {t('app.photos')}
                </StatusBadge>
            )}
            {showAutoFillBadge && (
                <StatusBadge variant="success" size="xs">
                    📥 {t('app.autoFillBadge')}
                </StatusBadge>
            )}
            {hasLogicalBadge && hasCustomSettings && (
                <span data-testid="badge-divider" className="w-px h-3 bg-base-300 mx-0.5 self-center" />
            )}
            {hasCustomSettings && (
                <StatusBadge variant="ghost" size="xs">
                    ⚙️ {t('app.customBadge')}
                </StatusBadge>
            )}
        </div>
    );
}
