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
 * Spinner plus optional caption, laid out by the caller's wrapper classes.
 */
function CaptionedSpinner({ className, size, textClassName, text }) {
    return (
        <div className={className}>
            <LoadingSpinner size={size} />
            {text && <span className={textClassName}>{text}</span>}
        </div>
    );
}

/**
 * Full-page loading state with centered spinner and optional text
 */
export function PageLoader({ text }) {
    return (
        <CaptionedSpinner
            className="flex flex-col justify-center items-center min-h-screen bg-base-200"
            size="lg"
            textClassName="mt-4 text-base-content/70"
            text={text}
        />
    );
}

/**
 * Inline loading state for smaller areas
 */
export function InlineLoader({ text }) {
    return (
        <CaptionedSpinner
            className="flex justify-center items-center py-4"
            size="sm"
            textClassName="ml-2 text-sm"
            text={text}
        />
    );
}
