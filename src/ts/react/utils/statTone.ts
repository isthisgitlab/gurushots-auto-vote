/**
 * The colour a challenge stat reads in: good = success, caution = warning, danger = error. Pure and
 * dependency-free, shared by the detailed card and the compact tile.
 */
export type StatTone = 'success' | 'warning' | 'error';

// Whole minutes on purpose: above an hour the countdown text changes only once a minute, and it changes at exactly
// these two boundaries (`1h 0m` -> `59m 59s`, `6h 0m` -> `5h 59m`), so the colour flips with the text.
const ERROR_BELOW_SECONDS = 3600;
const WARNING_BELOW_SECONDS = 21600;

/**
 * The tone of the time left: red under an hour, yellow under six hours, green beyond.
 *
 * @param closeTime - Challenge close (Unix seconds)
 * @param nowSec - Current time in whole Unix seconds, the clock the countdown text uses
 */
export const timeLeftTone = (closeTime: number, nowSec: number): StatTone => {
    const remaining = closeTime - nowSec;
    if (remaining < ERROR_BELOW_SECONDS) return 'error';
    return remaining < WARNING_BELOW_SECONDS ? 'warning' : 'success';
};

/**
 * The tone of a live exposure figure above the low-exposure flag: yellow under 50%, green from 50%. The red band
 * is `isLowExposure`'s, so it keeps one source.
 *
 * @param factor - Exposure percentage
 */
export const exposureBand = (factor: number): StatTone => (factor < 50 ? 'warning' : 'success');

type BadgeTone = StatTone | 'info';
type BadgeSize = 'md' | 'sm';

// The md badge is `h-auto` so a long countdown (Latvian `2d 3h 5min`) or boost/turbo status in a narrow cell wraps to
// two lines instead of spilling out of daisyUI's fixed badge height.
const BADGE_CLASS: Record<BadgeSize, Record<BadgeTone, string>> = {
    md: {
        success: 'badge h-auto badge-success',
        warning: 'badge h-auto badge-warning',
        error: 'badge h-auto badge-error',
        info: 'badge h-auto badge-info',
    },
    sm: {
        success: 'badge badge-sm badge-success',
        warning: 'badge badge-sm badge-warning',
        error: 'badge badge-sm badge-error',
        info: 'badge badge-sm badge-info',
    },
};

const STATUS_TONE = new Map<string, BadgeTone>([
    ['text-info', 'info'],
    ['text-success', 'success'],
    ['text-warning', 'warning'],
    ['text-error', 'error'],
]);

/**
 * The daisyUI badge classes for a tone, or an empty string when there is no tone (nothing to colour).
 *
 * @param tone - The stat's tone, or null for none
 * @param size - Badge size
 */
export const toneBadgeClass = (tone: StatTone | null, size: BadgeSize): string =>
    tone === null ? '' : BADGE_CLASS[size][tone];

/**
 * A boost or turbo status as a badge when its text colour is a tone, else the colour class unchanged: a muted state
 * such as "Locked" stays muted text.
 *
 * @param colorClass - The status's text colour class from the formatters
 * @param size - Badge size
 */
export const statusBadgeClass = (colorClass: string, size: BadgeSize): string => {
    const tone = STATUS_TONE.get(colorClass);
    return tone === undefined ? colorClass : BADGE_CLASS[size][tone];
};
