import type { MemberBoost, MemberTurbo, RankingEntry } from '../../types/gurushots';
import type { SerializableSchemaEntry } from '../../ipc/settings.handlers';
/**
 * Time and display formatting utilities (pure functions only)
 */

import { formatSecondsAsHoursMinutes } from './timeFieldUnits';
import { formatDuration } from '../../format/duration';
import { entryPhotoUrl } from '../../format/photoUrl';
import { finiteOr } from '../../numbers';

// Re-exported from the shared core so the renderer, the CLI, and the voting pass
// (services/votingOrchestrator/boost.ts) all format durations identically — see src/ts/format/duration.ts.
export { formatDuration };

// Entry thumbnails. Re-exported here rather than imported straight into the
// component so the renderer keeps one door onto the shared core, matching
// formatDuration above — see src/ts/format/photoUrl.ts for why the URL has to
// be built client-side at all.
export { entryPhotoUrl };

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
 * @param value - The value to render (seconds, number, boolean, or array)
 * @param config - The setting's schema entry (reads `type` and `unit`)
 * @param t - Translation lookup
 */
export const formatSettingDefault = (
    value: unknown,
    config: Pick<SerializableSchemaEntry, 'type' | 'unit'> | null | undefined,
    t: (key: string) => string,
): string => {
    if (config?.type === 'schedule') {
        // A schedule setting holds { count, seconds } rows (config.type says so).
        const rows = Array.isArray(value) ? (value as Array<{ count?: number; seconds?: number } | null>) : [];
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
    // Before the generic array branch: each timeList entry is seconds and
    // must render as hours/minutes, not a raw number. timeOfDayList needs no
    // branch — the generic array join already renders 'HH:MM' strings.
    if (config?.type === 'timeList') {
        const entries = Array.isArray(value) ? (value as Array<number | null>) : [];
        return (
            entries.map((entry) => formatSecondsAsHoursMinutes(entry, t('app.hours'), t('app.minutes'))).join(', ') ||
            t('app.none')
        );
    }
    if (Array.isArray(value)) {
        return value.join(', ') || t('app.none');
    }
    // An empty text default (e.g. no scenario) reads as "none", not a blank.
    if (value === '') return t('app.none');
    if (config?.type === 'time') {
        return formatSecondsAsHoursMinutes(typeof value === 'number' ? value : null, t('app.hours'), t('app.minutes'));
    }
    if (config?.type === 'number' && config.unit) {
        return `${value} ${t(config.unit)}`;
    }
    return String(value);
};

/**
 * Format time remaining from Unix timestamp
 * @param endTime - Unix timestamp of end time
 * @returns Formatted time remaining (e.g., "2d 3h 5m", "30m 45s", "Ended")
 */
export const formatTimeRemaining = (endTime: number): string => {
    const now = Math.floor(Date.now() / 1000);
    const remaining = endTime - now;

    if (remaining <= 0) {
        return 'Ended';
    }

    return formatDuration(remaining, { includeSeconds: true });
};

/**
 * Format end time to localized string
 * @param endTime - Unix timestamp
 * @param timezone - Timezone string (e.g., 'local', 'Europe/Riga')
 * @returns Formatted date string
 */
export const formatEndTime = (endTime: number, timezone: string = 'local'): string => {
    const date = new Date(endTime * 1000);

    const formatOptions: Intl.DateTimeFormatOptions = {
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
 * @param boost - Boost object from API
 */
export const getBoostStatus = (boost: MemberBoost | null | undefined): { text: string; colorClass: string } => {
    if (!boost || !boost.state) {
        return { text: 'Unknown', colorClass: 'text-secondary' };
    }

    if (boost.state === 'AVAILABLE' || boost.state === 'AVAILABLE_KEY') {
        const now = Math.floor(Date.now() / 1000);
        const remaining = finiteOr(boost.timeout, 0) - now;
        if (remaining > 0) {
            const minutes = Math.floor(remaining / 60);
            return { text: `Available (${minutes}m left)`, colorClass: 'text-info' };
        } else {
            return { text: 'Available', colorClass: 'text-info' };
        }
    } else if (boost.state === 'USED') {
        return { text: 'Used', colorClass: 'text-success' };
    } else if (boost.state === 'UNAVAILABLE') {
        return { text: 'Unavailable', colorClass: 'text-error' };
    } else if (boost.state === 'LOCKED') {
        return { text: 'Locked', colorClass: 'text-error' };
    } else {
        // state is non-empty here (guarded above), so it is shown verbatim.
        return { text: boost.state, colorClass: 'text-secondary' };
    }
};

/**
 * Display state of one submitted entry — the photo's own boost/turbo/guru-pick
 * status, as opposed to getBoostStatus/getTurboStatus which describe the
 * challenge-level resource. Boost and turbo are mutually exclusive on an entry,
 * so the first match wins.
 *
 * entry.boost is an eligibility indicator, not an applied flag — the API marks
 * an applied boost with the separate boolean entry.boosted. Reading entry.boost
 * would light the rocket on entries that are merely eligible.
 *
 * @param entry - Entry record from challenge.member.ranking.entries
 */
export const getEntryStatus = (
    entry: RankingEntry | null | undefined,
): { isBoosted: boolean; isTurboed: boolean; icon: string; className: string; textClass: string } => {
    const isBoosted = entry?.boosted === true;
    const isTurboed = !!entry?.turbo;
    const base = { isBoosted, isTurboed };
    if (isBoosted) return { ...base, icon: '🚀', className: 'border-info text-info', textClass: 'text-info' };
    if (isTurboed) return { ...base, icon: '⚡', className: 'border-warning text-warning', textClass: 'text-warning' };
    if (entry?.guru_pick) return { ...base, icon: '⭐', className: 'badge-secondary', textClass: 'text-secondary' };
    return { ...base, icon: '📷', className: 'border-success text-success', textClass: 'text-success' };
};

/**
 * Whether a boost window is currently open (boost can be applied right now).
 * Re-exported from the shared predicate (voting/boostWindow.ts) that the
 * voting engine (services/VotingLogic.ts) uses too, so the two hosts can
 * never drift on what "open" means.
 */
export { isBoostWindowOpen } from '../../voting/boostWindow';

/**
 * Get turbo status with display text and color class
 * @param turbo - Turbo object from API
 */
export const getTurboStatus = (turbo: MemberTurbo | null | undefined): { text: string; colorClass: string } => {
    if (!turbo || !turbo.state) {
        return { text: 'Unavailable', colorClass: 'text-error' };
    }

    switch (turbo.state) {
        case 'FREE':
            return { text: 'Free', colorClass: 'text-info' };
        case 'TIMER':
            return { text: 'Timer', colorClass: 'text-error' };
        case 'IN_PROGRESS':
            return { text: 'In Progress', colorClass: 'text-warning' };
        case 'WON':
            return { text: 'Won', colorClass: 'text-accent' };
        case 'USED':
            return { text: 'Used', colorClass: 'text-success' };
        case 'UNAVAILABLE':
            return { text: 'Unavailable', colorClass: 'text-error' };
        case 'LOCKED':
            return { text: 'Locked', colorClass: 'text-latvian' };
        default:
            // state is non-empty here (guarded above), so it is shown verbatim.
            return { text: turbo.state, colorClass: 'text-secondary' };
    }
};

/**
 * Get level status with display text and badge color class
 * @param level - Level number
 * @param levelName - Level name (e.g., 'POPULAR', 'SKILLED')
 */
export const getLevelStatus = (level: number, levelName: string): { text: string; colorClass: string } => {
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
