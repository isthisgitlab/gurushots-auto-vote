import { useTranslation } from '@/contexts/TranslationContext';

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
            <svg
                className="w-3 h-3 mr-1"
                fill={hasOverride ? 'currentColor' : 'none'}
                stroke="currentColor"
                viewBox="0 0 24 24"
            >
                {isCompact ? (
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
                    />
                ) : (
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M9 9V4M9 9H4M9 9L4 4m11 5h5m-5 0V4m0 5l5-5M9 15v5m0-5H4m5 0l-5 5m11-5h5m-5 0v5m0-5l5 5"
                    />
                )}
            </svg>
            {isCompact ? t('app.details') : t('app.compact')}
        </button>
    );
}
