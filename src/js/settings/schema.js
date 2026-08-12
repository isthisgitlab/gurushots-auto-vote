// @ts-check
const { z } = require('zod');
// Bounds live in the dependency-free limits.js so renderer-reachable modules
// can read them without pulling zod in through this file. Re-exported below to
// keep this module's public surface unchanged.
const { MAX_SCHEDULED_FILL_ENTRIES } = require('./limits');

/**
 * Centralized Settings Schema
 *
 * Single source of truth for all configurable settings. Each entry
 * declares its type, default, validation, and whether it supports
 * per-challenge overrides. Pure module — no fs, logger, or runtime
 * imports — so the schema can be unit-tested directly and the
 * settings facade re-exports the public surface.
 */

/**
 * Shape of a single SETTINGS_SCHEMA entry. All fields are optional so the
 * heterogeneous entries (some carry contextValidation/getContextError, most
 * don't) all fit one type; the typed validator signatures also give the
 * inline `(value) => ...` callbacks contextual typing so they aren't flagged
 * as implicit-any.
 *
 * @typedef {object} SettingsSchemaEntry
 * @property {string} [type]
 * @property {*} [default]
 * @property {boolean} [perChallenge]
 * @property {import('zod').ZodType} [validation]
 * @property {(value: any, allSettings: any, challengeId?: any) => boolean} [contextValidation]
 * @property {(value: any, allSettings: any, challengeId?: any) => string} [getContextError]
 * @property {string[]} [dependsOn]
 * @property {number} [validationOrder]
 * @property {string} [group]
 * @property {string} [label]
 * @property {string} [description]
 * @property {number} [min] - Advertised lower bound, mirroring `validation`. Forwarded to the
 *   renderer by the schema IPC projection and bound to the number input.
 * @property {number} [max] - Advertised upper bound, mirroring `validation`.
 * @property {string} [unit] - Translation key for the suffix shown beside a number input.
 */

/**
 * Helper to read schema defaults at runtime. Defined ahead of
 * SETTINGS_SCHEMA so the contextValidation closures inside the schema
 * can resolve sibling defaults without forward-referencing the constant
 * literal during construction.
 *
 * @param {string} key
 * @returns {*}
 */
const getSchemaDefault = (key) => SETTINGS_SCHEMA[key]?.default;

/**
 * The exposure value the exposure-dependent validators compare against:
 * the live `exposure` from allSettings when it is a valid 1–100 number,
 * otherwise the schema default. Shared by the exposureTarget and
 * lastHourExposure context validators/error builders.
 *
 * @param {any} allSettings
 * @returns {number}
 */
const effectiveExposureOf = (allSettings) => {
    const exposureValue = allSettings.exposure;
    return typeof exposureValue === 'number' && exposureValue >= 1 && exposureValue <= 100
        ? exposureValue
        : getSchemaDefault('exposure');
};

// Reusable zod validators. Each SETTINGS_SCHEMA entry's `validation` field
// holds one of these schemas; validateSetting / getValidationError run it via
// safeParse. Centralizing the shapes keeps the per-entry declarations
// declarative and the type/range rules in one place. zod's z.number()
// rejects NaN and numeric strings, matching the previous typeof predicates.
const zBool = z.boolean();
const zString = z.string();
const percentage = z.number().min(1).max(100); // exposure-style trigger, 1–100
const percentageOrZero = z.number().min(0).max(100); // target, 0 = "use trigger" sentinel
const nonNegNumber = z.number().min(0); // time fields (seconds before close); 0 = off
// Entry-slot index: 1-4 selects a slot, 0 is the "last entry" sentinel. GuruShots challenges
// carry at most four submissions (max_photo_submits tops out at 4, which is also why the
// auto-fill schedule only covers images 2-4), so anything above 4 could never name a real
// slot — it used to be accepted and then silently clamped to the last entry at pick time.
const MAX_ENTRY_SLOT = 4;
const entrySlotIndex = z.number().int().min(0).max(MAX_ENTRY_SLOT);
// Shared 1–59 range, preserving the previous predicates exactly: used by both
// lastMinuteThreshold (minutes-before-close that count as "last minute") and
// lastMinuteCheckFrequency (poll cadence in minutes). Neither is required to be
// an integer (matching prior behavior); the 59 ceiling keeps both within the hour.
const minute1to59 = z.number().min(1).max(59);

