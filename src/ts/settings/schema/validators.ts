/**
 * The zod validators and entry shapes that more than one settings group
 * module uses. A validator with a single user lives beside that user.
 */

import { z } from 'zod';

/**
 * A context validator's value: validateSetting only calls contextValidation
 * after the key's zod check passed, so a percentage key's value is a number.
 */
export const validatedNumber = (value: unknown) => value as number;

// Reusable zod validators. Each SETTINGS_SCHEMA entry's `validation` field
// holds one of these schemas; validateSetting / getValidationError run it via
// safeParse. Centralizing the shapes keeps the per-entry declarations
// declarative and the type/range rules in one place. zod's z.number()
// rejects NaN and numeric strings.
export const zBool = z.boolean();
export const zString = z.string();
export const percentage = z.number().min(1).max(100); // exposure-style trigger, 1–100
export const percentageOrZero = z.number().min(0).max(100); // target, 0 = "use trigger" sentinel
export const nonNegNumber = z.number().min(0); // time fields (seconds before close); 0 = off
// Elapsed-fraction timing anchor (auto-join and the currency rules), as a
// PERCENT of the candidate's own lifetime (close_time - start_time). 0 = off,
// same sentinel family as the auto-join hours window. This exists because hours-before-close does not
// transfer across challenge lengths: the live payload carries 2h flash
// challenges and 515h exhibitions side by side (verified 2026-09-19), so one
// absolute window is either far too late for the short ones or far too early
// for the long ones. A percentage is scale-free — 75 means "join once
// three-quarters of the challenge has run", whatever its length.
// The ceiling is 99, NOT 100: a candidate is only 100% elapsed at the instant
// its close_time passes, and the gate refuses an already-closed challenge before
// it ever reads the fraction. Allowing 100 would therefore ship a maximum that
// silently never joins anything. 99 is the latest value that can actually fire.
const MAX_JOIN_PERCENT_ELAPSED = 99;
const joinPercentElapsed = z.number().min(0).max(MAX_JOIN_PERCENT_ELAPSED);
// Entry-slot index: 1-4 selects a slot, 0 is the "last entry" sentinel. GuruShots challenges
// carry at most four submissions (max_photo_submits tops out at 4, which is also why the
// auto-fill schedule only covers images 2-4), so anything above 4 could never name a real
// slot and is rejected rather than silently clamped to the last entry at pick time.
const MAX_ENTRY_SLOT = 4;
const entrySlotIndex = z.number().int().min(0).max(MAX_ENTRY_SLOT);
// Shared 1–59 range, used by both lastMinuteThreshold (minutes-before-close
// that count as "last minute") and lastMinuteCheckFrequency (poll cadence in
// minutes). Neither is required to be an integer; the 59 ceiling keeps both
// within the hour.
export const minute1to59 = z.number().min(1).max(59);
// Cap on every duration setting: 30 days, defense-in-depth against a corrupted
// settings file or out-of-band write.
export const MAX_SCHEDULE_SECONDS = 30 * 24 * 3600;

// Entry shapes shared by several settings; each entry spreads one and adds its
// group, label and description.
export const entrySlotSetting = (defaultSlot: number) => ({
    type: 'number',
    default: defaultSlot,
    perChallenge: true,
    validation: entrySlotIndex,
    min: 0,
    max: MAX_ENTRY_SLOT,
    validationOrder: 1,
});
export const elapsedPercentSetting = {
    type: 'number',
    default: 0,
    perChallenge: true,
    validation: joinPercentElapsed,
    min: 0,
    max: MAX_JOIN_PERCENT_ELAPSED,
    unit: 'app.unitPercent',
    validationOrder: 1,
};
