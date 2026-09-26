import { useTranslation } from '@/contexts/TranslationContext';

/**
 * @typedef {'neutral'|'success'|'error'|'warning'|'info'|'ghost'|'primary'|'secondary'|'accent'
 *   |'popular'|'skilled'|'premier'|'elite'|'allstar'} StatusBadgeVariant
 */

/**
 * DaisyUI badge component for displaying status
 *
 * @param {{
 *   children?: import('preact').ComponentChildren,
 *   variant?: StatusBadgeVariant,
 *   size?: 'xs'|'sm'|'md'|'lg',
 *   className?: string,
 * }} props
 */
export function StatusBadge({ children, variant = 'neutral', size = 'sm', className = '' }) {
    const variantClass =
        {
            neutral: 'badge-neutral',
            success: 'badge-success',
            error: 'badge-error',
            warning: 'badge-warning',
            info: 'badge-info',
            ghost: 'badge-ghost',
            primary: 'badge-primary',
            secondary: 'badge-secondary',
            accent: 'badge-accent',
            // Level badges
            popular: 'badge-popular',
            skilled: 'badge-skilled',
            premier: 'badge-premier',
            elite: 'badge-elite',
            allstar: 'badge-allstar',
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
 *
 * @param {{ connected: boolean }} props
 */
export function ConnectionBadge({ connected }) {
    const { t } = useTranslation();
    return (
        <StatusBadge variant={connected ? 'success' : 'error'}>
            {connected ? t('logs.connected') : t('logs.disconnected')}
        </StatusBadge>
    );
}
