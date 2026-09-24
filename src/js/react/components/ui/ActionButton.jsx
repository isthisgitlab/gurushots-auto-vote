const VARIANT_CLASSES = {
    accent: 'btn-accent',
    info: 'btn-info',
    success: 'btn-success',
    warning: 'btn-warning',
};

/** Small DaisyUI action button that shows the error variant after a failed action. */
export function ActionButton({ variant, error, className = '', children, ...buttonProps }) {
    const classes = ['btn', 'btn-sm', error ? 'btn-error' : VARIANT_CLASSES[variant], className];

    return (
        <button className={classes.filter(Boolean).join(' ')} {...buttonProps}>
            {children}
        </button>
    );
}
