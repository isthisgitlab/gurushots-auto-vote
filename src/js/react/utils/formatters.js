/**
 * Time and display formatting utilities
 * Ported from src/js/ui/formatters.js - pure functions only
 */

import { formatSecondsAsHoursMinutes } from './timeFieldUnits';
import { formatDuration } from '../../format/duration';

// Re-exported from the shared core so the renderer, the CLI, and api/main all
// format durations identically — see src/js/format/duration.js.
export { formatDuration };

/**
 * Format a setting value for the read-only "Global default" hint so it reads
 * the same way SettingInput renders the editable value: schedule rows as
 * "count ≤ Xh Ym" (before the generic array join, which would print
 * [object Object] for them), hours+minutes for `time` settings (stored as
 * seconds), `value unit` for unit-bearing numbers, and a comma-joined list
 * (or the "none" label) for tag arrays. Everything else falls back to
 * `String(value)`.
 *
 * `t` is the translation function, passed in so this stays a pure util with no
 * dependency on the React translation context.
 *
 * @param {*} value - The value to render (seconds, number, boolean, or array)
 * @param {object} config - The setting's schema entry (reads `type` and `unit`)
 * @param {(key: string) => string} t - Translation lookup
 * @returns {string}
 */
export const formatSettingDefault = (value, config, t) => {
    if (config?.type === 'schedule') {
        const rows = Array.isArray(value) ? value : [];
        if (rows.length === 0) return t('app.none');
        return rows
            .slice()
            .sort((a, b) => (a?.count ?? 0) - (b?.count ?? 0))
            .map(
                (row) =>
                    `${row?.count} ≤ ${formatSecondsAsHoursMinutes(row?.seconds, t('app.hours'), t('app.minutes'))}`,
            )
            .join(', ');
    }
    if (Array.isArray(value)) {
        return value.join(', ') || t('app.none');
    }
    if (config?.type === 'time') {
        return formatSecondsAsHoursMinutes(value, t('app.hours'), t('app.minutes'));
    }
    if (config?.type === 'number' && config.unit) {
        return `${value} ${t(config.unit)}`;
    }
    return String(value);
};

/**
 * Format time remaining from Unix timestamp
 * @param {number} endTime - Unix timestamp of end time
 * @returns {string} Formatted time remaining (e.g., "2d 3h 5m", "30m 45s", "Ended")
 */
export const formatTimeRemaining = (endTime) => {
    const now = Math.floor(Date.now() / 1000);
    const remaining = endTime - now;

    if (remaining <= 0) {
        return 'Ended';
    }

    return formatDuration(remaining, { includeSeconds: true });
};

/**
 * Format end time to localized string
 * @param {number} endTime - Unix timestamp
 * @param {string} timezone - Timezone string (e.g., 'local', 'Europe/Riga')
 * @returns {string} Formatted date string
 */
export const formatEndTime = (endTime, timezone = 'local') => {
    const date = new Date(endTime * 1000);

    const formatOptions = {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    };

    if (timezone === 'local') {
        return date.toLocaleString('lv-LV', formatOptions);
    } else {
        try {
            return date.toLocaleString('lv-LV', {
                ...formatOptions,
                timeZone: timezone,
            });
        } catch {
            // Fallback to local on invalid timezone
            return date.toLocaleString('lv-LV', formatOptions);
        }
    }
};

/**
 * Get boost status with display text and color class
 * @param {object} boost - Boost object from API
 * @returns {{ text: string, colorClass: string }}
 */
export const getBoostStatus = (boost) => {
    if (!boost || !boost.state) {
        return { text: 'Unknown', colorClass: 'text-purple-500' };
    }

    if (boost.state === 'AVAILABLE' || boost.state === 'AVAILABLE_KEY') {
        const now = Math.floor(Date.now() / 1000);
        const remaining = boost.timeout - now;
        if (remaining > 0) {
            const minutes = Math.floor(remaining / 60);
            return { text: `Available (${minutes}m left)`, colorClass: 'text-blue-500' };
        } else {
            return { text: 'Available', colorClass: 'text-blue-500' };
        }
    } else if (boost.state === 'USED') {
        return { text: 'Used', colorClass: 'text-green-500' };
    } else if (boost.state === 'UNAVAILABLE') {
        return { text: 'Unavailable', colorClass: 'text-red-500' };
    } else if (boost.state === 'LOCKED') {
        return { text: 'Locked', colorClass: 'text-red-500' };
    } else {
        return { text: boost.state || 'Unknown', colorClass: 'text-purple-500' };
    }
};

