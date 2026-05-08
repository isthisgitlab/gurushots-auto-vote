/**
 * DaisyUI badge component for displaying status
 */
export function StatusBadge({ children, variant = 'neutral', size = 'md', className = '' }) {
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
        }[size] || '';

    return <span className={`badge ${variantClass} ${sizeClass} ${className}`}>{children}</span>;
}

/**
 * Connection status badge for log viewer
 */
export function ConnectionBadge({ connected }) {
    return (
        <StatusBadge variant={connected ? 'success' : 'error'} size="sm">
            {connected ? 'Connected' : 'Disconnected'}
        </StatusBadge>
    );
}

/**
 * Mock mode status badge
 */
export function MockStatusBadge({ isMock }) {
    return (
        <StatusBadge variant={isMock ? 'warning' : 'success'} size="sm">
            {isMock ? 'ON' : 'OFF'}
        </StatusBadge>
    );
}
