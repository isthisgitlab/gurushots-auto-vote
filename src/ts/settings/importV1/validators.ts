/**
 * The zod shapes and list sanitizers of the frozen 1.x settings schema (see ./schema.ts), with the bounds they use.
 * A copy as of the last 1.x release: nothing here follows the live schema.
 */

import { z } from 'zod';
import { isInteger } from '../../numbers';
import { isPlainObject } from '../../plainObject';

const MAX_SCHEDULED_FILL_ENTRIES = 6;
const MAX_VOTING_PAUSE_MINUTES = 720;
const MAX_TAG_LENGTH = 50;
const MAX_CHOSEN_PHOTOS = 20;
const CHOSEN_PHOTO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_UPCOMING_HOURS = 168;
const DEFAULT_STARTUP_DELAY_SECONDS = 60;
const MAX_STARTUP_DELAY_SECONDS = 3600;
const API_TIMEOUT_MIN_SEC = 1;
const API_TIMEOUT_MAX_SEC = 300;
const API_MAX_RETRIES_MAX = 10;
const MAX_SCHEDULE_SECONDS = 30 * 24 * 3600;

const zBool = z.boolean();
const zString = z.string();
const percentage = z.number().min(1).max(100);
const percentageOrZero = z.number().min(0).max(100);
const nonNegNumber = z.number().min(0);
const minute1to59 = z.number().min(1).max(59);
const scenarioName = z.string().max(60);
const joinPercentElapsed = z.number().min(0).max(99);
const entrySlotIndex = z.number().int().min(0).max(4);
const coinAmount = z.number().int().min(0).max(1_000_000);
const joinWindowHours = z.number().min(0).max(720);
const autoSpendCount = z.number().int().min(1).max(10);
const currencyReserve = z.number().int().min(0).max(1000);
const swapVoteCeiling = z.number().int().min(0).max(1_000_000);
const currencyRuleSec = z.number().int().min(0).max(MAX_SCHEDULE_SECONDS);
const finalWindowDurationSec = z.number().int().min(60).max(MAX_SCHEDULE_SECONDS);
const notifyLeadMinutes = z.number().int().min(1).max(60);
const discoverUpcomingHours = z.number().int().min(0).max(MAX_UPCOMING_HOURS);
const startupDelaySeconds = z.number().int().min(0).max(MAX_STARTUP_DELAY_SECONDS);
const nonNegInt = z.number().int().min(0);
const windowMinutes = z.number().int().min(5).max(720);
const pauseDurationMinutes = z.number().int().min(5).max(MAX_VOTING_PAUSE_MINUTES);

const fillScheduleRow = z
    .object({
        count: z.number().int().min(2).max(4),
        seconds: z.number().int().min(0).max(MAX_SCHEDULE_SECONDS),
    })
    .strict();
const fillSchedule = z
    .array(fillScheduleRow)
    .max(3)
    .refine((rows) => new Set(rows.map((r) => r.count)).size === rows.length);

const tagsList = z
    .array(
        z
            .string()
            .min(1)
            .max(MAX_TAG_LENGTH)
            .refine((v) => v.trim().length > 0),
    )
    .max(50);

const photoIdList = z
    .array(z.string().regex(CHOSEN_PHOTO_ID_RE))
    .max(MAX_CHOSEN_PHOTOS)
    .refine((ids) => new Set(ids).size === ids.length);

const timeOfDayList = z
    .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
    .max(MAX_SCHEDULED_FILL_ENTRIES)
    .refine((v) => new Set(v).size === v.length);
const beforeEndList = z
    .array(z.number().int().min(1).max(MAX_SCHEDULE_SECONDS))
    .max(MAX_SCHEDULED_FILL_ENTRIES)
    .refine((v) => new Set(v).size === v.length);

/**
 * A stored autoFillSchedule clamped to the bounds: the healed array when anything changed, null when it already
 * conforms or is no array (load validation drops a non-array).
 */
const sanitizeFillSchedule = (value: unknown): Array<{ count: number; seconds: number }> | null => {
    if (!Array.isArray(value)) return null;
    const seen: Set<number> = new Set();
    const normalized = value
        .filter((row): row is { count: number; seconds: number } => {
            if (!isPlainObject(row)) return false;
            const { count, seconds } = row;
            if (!isInteger(count) || count < 2 || count > 4) return false;
            if (!isInteger(seconds) || seconds < 0 || seconds > MAX_SCHEDULE_SECONDS) return false;
            if (seen.has(count)) return false;
            seen.add(count);
            return true;
        })
        .sort((a, b) => a.count - b.count)
        .map((row) => ({ count: row.count, seconds: row.seconds }));
    const unchanged =
        normalized.length === value.length &&
        normalized.every((row, i) => {
            const orig = value[i];
            return (
                isPlainObject(orig) &&
                orig.count === row.count &&
                orig.seconds === row.seconds &&
                Object.keys(orig).length === 2
            );
        });
    return unchanged ? null : normalized;
};

/**
 * Same contract for scheduledFillTime: strict 'HH:MM' strings, deduped, sorted, capped.
 */
const sanitizeTimeOfDayList = (value: unknown): string[] | null => {
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
 * Same contract for scheduledFillBeforeEnd: integers within bounds, deduped, ascending, capped.
 */
const sanitizeBeforeEndList = (value: unknown): number[] | null => {
    if (!Array.isArray(value)) return null;
    const seen: Set<number> = new Set();
    const normalized = value
        .filter((entry): entry is number => {
            if (!isInteger(entry) || entry < 1 || entry > MAX_SCHEDULE_SECONDS) return false;
            if (seen.has(entry)) return false;
            seen.add(entry);
            return true;
        })
        .sort((a, b) => a - b)
        .slice(0, MAX_SCHEDULED_FILL_ENTRIES);
    const unchanged = normalized.length === value.length && normalized.every((entry, i) => entry === value[i]);
    return unchanged ? null : normalized;
};

export {
    API_MAX_RETRIES_MAX,
    API_TIMEOUT_MAX_SEC,
    API_TIMEOUT_MIN_SEC,
    DEFAULT_STARTUP_DELAY_SECONDS,
    autoSpendCount,
    beforeEndList,
    coinAmount,
    currencyReserve,
    currencyRuleSec,
    discoverUpcomingHours,
    entrySlotIndex,
    fillSchedule,
    finalWindowDurationSec,
    joinPercentElapsed,
    joinWindowHours,
    minute1to59,
    nonNegInt,
    nonNegNumber,
    notifyLeadMinutes,
    pauseDurationMinutes,
    percentage,
    percentageOrZero,
    photoIdList,
    sanitizeBeforeEndList,
    sanitizeFillSchedule,
    sanitizeTimeOfDayList,
    scenarioName,
    startupDelaySeconds,
    swapVoteCeiling,
    tagsList,
    timeOfDayList,
    windowMinutes,
    zBool,
    zString,
};
