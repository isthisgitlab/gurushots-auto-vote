import type { ComponentChildren, JSX } from 'preact';
const VARIANT_CLASSES = {
    accent: 'btn-accent',
    info: 'btn-info',
    success: 'btn-success',
    warning: 'btn-warning',
};

export type ActionButtonVariant = keyof typeof VARIANT_CLASSES;

/**
 * Small DaisyUI action button that shows the error variant after a failed action.
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
    const classes = ['btn', 'btn-sm', error ? 'btn-error' : VARIANT_CLASSES[variant], className];

    return (
        <button className={classes.filter(Boolean).join(' ')} {...buttonProps}>
            {children}
        </button>
    );
}
