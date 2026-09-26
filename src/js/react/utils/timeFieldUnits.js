/**
 * Pure helpers for the `type: 'time'` setting input. Stored value is seconds;
 * the GUI exposes hours+minutes fields. These helpers keep the conversion in
 * one place so it can be unit-tested without rendering React.
 */

/**
 * @param {number | null | undefined} totalSeconds - null/undefined/NaN read as 0.
 * @returns {{ hours: number, minutes: number }}
 */
export const secondsToHoursMinutes = (totalSeconds) => {
    const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    return {
        hours: Math.floor(safe / 3600),
        minutes: Math.floor((safe % 3600) / 60),
    };
};

/**
 * @param {number} hours - NaN reads as 0.
 * @param {number} minutes - NaN reads as 0; clamped to 0–59.
 * @returns {number}
 */
export const hoursMinutesToSeconds = (hours, minutes) => {
    const h = Math.max(0, Math.floor(Number(hours) || 0));
    const m = Math.max(0, Math.min(59, Math.floor(Number(minutes) || 0)));
    return h * 3600 + m * 60;
};

// Render a seconds value the same way the hours+minutes input shows it, e.g.
// "0 hours, 12 minutes". Stays pure by taking the unit labels as args (the
// caller passes translated `app.hours` / `app.minutes`) so it can be reused
// for read-only hints without importing the translation layer.
/**
 * @param {number | null | undefined} totalSeconds
 * @param {string} hoursLabel
 * @param {string} minutesLabel
 * @returns {string}
 */
export const formatSecondsAsHoursMinutes = (totalSeconds, hoursLabel, minutesLabel) => {
    const { hours, minutes } = secondsToHoursMinutes(totalSeconds);
    return `${hours} ${hoursLabel}, ${minutes} ${minutesLabel}`;
};
