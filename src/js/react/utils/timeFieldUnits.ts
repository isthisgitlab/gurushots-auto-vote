/**
 * Pure helpers for the `type: 'time'` setting input. Stored value is seconds;
 * the GUI exposes hours+minutes fields. These helpers keep the conversion in
 * one place so it can be unit-tested without rendering React.
 */

/**
 * @param totalSeconds - null/undefined/NaN read as 0.
 */
export const secondsToHoursMinutes = (totalSeconds: number | null | undefined): { hours: number; minutes: number } => {
    const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    return {
        hours: Math.floor(safe / 3600),
        minutes: Math.floor((safe % 3600) / 60),
    };
};

/**
 * @param hours - NaN reads as 0.
 * @param minutes - NaN reads as 0; clamped to 0–59.
 */
export const hoursMinutesToSeconds = (hours: number, minutes: number): number => {
    const h = Math.max(0, Math.floor(Number(hours) || 0));
    const m = Math.max(0, Math.min(59, Math.floor(Number(minutes) || 0)));
    return h * 3600 + m * 60;
};

// Render a seconds value the same way the hours+minutes input shows it, e.g.
// "0 hours, 12 minutes". Stays pure by taking the unit labels as args (the
// caller passes translated `app.hours` / `app.minutes`) so it can be reused
// for read-only hints without importing the translation layer.
export const formatSecondsAsHoursMinutes = (
    totalSeconds: number | null | undefined,
    hoursLabel: string,
    minutesLabel: string,
): string => {
    const { hours, minutes } = secondsToHoursMinutes(totalSeconds);
    return `${hours} ${hoursLabel}, ${minutes} ${minutesLabel}`;
};
