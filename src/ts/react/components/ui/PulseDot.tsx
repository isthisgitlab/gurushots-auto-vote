import { useSyncExternalStore } from 'react';

/**
 * Small coloured status dot (DaisyUI `status`), optionally with a ping halo so
 * it catches the eye in a long list — used to mark an open boost (info) and
 * low exposure (error). The halo pings a few times when the dot appears and again
 * when the window or page comes back (focus, or becoming visible), then rests
 * under the dot (an endless animation keeps the renderer compositing).
 * `variant` is `info` (blue) or `error` (red), the two meanings a dot carries. Decorative: callers carry the
 * meaning in text (visible or sr-only).
 *
 * On a solid badge or button of its own tone the dot would be the surface's colour and vanish, so `onBadge` draws it
 * in that tone's `-content` colour instead (utilities sit after daisyUI's `status-*`, so the background wins).
 */
const VARIANT_CLASS = {
    info: 'status-info',
    error: 'status-error',
};
const ON_BADGE_CLASS = {
    info: 'bg-info-content',
    error: 'bg-error-content',
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
 * @param props - `size` is a DaisyUI status size class; `onBadge` is set when the dot sits on a solid badge or button
 * of the same tone.
 */
export function PulseDot({
    variant = 'info',
    pulse = true,
    size = 'status-md',
    onBadge = false,
}: {
    variant?: PulseDotVariant;
    pulse?: boolean;
    onBadge?: boolean;
    size?: 'status-xs' | 'status-sm' | 'status-md' | 'status-lg' | 'status-xl';
}) {
    const resolved: PulseDotVariant = variant in VARIANT_CLASS ? variant : 'info';
    const colour = onBadge ? ON_BADGE_CLASS[resolved] : VARIANT_CLASS[resolved];
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
