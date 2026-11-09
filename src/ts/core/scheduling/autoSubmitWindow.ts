/**
 * Pure clock-window rules for Auto-Submit.
 *
 * Settings I/O stays with each host. This module only resolves recurring wall
 * times in the app timezone, so the execution and cadence paths share exactly
 * the same boundary semantics.
 */

import { MAX_SCHEDULED_FILL_ENTRIES } from '../settings/limits';
import { occurrencesOf } from './wallClock';

export type AutoSubmitClockWindowState = {
    active: boolean;
    /** All configured clock times whose window is open at `now`. */
    activeTimes: string[];
    /** End of the union of active windows, or null when no window is open. */
    activeUntil: number | null;
    /** Earliest future window start, or null when no valid time is configured. */
    nextStart: number | null;
};

const durationSeconds = (windowMinutes: unknown): number | null => {
    const minutes = Number(windowMinutes);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : null;
};

/**
 * Resolve recurring clock windows around `now` in the app timezone. A window
 * contains its start and excludes its end: `[start, start + duration)`.
 */
export const getAutoSubmitClockWindowState = (
    times: unknown,
    windowMinutes: unknown,
    timezone: string,
    now: number,
): AutoSubmitClockWindowState => {
    const durationSec = durationSeconds(windowMinutes);
    if (!durationSec || !Array.isArray(times) || !Number.isFinite(now)) {
        return { active: false, activeTimes: [], activeUntil: null, nextStart: null };
    }

    const activeTimes: string[] = [];
    let activeUntil: number | null = null;
    let nextStart: number | null = null;
    for (const entry of times.slice(0, MAX_SCHEDULED_FILL_ENTRIES)) {
        if (typeof entry !== 'string') continue;
        const occurrence = occurrencesOf(entry, timezone, now);
        if (!occurrence) continue;
        const end = occurrence.prev + durationSec;
        if (now >= occurrence.prev && now < end) {
            activeTimes.push(entry);
            activeUntil = Math.max(activeUntil ?? -Infinity, end);
        }
        if (nextStart === null || occurrence.next < nextStart) nextStart = occurrence.next;
    }
    return { active: activeTimes.length > 0, activeTimes, activeUntil, nextStart };
};
