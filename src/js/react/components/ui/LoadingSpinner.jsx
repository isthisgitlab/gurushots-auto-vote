/**
 * DaisyUI loading spinner component
 */
export function LoadingSpinner({ size = 'md', className = '' }) {
    const sizeClass =
        {
            xs: 'loading-xs',
            sm: 'loading-sm',
            md: 'loading-md',
            lg: 'loading-lg',
        }[size] || 'loading-md';

    return <span className={`loading loading-spinner ${sizeClass} ${className}`} aria-label="Loading" />;
}

/**
 * Full-page loading state with centered spinner and optional text
 */
export function PageLoader({ text }) {
    return (
        <div className="flex flex-col justify-center items-center min-h-screen bg-base-200">
            <LoadingSpinner size="lg" />
            {text && <span className="mt-4 text-base-content/70">{text}</span>}
        </div>
    );
}

/**
 * Inline loading state for smaller areas
 */
export function InlineLoader({ text }) {
    return (
        <div className="flex justify-center items-center py-4">
            <LoadingSpinner size="sm" />
            {text && <span className="ml-2 text-sm">{text}</span>}
        </div>
    );
}
