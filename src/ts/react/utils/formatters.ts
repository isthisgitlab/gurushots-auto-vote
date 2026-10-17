import type { MemberBoost, MemberTurbo, RankingEntry } from '../../types/gurushots';
import type { SerializableSchemaEntry } from '../../ipc/settings.handlers';
/**
 * Time and display formatting utilities (pure functions only)
 */

import { formatSecondsAsHoursMinutes } from './timeFieldUnits';
import { formatDuration as formatDurationIn } from '../../format/duration';
import { rendererTranslator } from '../../translations/renderer';
import { buildPhotoUrl, entryPhotoUrl } from '../../format/photoUrl';
import { formatEndTimeIn } from '../../format/endTime';
import { finiteOr } from '../../numbers';
import { interp } from './interp';
import { LEVEL_BADGE_CLASS, LEVEL_PROGRESS_CLASS } from './levelBadge';

// The shared core's formatter, so the renderer, the CLI, and the voting pass
// (services/votingOrchestrator/boost.ts) all format durations identically — see src/ts/format/duration.ts —
// in the UI's language: Latvian writes minutes "min", not "m" (metres).
const formatDuration = (seconds: number, options: { includeSeconds?: boolean } = {}): string =>
    formatDurationIn(seconds, { ...options, locale: rendererTranslator.getCurrentLanguage() });
export { formatDuration };

// Entry thumbnails. Re-exported here rather than imported straight into the
// component so the renderer keeps one door onto the shared core, matching
// formatDuration above — see src/ts/format/photoUrl.ts for why the URL has to
// be built client-side at all.
export { buildPhotoUrl, entryPhotoUrl };

/** A chosen-photos list as its size ("none" when empty). */
const formatPhotoCount = (value: unknown, t: (key: string) => string): string => {
    const count = Array.isArray(value) ? value.length : 0;
    return count === 0 ? t('app.none') : interp(t('app.chosenPhotosCount'), { count });
};

/**
 * Format a setting value for the read-only "Global default" hint so it reads
 * the same way SettingInput renders the editable value: schedule rows as
 * "count ≤ Xh Ym" (before the generic array join, which would print
 * [object Object] for them), hours+minutes for `time` settings (stored as
 * seconds), `value unit` for unit-bearing numbers, and a comma-joined list
 * (or the "none" label) for tag arrays, a count for chosen-photo lists (their
 * ids mean nothing to read). Everything else falls back to
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
    // Before the generic array branch: a photo list is opaque ids, so only its size is shown.
    if (config?.type === 'photos') return formatPhotoCount(value, t);
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
 * @returns Formatted time remaining (e.g., "2d 3h 5m", "30m 45s"), or null once the challenge has ended — the
 *   view words that in the UI's language
 */
export const formatTimeRemaining = (endTime: number): string | null => {
    const now = Math.floor(Date.now() / 1000);
    const remaining = endTime - now;

    if (remaining <= 0) {
        return null;
    }

    return formatDuration(remaining, { includeSeconds: true });
};

/**
 * The BCP 47 locale dates are written in: the UI's language, with the regional form that keeps the
 * day-month-year, 24-hour layout.
 */
export const dateLocale = (): string => (rendererTranslator.getCurrentLanguage() === 'lv' ? 'lv-LV' : 'en-GB');

/**
 * Format end time to localized string
 * @param endTime - Unix timestamp
 * @param timezone - Timezone string (e.g., 'local', 'Europe/Riga')
 * @returns Formatted date string
 */
export const formatEndTime = (endTime: number, timezone: string = 'local'): string =>
    formatEndTimeIn(endTime, timezone, dateLocale());

/**
 * A challenge-level boost or turbo state as the view words it: a stable `code` (the view picks the translated text
 * from it — see statusText), the colour for that state, and the API's own state string when it is one this app has no
 * wording for.
 */
export type ResourceStatus<C extends string> = {
    code: C;
    colorClass: string;
    /** the API's state, set only when code is 'other' */
    raw?: string;
    /** whole minutes left, set only when code is 'availableMinutes' */
    minutes?: number;
};

export type BoostStatusCode =
    | 'unknown'
    | 'available'
    | 'availableMinutes'
    | 'used'
    | 'unavailable'
    | 'locked'
    | 'other';
export type TurboStatusCode = 'unavailable' | 'free' | 'timer' | 'inProgress' | 'won' | 'used' | 'locked' | 'other';

/**
 * Get boost status: a state code and its colour class
 * @param boost - Boost object from API
 */
export const getBoostStatus = (boost: MemberBoost | null | undefined): ResourceStatus<BoostStatusCode> => {
    if (!boost || !boost.state) {
        return { code: 'unknown', colorClass: 'text-base-content/60' };
    }

    if (boost.state === 'AVAILABLE' || boost.state === 'AVAILABLE_KEY') {
        const now = Math.floor(Date.now() / 1000);
        const remaining = finiteOr(boost.timeout, 0) - now;
        if (remaining > 0) {
            return { code: 'availableMinutes', colorClass: 'text-info', minutes: Math.floor(remaining / 60) };
        } else {
            return { code: 'available', colorClass: 'text-info' };
        }
    } else if (boost.state === 'USED') {
        return { code: 'used', colorClass: 'text-success' };
    } else if (boost.state === 'UNAVAILABLE') {
        return { code: 'unavailable', colorClass: 'text-base-content/60' };
    } else if (boost.state === 'LOCKED') {
        return { code: 'locked', colorClass: 'text-base-content/60' };
    } else {
        // state is non-empty here (guarded above), so it is shown verbatim.
        return { code: 'other', colorClass: 'text-base-content/60', raw: boost.state };
    }
};

