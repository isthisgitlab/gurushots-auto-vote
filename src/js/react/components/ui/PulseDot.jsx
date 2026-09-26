/**
 * Small coloured status dot (DaisyUI `status`), optionally with a ping halo so
 * it catches the eye in a long list — used to mark an open boost (info) and
 * low exposure (error). `variant` is a DaisyUI status colour name. Decorative:
 * callers carry the meaning in text (visible or sr-only).
 */
const VARIANT_CLASS = {
    info: 'status-info',
    error: 'status-error',
    warning: 'status-warning',
    success: 'status-success',
};

/** @typedef {keyof typeof VARIANT_CLASS} PulseDotVariant */

/**
 * @param {{
 *   variant?: PulseDotVariant,
 *   pulse?: boolean,
 *   size?: 'status-xs'|'status-sm'|'status-md'|'status-lg'|'status-xl',
 * }} props - `size` is a DaisyUI status size class.
 */
export function PulseDot({ variant = 'info', pulse = true, size = 'status-md' }) {
    const colour = VARIANT_CLASS[variant] || VARIANT_CLASS.info;
    return (
        <span
            className="inline-grid *:[grid-area:1/1] align-middle"
            aria-hidden="true"
            data-testid={`pulse-dot-${variant}`}
        >
            {pulse && <span className={`status ${size} ${colour} animate-ping`} />}
            <span className={`status ${size} ${colour}`} />
        </span>
    );
}
