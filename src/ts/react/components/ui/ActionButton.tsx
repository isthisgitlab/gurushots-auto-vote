import { ICON_PATHS, StrokeIcon } from './StrokeIcon';

import type { ComponentChildren, JSX } from 'preact';

const VARIANT_CLASSES = {
    neutral: 'btn-neutral',
    cost: 'btn-latvian',
};

export type ActionButtonVariant = keyof typeof VARIANT_CLASSES;

/**
 * Small DaisyUI action button that shows the error variant after a failed action: solid `btn-error` (outline would
 * paint the label in the raw error colour) behind an error icon, so it no longer reads like the idle solid-red
 * `btn-latvian` once colour is set aside.
 * Every other prop passes straight through to the <button>.
 *
 * @param props - `error` is truthy after a failed action (the value itself is not rendered).
 */
export function ActionButton({
    variant,
    error,
    className = '',
    children,
    ...buttonProps
}: Omit<JSX.IntrinsicElements['button'], 'className'> & {
    variant: ActionButtonVariant;
    error?: unknown;
    className?: string;
    children?: ComponentChildren;
}) {
    const classes = [
        'btn',
        'btn-sm',
        'h-auto',
        'min-h-8',
        'py-1',
        'leading-tight',
        error ? 'btn-error' : VARIANT_CLASSES[variant],
        className,
    ];

    return (
        <button className={classes.filter(Boolean).join(' ')} {...buttonProps}>
            {error ? <StrokeIcon d={ICON_PATHS.xCircle} className="w-4 h-4 shrink-0" /> : null}
            {children}
        </button>
    );
}
