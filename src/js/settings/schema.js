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
 * Helper to read schema defaults at runtime. Defined ahead of
 * SETTINGS_SCHEMA so the contextValidation closures inside the schema
 * can resolve sibling defaults without forward-referencing the constant
 * literal during construction.
 */
const getSchemaDefault = (key) => SETTINGS_SCHEMA[key]?.default;

// Per-string and total-array caps for tag-list settings. A typical use is
// a few words per tag, a handful of tags per challenge — the caps exist
// to keep a corrupted settings file or out-of-band write from passing
// pathological input to the picker.
const MAX_TAG_LENGTH = 50;
const MAX_TAGS_PER_LIST = 50;
const isValidTagsList = (value) =>
    Array.isArray(value) &&
    value.length <= MAX_TAGS_PER_LIST &&
    value.every((v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_TAG_LENGTH && v.trim().length > 0);

// Entries are grouped by their `group` field (see SETTINGS_GROUPS below) and
// declared in group order so the file reads top-to-bottom the way the
// settings modals render. Object key order has no runtime effect —
// getSchemaDefault resolves at call time and validationOrder/dependsOn drive
// dependency ordering — so the order here is purely for readability.
const SETTINGS_SCHEMA = {
    // --- General ---
    exposure: {
        type: 'number',
        default: 100,
        perChallenge: true,
        validation: (value) => typeof value === 'number' && value >= 1 && value <= 100,
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
        validation: (value) => typeof value === 'number' && value >= 0 && value <= 100,
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
        validation: (value) => typeof value === 'boolean',
        validationOrder: 1, // Validate first (no dependencies)
        group: 'general',
        label: 'app.onlyBoost',
        description: 'app.onlyBoostDesc',
    },
    compactCards: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: (value) => typeof value === 'boolean',
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
        validation: (value) => typeof value === 'boolean',
        validationOrder: 1,
        group: 'boost',
        label: 'app.autoBoost',
        description: 'app.autoBoostDesc',
    },
    boostTime: {
        type: 'time', // Special type for hours/minutes input
        default: 3600, // 1 hour in seconds
        perChallenge: true,
        validation: (value) => typeof value === 'number' && value >= 0,
        validationOrder: 1, // Validate first (no dependencies)
        group: 'boost',
        label: 'app.boostTime',
        description: 'app.boostTimeDesc',
    },
    boostImageIndex: {
        type: 'number',
        default: 1,
        perChallenge: true,
        validation: (value) => Number.isInteger(value) && value >= 0,
        validationOrder: 1,
        group: 'boost',
        label: 'app.boostImageIndex',
        description: 'app.boostImageIndexDesc',
    },

    // --- Turbo ---
    useTurbo: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: (value) => typeof value === 'boolean',
        validationOrder: 1,
        group: 'turbo',
        label: 'app.useTurbo',
        description: 'app.useTurboDesc',
    },
    autoTurbo: {
        type: 'boolean',
        default: true,
        perChallenge: true,
        validation: (value) => typeof value === 'boolean',
        validationOrder: 1,
        group: 'turbo',
        label: 'app.autoTurbo',
        description: 'app.autoTurboDesc',
    },
    turboTime: {
        type: 'time',
        default: 7200, // 2 hours in seconds
        perChallenge: true,
        validation: (value) => typeof value === 'number' && value >= 0,
        validationOrder: 1,
        group: 'turbo',
        label: 'app.turboTime',
        description: 'app.turboTimeDesc',
    },
    turboImageIndex: {
        type: 'number',
        default: 1,
        perChallenge: true,
        validation: (value) => Number.isInteger(value) && value >= 0,
        validationOrder: 1,
        group: 'turbo',
        label: 'app.turboImageIndex',
        description: 'app.turboImageIndexDesc',
    },
    turboApplyWhenBoostActive: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: (value) => typeof value === 'boolean',
        validationOrder: 1,
        group: 'turbo',
        label: 'app.turboApplyWhenBoostActive',
        description: 'app.turboApplyWhenBoostActiveDesc',
    },

    // --- Last Hour Exposure ---
    useLastHourExposure: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: (value) => typeof value === 'boolean',
        validationOrder: 1, // Validate first (no dependencies)
        group: 'lastHour',
        label: 'app.useLastHourExposure',
        description: 'app.useLastHourExposureDesc',
    },
    lastHourExposure: {
        type: 'number',
        default: 100,
        perChallenge: true,
        validation: (value) => typeof value === 'number' && value >= 1 && value <= 100,
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
        validation: (value) => typeof value === 'number' && value >= 0 && value <= 100,
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
        validation: (value) => typeof value === 'boolean',
        validationOrder: 1, // Validate first (no dependencies)
        group: 'lastMinute',
        label: 'app.voteOnlyInLastMinute',
        description: 'app.voteOnlyInLastMinuteDesc',
    },
    lastMinuteThreshold: {
        type: 'number',
        default: 10,
        perChallenge: true,
        validation: (value) => typeof value === 'number' && value >= 1 && value <= 59,
        validationOrder: 1, // Validate first (no dependencies)
        group: 'lastMinute',
        label: 'app.lastMinuteThreshold',
        description: 'app.lastMinuteThresholdDesc',
    },
    lastMinuteCheckFrequency: {
        type: 'number',
        default: 1,
        perChallenge: false,
        validation: (value) => typeof value === 'number' && value >= 1 && value <= 59,
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
        validation: (value) => typeof value === 'boolean',
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.autoFill',
        description: 'app.autoFillDesc',
    },
    autoFillIntervalMinutes: {
        type: 'number',
        default: 10,
        perChallenge: true,
        validation: (value) => Number.isInteger(value) && value >= 1 && value <= 60,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.autoFillIntervalMinutes',
        description: 'app.autoFillIntervalMinutesDesc',
    },
    fillWithoutTagMatch: {
        type: 'boolean',
        default: true,
        perChallenge: true,
        validation: (value) => typeof value === 'boolean',
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
        type: 'number',
        default: 5,
        perChallenge: true,
        // 0 is the off sentinel; otherwise minutes-before-close (1-59, mirrors lastMinuteThreshold).
        validation: (value) => Number.isInteger(value) && value >= 0 && value <= 59,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.emergencyFill',
        description: 'app.emergencyFillDesc',
        unit: 'app.minutes',
    },
    mustIncludeTags: {
        type: 'tags',
        default: [],
        perChallenge: true,
        validation: isValidTagsList,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.mustIncludeTags',
        description: 'app.mustIncludeTagsDesc',
    },
    shouldIncludeTags: {
        type: 'tags',
        default: [],
        perChallenge: true,
        validation: isValidTagsList,
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
        validation: (value) => typeof value === 'boolean',
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
        validation: (value) => typeof value === 'string',
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
 */
const validateSetting = (key, value, allSettings = null, challengeId = null) => {
    const schemaConfig = SETTINGS_SCHEMA[key];
    if (!schemaConfig) return true;
    if (schemaConfig.validation && !schemaConfig.validation(value)) return false;
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
 */
const getValidationError = (settingKey, value, allSettings = null, challengeId = null) => {
    const schemaConfig = SETTINGS_SCHEMA[settingKey];
    if (!schemaConfig) {
        return null; // No schema config, assume valid
    }

    if (schemaConfig.validation && !schemaConfig.validation(value)) {
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