// Auto-fill schedule: rows of { count, seconds } meaning "have ≥ count entries
// once ≤ seconds remain before close". Counts are 2–4: entry 1 always exists
// (joining a challenge IS submitting a photo — there is no separate join
// flow), and GuruShots challenges allow at most 4 images, so the schedule is
// at most three rows (images 2, 3, 4). Counts must be unique (each target
// needs exactly one threshold); row order is irrelevant at runtime (the
// trigger is max-based) and the runtime additionally clamps to the live
// max_photo_submits as a safety net. The seconds cap is defense-in-depth
// against a corrupted settings file or out-of-band write, same rationale as
// the tagsList caps below.
const MAX_SCHEDULE_ROWS = 3;
// Mirrored in services/scheduleRemap.js (renderer-bundle-safe module that
// can't import this zod-carrying file) — change both together.
const MAX_SCHEDULE_COUNT = 4;
const MAX_SCHEDULE_SECONDS = 30 * 24 * 3600; // 30 days
const fillScheduleRow = z
    .object({
        count: z.number().int().min(2).max(MAX_SCHEDULE_COUNT),
        seconds: z.number().int().min(0).max(MAX_SCHEDULE_SECONDS),
    })
    .strict();
const fillSchedule = z
    .array(fillScheduleRow)
    .max(MAX_SCHEDULE_ROWS)
    .refine((rows) => new Set(rows.map((r) => r.count)).size === rows.length);

/**
 * Clamp a persisted autoFillSchedule array to the current bounds. Used by the
 * load-time `_autoFillScheduleBoundsV1` sanitizer in settings.js: the Settings
 * modal resubmits EVERY persisted key on save, so a stored schedule that
 * violates the (tightened) validator would block saving unrelated settings
 * until repaired — this heals such data on load instead. Keeps only strict
 * { count, seconds } rows within bounds, dedupes by count (first wins), and
 * sorts by count. Returns the sanitized array when anything changed, or null
 * when the input already conforms (or isn't an array at all — non-array
 * corruption is the read path's concern, mirroring getValidScheduleRows).
 *
 * @param {*} value
 * @returns {Array<{count: number, seconds: number}>|null}
 */
const sanitizeFillSchedule = (value) => {
    if (!Array.isArray(value)) return null;
    /** @type {Set<number>} */
    const seen = new Set();
    const normalized = value
        .filter((row) => {
            if (!row || typeof row !== 'object') return false;
            if (!Number.isInteger(row.count) || row.count < 2 || row.count > MAX_SCHEDULE_COUNT) return false;
            if (!Number.isInteger(row.seconds) || row.seconds < 0 || row.seconds > MAX_SCHEDULE_SECONDS) return false;
            if (seen.has(row.count)) return false;
            seen.add(row.count);
            return true;
        })
        .sort((a, b) => a.count - b.count)
        .map((row) => ({ count: row.count, seconds: row.seconds }));
    const unchanged =
        normalized.length === value.length &&
        normalized.every((row, i) => {
            const orig = value[i];
            return (
                orig &&
                typeof orig === 'object' &&
                orig.count === row.count &&
                orig.seconds === row.seconds &&
                Object.keys(orig).length === 2
            );
        });
    return unchanged ? null : normalized;
};

