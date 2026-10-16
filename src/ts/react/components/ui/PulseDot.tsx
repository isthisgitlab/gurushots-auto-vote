import { useSyncExternalStore } from 'react';

/**
 * Small coloured status dot (DaisyUI `status`), optionally with a ping halo so
 * it catches the eye in a long list — used to mark an open boost (info) and
 * low exposure (error). The halo pings a few times when the dot appears and again
 * when the window or page comes back (focus, or becoming visible), then rests
 * under the dot (an endless animation keeps the renderer compositing).
 * `variant` is a DaisyUI status colour name. Decorative: callers carry the
 * meaning in text (visible or sr-only).
 */
const VARIANT_CLASS = {
    info: 'status-info',
    error: 'status-error',
    warning: 'status-warning',
    success: 'status-success',
};

export type PulseDotVariant = keyof typeof VARIANT_CLASS;

// When the window or page last came back (focus, or the page becoming visible). Focus is
// listened to as well because a window with background throttling off never reports itself
// hidden. Every subscriber's handler sees the same event, so writing its timeStamp is
// idempotent however many dots listen.
let shownAt = 0;
function subscribeToShown(onChange: () => void) {
    const handler = (event: Event) => {
        if (document.visibilityState !== 'visible') return;
        shownAt = event.timeStamp;
        onChange();
    };
    document.addEventListener('visibilitychange', handler);
    window.addEventListener('focus', handler);
    return () => {
        document.removeEventListener('visibilitychange', handler);
        window.removeEventListener('focus', handler);
    };
}
const readShownAt = () => shownAt;

/**
 * @param props - `size` is a DaisyUI status size class.
 */
export function PulseDot({
    variant = 'info',
    pulse = true,
    size = 'status-md',
}: {
    variant?: PulseDotVariant;
    pulse?: boolean;
    size?: 'status-xs' | 'status-sm' | 'status-md' | 'status-lg' | 'status-xl';
}) {
    const colour = VARIANT_CLASS[variant] || VARIANT_CLASS.info;
    const shown = useSyncExternalStore(subscribeToShown, readShownAt);
    return (
        <span
            className="inline-grid *:[grid-area:1/1] align-middle"
            aria-hidden="true"
            data-testid={`pulse-dot-${variant}`}
        >
            {pulse && (
                <span
                    key={shown}
                    className={`status ${size} ${colour} motion-safe:animate-[ping_1s_cubic-bezier(0,0,0.2,1)_3]`}
                />
            )}
            <span className={`status ${size} ${colour}`} />
        </span>
    );
}
