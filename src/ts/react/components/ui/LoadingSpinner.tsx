import { rendererTranslator } from '../../../translations/renderer';

import type { ComponentChildren } from 'preact';

export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg';

/**
 * DaisyUI loading spinner. It is a status region named "Loading" by default. A spinner that sits beside text saying
 * what is loading (or inside a button that says what it does) is `decorative`: hidden from assistive tech, so it is
 * not announced twice. Translated through the page translator, not a hook: the page loaders render before any
 * provider.
 */
export function LoadingSpinner({
    size = 'md',
    className = '',
    decorative = false,
}: {
    size?: SpinnerSize;
    className?: string;
    decorative?: boolean;
}) {
    const sizeClass =
        {
            xs: 'loading-xs',
            sm: 'loading-sm',
            md: 'loading-md',
            lg: 'loading-lg',
        }[size] || 'loading-md';

    const classes = `loading loading-spinner ${sizeClass} ${className}`;
    if (decorative) return <span className={classes} aria-hidden="true" />;
    return <span className={classes} role="status" aria-label={rendererTranslator.t('common.loading')} />;
}

/**
 * The content of a button that swaps its label for a spinner while busy. The label stays in the accessibility tree
 * (visually hidden) so the button keeps its name; put `aria-busy={busy}` on the button itself.
 *
 * @param props.label - the button's name, shown by the spinner as hidden text
 * @param props.children - what the button shows when idle (defaults to the label)
 */
export function BusyContent({ busy, label, children }: { busy: boolean; label: string; children?: ComponentChildren }) {
    if (!busy) return <>{children ?? label}</>;
    return (
        <>
            <LoadingSpinner size="xs" decorative />
            <span className="sr-only">{label}</span>
        </>
    );
}

/**
 * Spinner plus optional caption, laid out by the caller's wrapper classes.
 */
function CaptionedSpinner({
    className,
    size,
    textClassName,
    text,
}: {
    className: string;
    size: SpinnerSize;
    textClassName: string;
    text?: string;
}) {
    return (
        // With a caption the caption is the status; the spinner beside it is decorative.
        <div className={className} role={text ? 'status' : undefined}>
            <LoadingSpinner size={size} decorative={!!text} />
            {text && <span className={textClassName}>{text}</span>}
        </div>
    );
}

/**
 * Full-page loading state with centered spinner and optional text
 */
export function PageLoader({ text }: { text?: string }) {
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
export function InlineLoader({ text }: { text?: string }) {
    return (
        <CaptionedSpinner
            className="flex justify-center items-center py-4"
            size="sm"
            textClassName="ml-2 text-sm"
            text={text}
        />
    );
}