// Per-string and total-array caps for tag-list settings. A typical use is
// a few words per tag, a handful of tags per challenge — the caps exist
// to keep a corrupted settings file or out-of-band write from passing
// pathological input to the picker. Each tag must be a non-empty,
// non-whitespace string of at most MAX_TAG_LENGTH characters.
const MAX_TAG_LENGTH = 50;
const MAX_TAGS_PER_LIST = 50;
const tagsList = z
    .array(
        z
            .string()
            .min(1)
            .max(MAX_TAG_LENGTH)
            .refine((v) => v.trim().length > 0),
    )
    .max(MAX_TAGS_PER_LIST);

// Scheduled fill: LISTS of triggers (issue #26 follow-up — "fill twice in a
// day, like 4 hours to the end and 10 hours to the end"). Each entry opens
// its own fill window; the empty array is the off sentinel and the schema
// default (the old scalar '' / 0 sentinels are migrated in settings.js —
// _scheduledFillListsMigratedV1). Entries are deduped by the validators and
// canonical-sorted by the sanitizers; order carries no meaning. The window
// floor keeps a window from being shorter than one last-minute check cycle;
// the 12h ceiling keeps "hold at 100%" from silently becoming an all-day
// threshold override. Entry-level messages are surfaced verbatim by
// getValidationError (CLI settings:set feedback).
const MAX_BEFORE_END_SECONDS = MAX_SCHEDULE_SECONDS; // same 30-day defense-in-depth cap
const timeOfDayEntry = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected 24h HH:MM');
const timeOfDayList = z
    .array(timeOfDayEntry)
    .max(MAX_SCHEDULED_FILL_ENTRIES, `at most ${MAX_SCHEDULED_FILL_ENTRIES} times`)
    .refine((v) => new Set(v).size === v.length, 'duplicate times');
const beforeEndEntry = z.number().int().min(1).max(MAX_BEFORE_END_SECONDS);
const beforeEndList = z
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
 * survive deterministically rather than storage order. Deliberately unhealed
 * gap (same accepted-risk class the scalar era carried): a value that is
 * neither string, number, nor array (`true`/`{}`/null from a hand edit) is
 * left as-is — the modal's resubmit path rejects it with the zod message
 * rather than saving.
 *
 * @param {*} value
 * @returns {string[]|null}
 */
