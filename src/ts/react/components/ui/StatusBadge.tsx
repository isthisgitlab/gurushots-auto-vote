import { useTranslation } from '@/contexts/TranslationContext';
import { LEVEL_BADGE_CLASS } from '@/utils/levelBadge';
import type { ComponentChildren } from 'preact';

export type StatusBadgeVariant =
    | 'neutral'
    | 'success'
    | 'error'
    | 'warning'
    | 'info'
    | 'ghost'
    | 'popular'
    | 'skilled'
    | 'premier'
    | 'elite'
    | 'allstar';

/**
 * DaisyUI badge component for displaying status
 */
export function StatusBadge({
    children,
    variant = 'neutral',
    size = 'sm',
    className = '',
}: {
    children?: ComponentChildren;
    variant?: StatusBadgeVariant;
    size?: 'xs' | 'sm' | 'md' | 'lg';
    className?: string;
}) {
    const variantClass =
        {
            neutral: 'badge-neutral',
            success: 'badge-success',
            error: 'badge-error',
            warning: 'badge-warning',
            info: 'badge-info',
            ghost: 'badge-ghost',
            // Level badges
            popular: LEVEL_BADGE_CLASS.popular,
            skilled: LEVEL_BADGE_CLASS.skilled,
            premier: LEVEL_BADGE_CLASS.premier,
            elite: LEVEL_BADGE_CLASS.elite,
            allstar: LEVEL_BADGE_CLASS.allstar,
        }[variant] || 'badge-neutral';

    const sizeClass =
        {
            xs: 'badge-xs',
            sm: 'badge-sm',
            md: '',
            lg: 'badge-lg',
        }[size] || 'badge-sm';

    return <span className={['badge', variantClass, sizeClass, className].filter(Boolean).join(' ')}>{children}</span>;
}

/**
 * Connection status badge for log viewer
 */
export function ConnectionBadge({ connected }: { connected: boolean }) {
    const { t } = useTranslation();
    return (
        <StatusBadge variant={connected ? 'success' : 'error'}>
            {connected ? t('logs.connected') : t('logs.disconnected')}
        </StatusBadge>
    );
}
