/**
 * The `scheduledFill` group (labelled "Scheduled Voting" in the UI): fill
 * exposure at configured wall-clock instants instead of (or on top of) the
 * threshold rules. Two independent trigger LISTS — recurring times-of-day
 * (interpreted in the app `timezone` setting via scheduling/wallClock.ts, NOT
 * device-local time) and one-shot seconds-before-close offsets — every entry
 * opens its own window sharing scheduledFillWindowMinutes, all OR'd. The
 * decision-side consumer is getScheduledFillState in
 * services/decisions/triggerWindows.ts; the cadence-side consumer is
 * scheduling/scheduledFill.ts.
 */

import { z } from 'zod';
import { MAX_SCHEDULED_FILL_ENTRIES } from '../limits';
import { isInteger } from '../../numbers';
import { MAX_SCHEDULE_SECONDS, zBool } from './validators';
import type { SettingsSchemaEntry } from './entry';

// Scheduled fill: LISTS of triggers (issue #26 — "fill twice in a
// day, like 4 hours to the end and 10 hours to the end"). Each entry opens
// its own fill window; the empty array is the off sentinel and the schema
// default (scalar '' / 0 values in a stored blob are migrated to lists in
// settings/migrations/scheduledFill.ts — _scheduledFillListsMigratedV1). Entries are deduped by the validators and
// canonical-sorted by the sanitizers; order carries no meaning. The window
// floor keeps a window from being shorter than one last-minute check cycle;
// the 12h ceiling keeps "hold at 100%" from silently becoming an all-day
// threshold override. Entry-level messages are surfaced verbatim by
// getValidationError (CLI settings:set feedback).
const MAX_BEFORE_END_SECONDS = MAX_SCHEDULE_SECONDS; // same 30-day defense-in-depth cap
const timeOfDayEntry = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected 24h HH:MM');
export const timeOfDayList = z
    .array(timeOfDayEntry)
    .max(MAX_SCHEDULED_FILL_ENTRIES, `at most ${MAX_SCHEDULED_FILL_ENTRIES} times`)
    .refine((v) => new Set(v).size === v.length, 'duplicate times');
const beforeEndEntry = z.number().int().min(1).max(MAX_BEFORE_END_SECONDS);
export const beforeEndList = z
    .array(beforeEndEntry)
    .max(MAX_SCHEDULED_FILL_ENTRIES, `at most ${MAX_SCHEDULED_FILL_ENTRIES} offsets`)
    .refine((v) => new Set(v).size === v.length, 'duplicate offsets');
const windowMinutes = z.number().int().min(5).max(720);

/**
 * Clamp a persisted scheduledFillTime list to the current bounds — the
 * sanitizeFillSchedule contract: healed array when anything changed, null
 * when the input already conforms or isn't an array at all. Keeps strict
 * 'HH:MM' strings, dedupes (first wins), sorts (lexicographic == chronological
 * for zero-padded 24h times) and THEN caps, so with >MAX entries the earliest
 * survive deterministically rather than storage order. A value that is not an
 * array (`true`/`{}`/null from a hand edit) is left to load-time validation
 * (settings/persistence.ts), which drops it so the default applies.
 */
export const sanitizeTimeOfDayList = (value: unknown): string[] | null => {
    if (!Array.isArray(value)) return null;
    const seen: Set<string> = new Set();
    const normalized = value
        .filter((entry): entry is string => {
            if (typeof entry !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(entry)) return false;
            if (seen.has(entry)) return false;
            seen.add(entry);
            return true;
        })
        .sort()
        .slice(0, MAX_SCHEDULED_FILL_ENTRIES);
    const unchanged = normalized.length === value.length && normalized.every((entry, i) => entry === value[i]);
    return unchanged ? null : normalized;
};

/**
 * Same contract for the scheduledFillBeforeEnd list: keep ints
 * 1..MAX_BEFORE_END_SECONDS, dedupe, sort ascending, then cap (smallest
 * offsets — the windows closest to the deadline — survive deterministically).
 */
export const sanitizeBeforeEndList = (value: unknown): number[] | null => {
    if (!Array.isArray(value)) return null;
    const seen: Set<number> = new Set();
    const normalized = value
        .filter((entry): entry is number => {
            if (!isInteger(entry) || entry < 1 || entry > MAX_BEFORE_END_SECONDS) return false;
            if (seen.has(entry)) return false;
            seen.add(entry);
            return true;
        })
        .sort((a, b) => a - b)
        .slice(0, MAX_SCHEDULED_FILL_ENTRIES);
    const unchanged = normalized.length === value.length && normalized.every((entry, i) => entry === value[i]);
    return unchanged ? null : normalized;
};

export const scheduledFillSettings = {
    useScheduledFill: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'scheduledFill',
        label: 'app.useScheduledFill',
        description: 'app.useScheduledFillDesc',
    },
    scheduledFillTime: {
        type: 'timeOfDayList',
        default: [], // [] = this form off
        perChallenge: true,
        validation: timeOfDayList,
        validationOrder: 1,
        group: 'scheduledFill',
        label: 'app.scheduledFillTime',
        description: 'app.scheduledFillTimeDesc',
    },
    scheduledFillBeforeEnd: {
        type: 'timeList', // rows of hours/minutes inputs, stored as seconds each
        default: [], // [] = this form off
        perChallenge: true,
        validation: beforeEndList,
        validationOrder: 1,
        group: 'scheduledFill',
        label: 'app.scheduledFillBeforeEnd',
        description: 'app.scheduledFillBeforeEndDesc',
    },
    scheduledFillWindowMinutes: {
        type: 'number',
        default: 60,
        perChallenge: true,
        validation: windowMinutes,
        // 5 is the real floor: it is what saving enforces and what the CLI help documents.
        // getScheduledFillState still honours a smaller hand-edited value, which stays an
        // advanced escape hatch rather than something the UI will produce.
        min: 5,
        max: 720,
        unit: 'app.unitMinutes',
        validationOrder: 1,
        group: 'scheduledFill',
        label: 'app.scheduledFillWindowMinutes',
        description: 'app.scheduledFillWindowMinutesDesc',
    },
    scheduledFillReplaces: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'scheduledFill',
        label: 'app.scheduledFillReplaces',
        description: 'app.scheduledFillReplacesDesc',
    },
} satisfies Record<string, SettingsSchemaEntry>;
