import { useTranslation } from '@/contexts/TranslationContext';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';

/**
 * Per-card density toggle, rendered by both the detailed card and the compact
 * tile — it is the compact tile's only control.
 *
 * The label names the ACTION, not the current state: a compact card reads
 * "Details" (click to expand). The icon is filled when this card carries its
 * own override, so cards that diverge from the global default are visible at
 * a glance.
 */
export function CardDensityToggle({ isCompact, hasOverride, onToggle }) {
    const { t } = useTranslation();
    return (
        <button className="btn btn-ghost btn-xs px-1 shrink-0" onClick={onToggle}>
            <StrokeIcon
                d={isCompact ? ICON_PATHS.expand : ICON_PATHS.collapse}
                className="w-3 h-3 mr-1"
                filled={hasOverride}
            />
            {isCompact ? t('app.details') : t('app.compact')}
        </button>
    );
}
