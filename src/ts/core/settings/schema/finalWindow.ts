/** Settings of the `finalWindow` group. */

import { z } from 'zod';
import { effectiveExposureOf } from './general';
import { MAX_SCHEDULE_SECONDS, minute1to59, percentage, percentageOrZero, validatedNumber, zBool } from './validators';
import type { SettingsSchemaEntry } from './entry';

// Final-window duration (seconds before close during which the final-window
// exposure rule applies). Integer, at least 60s (a shorter window is
// meaningless against poll cadence) and capped by the same 30-day schedule
// ceiling as every other duration. Default is 3600 (one hour).
const finalWindowDurationSec = z.number().int().min(60).max(MAX_SCHEDULE_SECONDS);
const finalWindowExposureDefault = (): number => Number(finalWindowSettings.finalWindowExposure.default);

export const finalWindowSettings = {
    // Duration of the "final window" before a challenge closes during which the
    // final-window exposure rule applies. Default 3600s (1 hour); stored as
    // seconds via the hours/minutes input. Read per-challenge by the voting
    // rules and the top-up scheduler.
    finalWindowDuration: {
        type: 'time', // hours/minutes input, stored as seconds
        default: 3600, // 1 hour in seconds
        perChallenge: true,
        validation: finalWindowDurationSec,
        min: 60,
        max: MAX_SCHEDULE_SECONDS,
        validationOrder: 1, // Validate first (no dependencies)
        group: 'finalWindow',
        label: 'app.finalWindowDuration',
        description: 'app.finalWindowDurationDesc',
        helpKey: 'app.finalWindowDurationHelp',
    },
    useFinalWindowExposure: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1, // Validate first (no dependencies)
        group: 'finalWindow',
        label: 'app.useFinalWindowExposure',
        description: 'app.useFinalWindowExposureDesc',
    },
    finalWindowExposure: {
        type: 'number',
        default: 100,
        perChallenge: true,
        validation: percentage,
        min: 1,
        max: 100,
        unit: 'app.unitPercent',
        // If exposure is not set or invalid, effectiveExposureOf falls back to
        // the exposure default for comparison.
        contextValidation: (value, allSettings) => validatedNumber(value) <= effectiveExposureOf(allSettings),
        // Return a string that the UI will translate
        getContextError: (value, allSettings) =>
            `VALIDATION_LESS_OR_EQUAL|app.exposure|${effectiveExposureOf(allSettings)}`,
        dependsOn: ['exposure'],
        validationOrder: 2, // Validate after dependencies
        group: 'finalWindow',
        label: 'app.finalWindowExposure',
        description: 'app.finalWindowExposureDesc',
    },
    finalWindowExposureTarget: {
        type: 'number',
        // 0 is a sentinel meaning "vote up to the finalWindowExposure trigger value".
        default: 0,
        perChallenge: true,
        validation: percentageOrZero,
        min: 0,
        max: 100,
        unit: 'app.unitPercent',
        contextValidation: (value, allSettings) => {
            if (value === 0) return true;
            const triggerValue = allSettings.finalWindowExposure;
            const effectiveTrigger =
                typeof triggerValue === 'number' && triggerValue >= 1 && triggerValue <= 100
                    ? triggerValue
                    : finalWindowExposureDefault();
            return validatedNumber(value) >= effectiveTrigger;
        },
        getContextError: (value, allSettings) => {
            const triggerValue = allSettings.finalWindowExposure;
            const effectiveTrigger =
                typeof triggerValue === 'number' && triggerValue >= 1 && triggerValue <= 100
                    ? triggerValue
                    : finalWindowExposureDefault();
            return `VALIDATION_GREATER_OR_EQUAL|app.finalWindowExposure|${effectiveTrigger}`;
        },
        dependsOn: ['finalWindowExposure'],
        validationOrder: 2,
        group: 'finalWindow',
        label: 'app.finalWindowExposureTarget',
        description: 'app.finalWindowExposureTargetDesc',
        helpKey: 'app.finalWindowExposureTargetHelp',
    },
    // Boolean toggle (0-is-off convention does NOT apply — this is a flag, not a
    // duration). Only meaningful alongside useFinalWindowExposure: it tops the
    // challenge up to the STANDARD exposure target across the boundary into the
    // final window, so a challenge whose exposure decayed below standard doesn't
    // get stranded there by the final-window rule's lower (recovery) trigger.
    voteBeforeFinalWindow: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1, // Validate first (no dependencies)
        group: 'finalWindow',
        label: 'app.voteBeforeFinalWindow',
        description: 'app.voteBeforeFinalWindowDesc',
    },
    // Lead minutes: half-width of the top-up window straddling the final-window
    // boundary — the window runs [close-finalWindowDuration-lead,
    // close-finalWindowDuration+lead], i.e. it starts `lead` minutes BEFORE the
    // final window (the scheduler wakes then to guarantee the top-up) and extends
    // `lead` minutes INTO it as a grace period for timing jitter / an app started
    // late. Reuses the 1..59 minute validator; 0 is intentionally not allowed (a
    // zero-width window would defeat the point).
    voteBeforeFinalWindowLeadMin: {
        type: 'number',
        default: 15,
        perChallenge: true,
        validation: minute1to59,
        min: 1,
        max: 59,
        unit: 'app.unitMinutes',
        validationOrder: 1, // Validate first (no dependencies)
        group: 'finalWindow',
        label: 'app.voteBeforeFinalWindowLeadMin',
        description: 'app.voteBeforeFinalWindowLeadMinDesc',
    },
} satisfies Record<string, SettingsSchemaEntry>;