/**
 * Whether a challenge's boost window is currently open (boost can be applied
 * right now). Mirrors the voting engine's predicate
 * (services/VotingLogic.js:isBoostWindowOpen) but takes the boost object +
 * `now` so it stays a pure renderer util with no Node/service dependency:
 *   - AVAILABLE_KEY (key-unlocked) → open, no expiry
 *   - AVAILABLE → open while a positive timeout is still in the future;
 *     AVAILABLE without a timeout is treated as key-unlocked (open)
 *   - anything else → closed
 * @param {object} boost - Boost object from API (challenge.member.boost)
 * @param {number} now - Current time (Unix seconds)
 * @returns {boolean}
 */
export const isBoostWindowOpen = (boost, now) => {
    if (!boost || !boost.state) return false;
    if (boost.state === 'AVAILABLE_KEY') return true;
    if (boost.state === 'AVAILABLE') {
        const hasTimeout = typeof boost.timeout === 'number' && boost.timeout > 0;
        return hasTimeout ? boost.timeout > now : true;
    }
    return false;
};

/**
 * Get turbo status with display text and color class
 * @param {object} turbo - Turbo object from API
 * @returns {{ text: string, colorClass: string }}
 */
export const getTurboStatus = (turbo) => {
    if (!turbo || !turbo.state) {
        return { text: 'Unavailable', colorClass: 'text-red-500' };
    }

    switch (turbo.state) {
        case 'FREE':
            return { text: 'Free', colorClass: 'text-blue-400' };
        case 'TIMER':
            return { text: 'Timer', colorClass: 'text-red-500' };
        case 'IN_PROGRESS':
            return { text: 'In Progress', colorClass: 'text-orange-500' };
        case 'WON':
            return { text: 'Won', colorClass: 'text-lime-800' };
        case 'USED':
            return { text: 'Used', colorClass: 'text-green-500' };
        case 'UNAVAILABLE':
            return { text: 'Unavailable', colorClass: 'text-red-500' };
        case 'LOCKED':
            return { text: 'Locked', colorClass: 'text-latvian' };
        default:
            return { text: turbo.state || 'Unknown', colorClass: 'text-purple-500' };
    }
};

/**
 * Get level status with display text and badge color class
 * @param {number} level - Level number
 * @param {string} levelName - Level name (e.g., 'POPULAR', 'SKILLED')
 * @returns {{ text: string, colorClass: string }}
 */
export const getLevelStatus = (level, levelName) => {
    if (!level || !levelName) {
        return { text: 'Unknown', colorClass: 'badge-success' };
    }

    switch (levelName.toUpperCase()) {
        case 'POPULAR':
            return { text: `${levelName} ${level}`, colorClass: 'badge-popular' };
        case 'SKILLED':
            return { text: `${levelName} ${level}`, colorClass: 'badge-skilled' };
        case 'PREMIER':
            return { text: `${levelName} ${level}`, colorClass: 'badge-premier' };
        case 'ELITE':
            return { text: `${levelName} ${level}`, colorClass: 'badge-elite' };
        case 'ALL STAR':
            return { text: `${levelName} ${level}`, colorClass: 'badge-allstar' };
        default:
            return { text: `${levelName} ${level}`, colorClass: 'badge-warning' };
    }
};

/**
 * Check if time remaining is in "warning" zone (less than 1 hour)
 * @param {number} endTime - Unix timestamp
 * @returns {boolean}
 */
export const isTimeWarning = (endTime) => {
    const now = Math.floor(Date.now() / 1000);
    const remaining = endTime - now;
    return remaining > 0 && remaining < 3600; // Less than 1 hour
};

/**
 * Check if challenge has ended
 * @param {number} endTime - Unix timestamp
 * @returns {boolean}
 */
export const hasEnded = (endTime) => {
    const now = Math.floor(Date.now() / 1000);
    return endTime <= now;
};