const sanitizeTimeOfDayList = (value) => {
    if (!Array.isArray(value)) return null;
    const seen = new Set();
    const normalized = value
        .filter((entry) => {
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
 *
 * @param {*} value
 * @returns {number[]|null}
 */
const sanitizeBeforeEndList = (value) => {
    if (!Array.isArray(value)) return null;
    const seen = new Set();
    const normalized = value
        .filter((entry) => {
            if (!Number.isInteger(entry) || entry < 1 || entry > MAX_BEFORE_END_SECONDS) return false;
            if (seen.has(entry)) return false;
            seen.add(entry);
            return true;
        })
        .sort((a, b) => a - b)
        .slice(0, MAX_SCHEDULED_FILL_ENTRIES);
    const unchanged = normalized.length === value.length && normalized.every((entry, i) => entry === value[i]);
    return unchanged ? null : normalized;
};

// Entries are grouped by their `group` field (see SETTINGS_GROUPS below) and
// declared in group order so the file reads top-to-bottom the way the
// settings modals render. Object key order has no runtime effect —
// getSchemaDefault resolves at call time and validationOrder/dependsOn drive
// dependency ordering — so the order here is purely for readability.
/** @type {Record<string, SettingsSchemaEntry>} */
const SETTINGS_SCHEMA = {
    // --- General ---
    // NOTE on min/max/unit: the IPC schema projection and SettingInput have always
    // forwarded these three fields, but no entry ever defined them — so every number input
    // rendered unbounded and unlabelled, and the only feedback for an out-of-range value was
    // a generic "could not be saved" banner. They mirror the zod validator directly; keep the
    // two in step when either changes.
    exposure: {
        type: 'number',
        default: 100,
        perChallenge: true,
        validation: percentage,
        min: 1,
        max: 100,
        unit: 'app.unitPercent',
        validationOrder: 1, // Validate first (no dependencies)
        group: 'general',
        label: 'app.exposure',
        description: 'app.exposureDesc',
    },
    exposureTarget: {
        type: 'number',
        // 0 is a sentinel meaning "vote up to the exposure trigger value" (legacy behavior).
        // Any 1-100 explicitly overrides the target so the loop keeps voting past the trigger.
        default: 0,
        perChallenge: true,
        validation: percentageOrZero,
        min: 0,
        max: 100,
        unit: 'app.unitPercent',
        contextValidation: (value, allSettings) => {
            if (value === 0) return true; // sentinel — always ok
            return value >= effectiveExposureOf(allSettings);
        },
        getContextError: (value, allSettings) =>
            `VALIDATION_GREATER_OR_EQUAL|app.exposure|${effectiveExposureOf(allSettings)}`,
        dependsOn: ['exposure'],
        validationOrder: 2, // Validate after dependencies
        group: 'general',
        label: 'app.exposureTarget',
        description: 'app.exposureTargetDesc',
    },
    onlyBoost: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1, // Validate first (no dependencies)
        group: 'general',
        label: 'app.onlyBoost',
        description: 'app.onlyBoostDesc',
    },
    voteOnNewEntry: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'general',
        label: 'app.voteOnNewEntry',
        description: 'app.voteOnNewEntryDesc',
    },
    compactCards: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'general',
        label: 'app.compactCards',
        description: 'app.compactCardsDesc',
    },

    // --- Boost ---
    autoBoost: {
        type: 'boolean',
        default: true,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'boost',
        label: 'app.autoBoost',
        description: 'app.autoBoostDesc',
    },
    boostTime: {
        type: 'time', // Special type for hours/minutes input
        default: 3600, // 1 hour in seconds
        perChallenge: true,
        validation: nonNegNumber,
        validationOrder: 1, // Validate first (no dependencies)
        group: 'boost',
        label: 'app.boostTime',
        description: 'app.boostTimeDesc',
    },
    // Deliberately separate from boostTime, not a replacement for it. The two describe
    // different clocks: boostTime counts down the boost's OWN timer, while a key-unlocked
    // boost has no timer at all and can only be measured against the challenge's close time.
    // Reusing boostTime for both would silently reinterpret one user-facing number as two
    // different things. Default 900s (15m) preserves the behaviour of the constant it
    // replaces — key-unlocked boosts never expire, so spending one late maximises its effect.
    keyUnlockedBoostTime: {
        type: 'time', // hours/minutes input, stored as seconds
        default: 900, // 15 minutes in seconds
        perChallenge: true,
        validation: nonNegNumber,
        validationOrder: 1,
        group: 'boost',
        label: 'app.keyUnlockedBoostTime',
        description: 'app.keyUnlockedBoostTimeDesc',
    },
    boostImageIndex: {
        type: 'number',
        default: 1,
        perChallenge: true,
        validation: entrySlotIndex,
        min: 0,
        max: MAX_ENTRY_SLOT,
        validationOrder: 1,
        group: 'boost',
        label: 'app.boostImageIndex',
        description: 'app.boostImageIndexDesc',
    },
    boostFillNew: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'boost',
        label: 'app.boostFillNew',
        description: 'app.boostFillNewDesc',
    },

    // --- Turbo ---
    useTurbo: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'turbo',
        label: 'app.useTurbo',
        description: 'app.useTurboDesc',
    },
    autoTurbo: {
        type: 'boolean',
        default: true,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'turbo',
        label: 'app.autoTurbo',
        description: 'app.autoTurboDesc',
    },
    turboTime: {
        type: 'time',
        default: 7200, // 2 hours in seconds
        perChallenge: true,
        validation: nonNegNumber,
        validationOrder: 1,
        group: 'turbo',
        label: 'app.turboTime',
        description: 'app.turboTimeDesc',
    },
    turboImageIndex: {
        type: 'number',
        default: 1,
        perChallenge: true,
        validation: entrySlotIndex,
        min: 0,
        max: MAX_ENTRY_SLOT,
        validationOrder: 1,
        group: 'turbo',
        label: 'app.turboImageIndex',
        description: 'app.turboImageIndexDesc',
    },
    turboApplyWhenBoostActive: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'turbo',
        label: 'app.turboApplyWhenBoostActive',
        description: 'app.turboApplyWhenBoostActiveDesc',
    },
    turboFillNew: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'turbo',
        label: 'app.turboFillNew',
        description: 'app.turboFillNewDesc',
    },

    // --- Last Hour Exposure ---
    useLastHourExposure: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1, // Validate first (no dependencies)
        group: 'lastHour',
        label: 'app.useLastHourExposure',
        description: 'app.useLastHourExposureDesc',
    },
    lastHourExposure: {
        type: 'number',
        default: 100,
        perChallenge: true,
        validation: percentage,
        min: 1,
        max: 100,
        unit: 'app.unitPercent',
        // If exposure is not set or invalid, effectiveExposureOf falls back to
        // the exposure default for comparison.
        contextValidation: (value, allSettings) => value <= effectiveExposureOf(allSettings),
        // Return a string that the UI will translate
        getContextError: (value, allSettings) =>
            `VALIDATION_LESS_OR_EQUAL|app.exposure|${effectiveExposureOf(allSettings)}`,
        dependsOn: ['exposure'],
        validationOrder: 2, // Validate after dependencies
        group: 'lastHour',
        label: 'app.lastHourExposure',
        description: 'app.lastHourExposureDesc',
    },
    lastHourExposureTarget: {
        type: 'number',
        // 0 is a sentinel meaning "vote up to the lastHourExposure trigger value" (legacy behavior).
        default: 0,
        perChallenge: true,
        validation: percentageOrZero,
        min: 0,
        max: 100,
        unit: 'app.unitPercent',
        contextValidation: (value, allSettings) => {
            if (value === 0) return true;
            const triggerValue = allSettings.lastHourExposure;
            const effectiveTrigger =
                typeof triggerValue === 'number' && triggerValue >= 1 && triggerValue <= 100
                    ? triggerValue
                    : getSchemaDefault('lastHourExposure');
            return value >= effectiveTrigger;
        },
        getContextError: (value, allSettings) => {
            const triggerValue = allSettings.lastHourExposure;
            const effectiveTrigger =
                typeof triggerValue === 'number' && triggerValue >= 1 && triggerValue <= 100
                    ? triggerValue
                    : getSchemaDefault('lastHourExposure');
            return `VALIDATION_GREATER_OR_EQUAL|app.lastHourExposure|${effectiveTrigger}`;
        },
        dependsOn: ['lastHourExposure'],
        validationOrder: 2,
        group: 'lastHour',
        label: 'app.lastHourExposureTarget',
        description: 'app.lastHourExposureTargetDesc',
    },

    // --- Last Minute ---
    voteOnlyInLastMinute: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1, // Validate first (no dependencies)
        group: 'lastMinute',
        label: 'app.voteOnlyInLastMinute',
        description: 'app.voteOnlyInLastMinuteDesc',
    },
    lastMinuteThreshold: {
        type: 'number',
        default: 10,
        perChallenge: true,
        validation: minute1to59,
        min: 1,
        max: 59,
        unit: 'app.unitMinutes',
        validationOrder: 1, // Validate first (no dependencies)
        group: 'lastMinute',
        label: 'app.lastMinuteThreshold',
        description: 'app.lastMinuteThresholdDesc',
    },
    lastMinuteCheckFrequency: {
        type: 'number',
        default: 1,
        perChallenge: false,
        validation: minute1to59,
        min: 1,
        max: 59,
        unit: 'app.unitMinutes',
        validationOrder: 1, // Validate first (no dependencies)
        group: 'lastMinute',
        label: 'app.lastMinuteCheckFrequency',
        description: 'app.lastMinuteCheckFrequencyDesc',
    },

    // --- Scheduled Fill ---
    // Fill exposure at configured wall-clock instants instead of (or on top
    // of) the threshold rules. Two independent trigger LISTS — recurring
    // times-of-day (interpreted in the app `timezone` setting via
    // scheduling/wallClock.js, NOT device-local time) and one-shot
    // seconds-before-close offsets — every entry opens its own window sharing
    // scheduledFillWindowMinutes, all OR'd. The decision-side consumer is
    // getScheduledFillState in services/VotingLogic.js; the cadence-side
    // consumer is scheduling/scheduledFill.js.
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

    // --- Auto Fill ---
    autoFill: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.autoFill',
        description: 'app.autoFillDesc',
    },
    // Replaces the old autoFillIntervalMinutes single-interval knob (migrated
    // in settings.js `_autoFillScheduleMigratedV1`). Default mirrors the old
    // 10-minute default: 2 @ 30m, 3 @ 20m, 4 @ 10m before close.
    autoFillSchedule: {
        type: 'schedule',
        default: [
            { count: 2, seconds: 1800 },
            { count: 3, seconds: 1200 },
            { count: 4, seconds: 600 },
        ],
        perChallenge: true,
        validation: fillSchedule,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.autoFillSchedule',
        description: 'app.autoFillScheduleDesc',
    },
    fillWithoutTagMatch: {
        type: 'boolean',
        default: true,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.fillWithoutTagMatch',
        description: 'app.fillWithoutTagMatchDesc',
    },
    // Emergency fill only acts on scheduler cycles that actually run, so it
    // depends on cadence: keep emergencyFill <= lastMinuteThreshold and the
    // fast last-minute cron is already active throughout the window. If it is
    // larger, the early part of the window relies on the slower normal cadence
    // (it still fires, just less tightly) — see emergencyFillDesc.
    emergencyFill: {
        type: 'time', // Special type for hours/minutes input (stored as seconds)
        default: 300, // 5 minutes in seconds
        perChallenge: true,
        // 0 is the off sentinel; otherwise seconds-before-close (mirrors boostTime/turboTime).
        validation: nonNegNumber,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.emergencyFill',
        description: 'app.emergencyFillDesc',
    },
    mustIncludeTags: {
        type: 'tags',
        default: [],
        perChallenge: true,
        validation: tagsList,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.mustIncludeTags',
        description: 'app.mustIncludeTagsDesc',
    },
    shouldIncludeTags: {
        type: 'tags',
        default: [],
        perChallenge: true,
        validation: tagsList,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.shouldIncludeTags',
        description: 'app.shouldIncludeTagsDesc',
    },

    // --- Internal (no UI group; never rendered in a settings section) ---
    // Persisted autovote-running flag. Written on Start / Stop so a
    // relaunch of the app (Capacitor WebView destroyed + recreated,
    // Electron window reopen) can resume voting without the user
    // tapping Start again.
    autovoteRunning: {
        type: 'boolean',
        default: false,
        perChallenge: false,
        validation: zBool,
        validationOrder: 1,
        label: 'app.autovoteRunning',
        description: 'app.autovoteRunningDesc',
    },
    // Update version the user chose to skip. Electron persists this in
    // metadata.json (fs); the Android/Capacitor bridge has no fs, so it
    // routes skip-update-version through the settings facade instead, which
    // has a platform-agnostic transport (@capacitor/preferences). Empty
    // string means "nothing skipped".
    skipUpdateVersion: {
        type: 'string',
        default: '',
        perChallenge: false,
        validation: zString,
        validationOrder: 1,
        label: 'app.skipUpdateVersion',
        description: 'app.skipUpdateVersionDesc',
    },
};

