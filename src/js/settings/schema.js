// @ts-check
const { z } = require('zod');

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
const nonNegInt = z.number().int().min(0); // image index (1-indexed, 0 = last)
// Shared 1–59 range, preserving the previous predicates exactly: used by both
// lastMinuteThreshold (minutes-before-close that count as "last minute") and
// lastMinuteCheckFrequency (poll cadence in minutes). Neither is required to be
// an integer (matching prior behavior); the 59 ceiling keeps both within the hour.
const minute1to59 = z.number().min(1).max(59);

// Auto-fill schedule: rows of { count, seconds } meaning "have ≥ count entries
// once ≤ seconds remain before close". Counts start at 2 — entry 1 always
// exists because joining a challenge IS submitting a photo (there is no
// separate join flow). Counts must be unique (each target needs exactly one
// threshold); row order is irrelevant at runtime (the trigger is max-based).
// The caps are defense-in-depth against a corrupted settings file or
// out-of-band write, same rationale as the tagsList caps below.
const MAX_SCHEDULE_ROWS = 20;
const MAX_SCHEDULE_COUNT = 20;
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

// Entries are grouped by their `group` field (see SETTINGS_GROUPS below) and
// declared in group order so the file reads top-to-bottom the way the
// settings modals render. Object key order has no runtime effect —
// getSchemaDefault resolves at call time and validationOrder/dependsOn drive
// dependency ordering — so the order here is purely for readability.
/** @type {Record<string, SettingsSchemaEntry>} */
const SETTINGS_SCHEMA = {
    // --- General ---
    exposure: {
        type: 'number',
        default: 100,
        perChallenge: true,
        validation: percentage,
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
        contextValidation: (value, allSettings) => {
            if (value === 0) return true; // sentinel — always ok
            const exposureValue = allSettings.exposure;
            const effectiveExposure =
                typeof exposureValue === 'number' && exposureValue >= 1 && exposureValue <= 100
                    ? exposureValue
                    : getSchemaDefault('exposure');
            return value >= effectiveExposure;
        },
        getContextError: (value, allSettings) => {
            const exposureValue = allSettings.exposure;
            const effectiveExposure =
                typeof exposureValue === 'number' && exposureValue >= 1 && exposureValue <= 100
                    ? exposureValue
                    : getSchemaDefault('exposure');
            return `VALIDATION_GREATER_OR_EQUAL|app.exposure|${effectiveExposure}`;
        },
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
    boostImageIndex: {
        type: 'number',
        default: 1,
        perChallenge: true,
        validation: nonNegInt,
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
        validation: nonNegInt,
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
        contextValidation: (value, allSettings) => {
            const exposureValue = allSettings.exposure;
            // If exposure is not set or invalid, use the exposure default for comparison
            const effectiveExposure =
                typeof exposureValue === 'number' && exposureValue >= 1 && exposureValue <= 100
                    ? exposureValue
                    : getSchemaDefault('exposure');
            return value <= effectiveExposure;
        },
        getContextError: (value, allSettings) => {
            const exposureValue = allSettings.exposure;
            const effectiveExposure =
                typeof exposureValue === 'number' && exposureValue >= 1 && exposureValue <= 100
                    ? exposureValue
                    : getSchemaDefault('exposure');
            // Return a string that the UI will translate
            return `VALIDATION_LESS_OR_EQUAL|app.exposure|${effectiveExposure}`;
        },
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
        validationOrder: 1, // Validate first (no dependencies)
        group: 'lastMinute',
        label: 'app.lastMinuteCheckFrequency',
        description: 'app.lastMinuteCheckFrequencyDesc',
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

    if (schemaConfig.validation && !schemaConfig.validation.safeParse(value).success) {
        return 'Invalid value';
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
};
