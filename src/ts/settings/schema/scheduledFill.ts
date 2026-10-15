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
import { MAX_SCHEDULE_SECONDS, zBool } from './validators';
import type { SettingsSchemaEntry } from './entry';

// Scheduled fill: LISTS of triggers (issue #26 — "fill twice in a
// day, like 4 hours to the end and 10 hours to the end"). Each entry opens
// its own fill window; the empty array is the off sentinel and the schema
// default. Entries are deduped by the validators; order carries no meaning. The window
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