/**
 * Ordered UI grouping for the settings modals. Each schema entry's `group`
 * field matches an `id` here; the modals render one static section per group
 * in this order. Entries with no `group` (e.g. autovoteRunning) are
 * intentionally excluded from every section.
 */
const SETTINGS_GROUPS = [
    { id: 'general', label: 'app.groupGeneral' },
    { id: 'boost', label: 'app.groupBoost' },
    { id: 'turbo', label: 'app.groupTurbo' },
    { id: 'lastHour', label: 'app.groupLastHour' },
    { id: 'lastMinute', label: 'app.groupLastMinute' },
    { id: 'scheduledFill', label: 'app.groupScheduledFill' },
    { id: 'autoFill', label: 'app.groupAutoFill' },
];

/**
 * Validate a single setting value against SETTINGS_SCHEMA. Keys that are
 * not in the schema are treated as valid because the schema is the only
 * source of validation rules for per-challenge tunables.
 *
 * @param {string} key
 * @param {*} value
 * @param {Record<string, any>|null} [allSettings]
 * @param {string|null} [challengeId]
 * @returns {boolean}
 */
const validateSetting = (key, value, allSettings = null, challengeId = null) => {
    const schemaConfig = SETTINGS_SCHEMA[key];
    if (!schemaConfig) return true;
    if (schemaConfig.validation && !schemaConfig.validation.safeParse(value).success) return false;
    if (schemaConfig.contextValidation && allSettings) {
        if (!schemaConfig.contextValidation(value, allSettings, challengeId)) return false;
    }
    return true;
};