/**
 * Whether a boost status says a boost can be placed (with or without time left on its window).
 */
export const isBoostAvailable = (status: ResourceStatus<BoostStatusCode>): boolean =>
    status.code === 'available' || status.code === 'availableMinutes';

const STATUS_TEXT_KEYS: Record<string, string> = {
    unknown: 'app.stateUnknown',
    available: 'app.available',
    availableMinutes: 'app.stateAvailableMinutes',
    used: 'app.used',
    unavailable: 'app.unavailable',
    locked: 'app.stateLocked',
    free: 'app.stateFree',
    timer: 'app.stateTimer',
    inProgress: 'app.stateInProgress',
    won: 'app.stateWon',
};

/**
 * The status in the UI's language. An 'other' state is the API's own string, shown as it came.
 *
 * @param t - Translation lookup
 */
export const statusText = (status: ResourceStatus<string>, t: (key: string) => string): string => {
    if (status.code === 'other') return status.raw ?? '';
    const text = t(STATUS_TEXT_KEYS[status.code]);
    return status.code === 'availableMinutes' ? interp(text, { minutes: status.minutes ?? 0 }) : text;
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
    const neutral = { className: 'border-base-300', textClass: '' };
    if (isBoosted) return { ...base, icon: '🚀', ...neutral };
    if (isTurboed) return { ...base, icon: '⚡', ...neutral };
    if (entry?.guru_pick) return { ...base, icon: '⭐', ...neutral };
    return { ...base, icon: '📷', ...neutral };
};

/**
 * Whether a boost window is currently open (boost can be applied right now).
 * Re-exported from the shared predicate (voting/boostWindow.ts) that the
 * voting engine (services/VotingLogic.ts) uses too, so the two hosts can
 * never drift on what "open" means.
 */
export { isBoostWindowOpen } from '../../voting/boostWindow';

/**
 * Get turbo status: a state code and its colour class
 * @param turbo - Turbo object from API
 */
export const getTurboStatus = (turbo: MemberTurbo | null | undefined): ResourceStatus<TurboStatusCode> => {
    if (!turbo || !turbo.state) {
        return { code: 'unavailable', colorClass: 'text-base-content/60' };
    }

    switch (turbo.state) {
        case 'FREE':
            return { code: 'free', colorClass: 'text-info' };
        case 'TIMER':
            return { code: 'timer', colorClass: 'text-base-content/60' };
        case 'IN_PROGRESS':
            return { code: 'inProgress', colorClass: 'text-warning' };
        case 'WON':
            return { code: 'won', colorClass: 'text-success' };
        case 'USED':
            return { code: 'used', colorClass: 'text-success' };
        case 'UNAVAILABLE':
            return { code: 'unavailable', colorClass: 'text-base-content/60' };
        case 'LOCKED':
            return { code: 'locked', colorClass: 'text-base-content/60' };
        default:
            // state is non-empty here (guarded above), so it is shown verbatim.
            return { code: 'other', colorClass: 'text-base-content/60', raw: turbo.state };
    }
};

/**
 * Get level status with display text and badge color class and progress-bar class
 * @param level - Level number
 * @param levelName - Level name (e.g., 'POPULAR', 'SKILLED')
 */
export const getLevelStatus = (
    level: number,
    levelName: string,
): { text: string; colorClass: string; progressClass: string } => {
    if (!level || !levelName) {
        return { text: 'Unknown', colorClass: 'badge-success', progressClass: 'progress-latvian' };
    }

    switch (levelName.toUpperCase()) {
        case 'POPULAR':
            return {
                text: `${levelName} ${level}`,
                colorClass: LEVEL_BADGE_CLASS.popular,
                progressClass: LEVEL_PROGRESS_CLASS.popular,
            };
        case 'SKILLED':
            return {
                text: `${levelName} ${level}`,
                colorClass: LEVEL_BADGE_CLASS.skilled,
                progressClass: LEVEL_PROGRESS_CLASS.skilled,
            };
        case 'PREMIER':
            return {
                text: `${levelName} ${level}`,
                colorClass: LEVEL_BADGE_CLASS.premier,
                progressClass: LEVEL_PROGRESS_CLASS.premier,
            };
        case 'ELITE':
            return {
                text: `${levelName} ${level}`,
                colorClass: LEVEL_BADGE_CLASS.elite,
                progressClass: LEVEL_PROGRESS_CLASS.elite,
            };
        case 'ALL STAR':
            return {
                text: `${levelName} ${level}`,
                colorClass: LEVEL_BADGE_CLASS.allstar,
                progressClass: LEVEL_PROGRESS_CLASS.allstar,
            };
        default:
            return { text: `${levelName} ${level}`, colorClass: 'badge-warning', progressClass: 'progress-latvian' };
    }
};