/**
 * Get detailed validation error information for a setting. Returns null
 * when the value is valid. Mirrors `validateSetting`'s call signature
 * (challengeId is forwarded to contextValidation) so a future schema
 * entry that depends on per-challenge context behaves identically
 * across both validation paths.
 *
 * @param {string} settingKey
 * @param {*} value
 * @param {Record<string, any>|null} [allSettings]
 * @param {string|null} [challengeId]
 * @returns {string|null}
 */
const getValidationError = (settingKey, value, allSettings = null, challengeId = null) => {
    const schemaConfig = SETTINGS_SCHEMA[settingKey];
    if (!schemaConfig) {
        return null; // No schema config, assume valid
    }

    if (schemaConfig.validation) {
        const parsed = schemaConfig.validation.safeParse(value);
        if (!parsed.success) {
            // Prefer zod's own issue message when it carries real information
            // (custom refine messages, "expected number" type mismatches);
            // zod's generic refine fallback "Invalid input" adds nothing over
            // the historical constant, so keep 'Invalid value' there.
            const issueMessage = parsed.error?.issues?.[0]?.message;
            return issueMessage && issueMessage !== 'Invalid input' ? issueMessage : 'Invalid value';
        }
    }

    if (schemaConfig.contextValidation && allSettings) {
        if (!schemaConfig.contextValidation(value, allSettings, challengeId)) {
            if (schemaConfig.getContextError) {
                return schemaConfig.getContextError(value, allSettings, challengeId);
            }
            return 'Invalid value in current context';
        }
    }

    return null; // Valid
};

/**
 * Async getter exposed via IPC; returns the schema as-is. Async signature
 * preserved so existing renderer call sites don't need to change.
 */
const getSettingsSchema = async () => SETTINGS_SCHEMA;

module.exports = {
    SETTINGS_SCHEMA,
    SETTINGS_GROUPS,
    getSchemaDefault,
    validateSetting,
    getValidationError,
    getSettingsSchema,
    sanitizeFillSchedule,
    sanitizeTimeOfDayList,
    sanitizeBeforeEndList,
    // Shared cap for the scheduled-fill lists: the write path enforces it via
    // zod, the load-time bounds migration heals older data, and the hot-path
    // consumers (VotingLogic, scheduledFill.js, the settings modal) slice
    // defensively with it so a post-migration hand-edited array can't inflate
    // per-cycle Intl work.
    MAX_SCHEDULED_FILL_ENTRIES,
};
