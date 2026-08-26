/**
 * Settings facade. The schema lives in ./settings/schema and the
 * persistence transport / runtime detection in ./settings/storage; this
 * file owns the load/save mechanics, migrations, schema-based accessors,
 * cleanup, and reset helpers. It also re-exports the schema + storage
 * surface so existing call sites keep importing from `./settings` without
 * needing to know the internal split.
 */

const logger = require('./logger');
const {
    SETTINGS_SCHEMA,
    SETTINGS_GROUPS,
    validateSetting,
    getValidationError,
    getSettingsSchema,
    sanitizeFillSchedule,
    sanitizeTimeOfDayList,
    sanitizeBeforeEndList,
} = require('./settings/schema');
const { getUiDefaultSettings } = require('./settings/uiDefaults');
const { INTENT_PROFILES } = require('./settings/intentProfiles');
const {
    storage,
    initializeAsync,
    flushPendingWrites,
    isAutovoteRunning,
    getDefaultMockSetting,
    getUserDataPath,
    getSettingsPath,
    getEnvironmentInfo,
} = require('./settings/storage');

// Default settings with environment-aware mock setting
const getDefaultSettings = () => {
    // Generate global defaults from schema
    const globalDefaults = {};
    Object.keys(SETTINGS_SCHEMA).forEach((key) => {
        globalDefaults[key] = SETTINGS_SCHEMA[key].default;
    });

    return {
        // UI-form settings (theme/language/timezone/timing/retry) come from
        // the shared uiDefaults module — single source of truth with the
        // renderer's settings form.
        ...getUiDefaultSettings(),
        lastUsername: '',
        mock: getDefaultMockSetting(),
        token: '',
        onboardingCompleted: false, // First-run welcome dismissed? (app-level flag, same class as apiTimeout)
        // Window position and size settings
        windowBounds: {
            login: { x: undefined, y: undefined, width: 800, height: 960 },
            main: { x: undefined, y: undefined, width: 800, height: 960 },
        },
        // Schema-based challenge settings
        challengeSettings: {
            globalDefaults: globalDefaults,
            perChallenge: {}, // Challenge ID -> setting overrides mapping
            // Title-keyed tag rules. Challenges rotate with a fresh id each
            // time, so id-keyed perChallenge overrides are lost on every
            // rotation; these rules match on the (stable) challenge title and
            // are merged into the effective must/should-include tag lists at
            // fill time. Shape: [{ title, mustIncludeTags: [], shouldIncludeTags: [] }].
            titleRules: [],
        },
        // API headers for randomization (random per user installation)
        apiHeaders: {},
    };
};

// Module-local guards so cleanupObsoleteSettings (which itself calls
// loadSettings) doesn't recurse and doesn't re-run on every read.
let migrationInProgress = false;
let cleanupCompleted = false;

/**
 * Read the raw persisted settings JSON string via the storage adapter so
 * the Capacitor cache path is exercised on Android. Electron/CLI hit fs
 * synchronously. Returns the raw string, or a falsy value when no settings
 * file exists.
 */
const readRawSettings = () => storage.readRaw();

/**
 * Merge parsed persisted settings over the defaults so all properties
 * exist, and resolve the environment-aware mock default.
 */
const mergeWithDefaults = (settings) => {
    // Merge with default settings to ensure all properties exist
    const mergedSettings = { ...getDefaultSettings(), ...settings };

    // Mock setting can be user-controlled, but default to environment if not set
    if (mergedSettings.mock === undefined) {
        mergedSettings.mock = getDefaultMockSetting();
    }

    return mergedSettings;
};

// Migrate buggy-GUI-encoded time values. Pre-fix (versions
// v0.7.0 through v0.8.2), SettingInput stored boostTime /
// turboTime as minutes (h*60+m) while the runtime treated
// them as seconds. The buggy GUI could only write values in
// [0, 1439] (max was 23h*60+59); schema defaults (3600, 7200)
// are above that band, so untouched defaults pass through
// unchanged.
const migrateTimeUnits = (mergedSettings) => {
    if (mergedSettings._timeUnitMigratedV1) return false;

    const TIME_KEYS = ['boostTime', 'turboTime'];
    const looksMinuteEncoded = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1440;

    const globalDefaults = mergedSettings.challengeSettings?.globalDefaults || {};
    for (const key of TIME_KEYS) {
        if (looksMinuteEncoded(globalDefaults[key])) {
            const before = globalDefaults[key];
            globalDefaults[key] = before * 60;
            logger
                .withCategory('settings')
                .info(`Migrated ${key} global default from minute-encoded ${before} to ${globalDefaults[key]}s`, null);
        }
    }

    const perChallenge = mergedSettings.challengeSettings?.perChallenge || {};
    for (const [challengeId, overrides] of Object.entries(perChallenge)) {
        for (const key of TIME_KEYS) {
            if (looksMinuteEncoded(overrides[key])) {
                const before = overrides[key];
                overrides[key] = before * 60;
                logger
                    .withCategory('settings')
                    .info(
                        `Migrated ${key} override on challenge ${challengeId} from ${before} to ${overrides[key]}s`,
                        null,
                    );
            }
        }
    }

    mergedSettings._timeUnitMigratedV1 = true;
    return true;
};

// Migrate emergencyFill from minutes to seconds. It used to be a
// plain `number` of minutes-before-close (1-59); it's now a `time`
// setting stored in seconds (mirrors boostTime/turboTime). The old
// GUI/CLI could only write 1-59, so a value in (0, 60) is a stale
// minute encoding; 0 is the off sentinel and stays 0; legitimate new
// seconds values from the time input start at 60, so the band
// cleanly separates old-minutes from new-seconds. This is a separate
// flag because _timeUnitMigratedV1 is already set for current users.
const migrateEmergencyFillTime = (mergedSettings) => {
    if (mergedSettings._emergencyFillTimeMigratedV1) return false;

    const looksMinuteEncoded = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 60;

    const globalDefaults = mergedSettings.challengeSettings?.globalDefaults || {};
    if (looksMinuteEncoded(globalDefaults.emergencyFill)) {
        const before = globalDefaults.emergencyFill;
        globalDefaults.emergencyFill = before * 60;
        logger
            .withCategory('settings')
            .info(
                `Migrated emergencyFill global default from minute-encoded ${before} to ${globalDefaults.emergencyFill}s`,
                null,
            );
    }

    const perChallenge = mergedSettings.challengeSettings?.perChallenge || {};
    for (const [challengeId, overrides] of Object.entries(perChallenge)) {
        if (looksMinuteEncoded(overrides.emergencyFill)) {
            const before = overrides.emergencyFill;
            overrides.emergencyFill = before * 60;
            logger
                .withCategory('settings')
                .info(
                    `Migrated emergencyFill override on challenge ${challengeId} from ${before} to ${overrides.emergencyFill}s`,
                    null,
                );
        }
    }

    mergedSettings._emergencyFillTimeMigratedV1 = true;
    return true;
};

// Migrate autoFillIntervalMinutes into autoFillSchedule. The single
// interval M is replaced by an explicit per-image schedule; the old
// trigger (`secondsRemaining <= slotsRemaining * M*60`) maps, for the
// common 4-slot challenge, to targets 2 @ 3M, 3 @ 2M, 4 @ 1M minutes
// before close. Always derived from the USER'S persisted M (a 15m
// user gets 45/30/15), never from the schema default; each scope is
// migrated independently. Runs before cleanupObsoleteSettings, which
// would otherwise just delete the now-schemaless legacy key.
const migrateAutoFillSchedule = (mergedSettings) => {
    if (mergedSettings._autoFillScheduleMigratedV1) return false;

    const LEGACY_KEY = 'autoFillIntervalMinutes';
    // Clamp to the old validator's 60-minute ceiling and round: a
    // hand-edited non-integer or oversized legacy value must not
    // migrate into a schedule the new int()/max() schema rejects.
    const toSchedule = (minutes) => {
        const m = Math.min(minutes, 60);
        return [
            { count: 2, seconds: Math.round(3 * m * 60) },
            { count: 3, seconds: Math.round(2 * m * 60) },
            { count: 4, seconds: Math.round(m * 60) },
        ];
    };
    const migrateScope = (scope, label) => {
        if (!scope) return;
        const legacy = scope[LEGACY_KEY];
        if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy >= 1) {
            if (scope.autoFillSchedule === undefined) {
                scope.autoFillSchedule = toSchedule(legacy);
                logger
                    .withCategory('settings')
                    .info(
                        `Migrated ${LEGACY_KEY}=${legacy} ${label} to autoFillSchedule ${JSON.stringify(scope.autoFillSchedule)}`,
                        null,
                    );
            }
        }
        if (Object.prototype.hasOwnProperty.call(scope, LEGACY_KEY)) {
            delete scope[LEGACY_KEY];
        }
    };

    migrateScope(mergedSettings.challengeSettings?.globalDefaults, 'global default');
    const autoFillPerChallenge = mergedSettings.challengeSettings?.perChallenge || {};
    for (const [challengeId, overrides] of Object.entries(autoFillPerChallenge)) {
        migrateScope(overrides, `override on challenge ${challengeId}`);
    }

    mergedSettings._autoFillScheduleMigratedV1 = true;
    return true;
};

// Sanitize persisted autoFillSchedule values to the current bounds
// (counts 2-4, ≤3 rows, unique counts, seconds within cap). The
// wide pre-tightening editor could store counts up to 20; because
// the Settings modal resubmits every persisted key on save, such a
// value would fail the tightened validator and block saving ANY
// setting. Runs after the interval→schedule migration above, whose
// output always conforms already. Note this is a ONE-TIME pass
// (flag-gated like the migrations), not a standing invariant:
// every write path is zod-validated afterwards, so only an
// out-of-band file edit made after the flag is set could
// reintroduce bad rows — the same accepted risk as hand-editing
// any other setting, and the read path still clamps defensively.
const migrateAutoFillScheduleBounds = (mergedSettings) => {
    if (mergedSettings._autoFillScheduleBoundsV1) return false;

    const sanitizeScope = (scope, label) => {
        if (!scope) return;
        const cleaned = sanitizeFillSchedule(scope.autoFillSchedule);
        if (cleaned !== null) {
            logger
                .withCategory('settings')
                .info(`Sanitized autoFillSchedule ${label} to current bounds: ${JSON.stringify(cleaned)}`, null);
            scope.autoFillSchedule = cleaned;
        }
    };

    sanitizeScope(mergedSettings.challengeSettings?.globalDefaults, 'global default');
    const schedulePerChallenge = mergedSettings.challengeSettings?.perChallenge || {};
    for (const [challengeId, overrides] of Object.entries(schedulePerChallenge)) {
        sanitizeScope(overrides, `override on challenge ${challengeId}`);
    }

    mergedSettings._autoFillScheduleBoundsV1 = true;
    return true;
};

// The three scope families every scheduled-fill migration must walk:
// globalDefaults, every perChallenge override map, and every profile's values
// map. Profiles matter because _sanitizeProfileValues(failClosed=false)
// silently drops schema-invalid values on the read path — an unmigrated
// scalar inside a profile would vanish from the profile view and be lost on
// the next save. Prototype-shaped profile names are skipped, mirroring
// getChallengeProfiles' own-property iteration.
const _eachScheduledFillScope = (mergedSettings, visit) => {
    visit(mergedSettings.challengeSettings?.globalDefaults, 'global default', true);
    const perChallenge = mergedSettings.challengeSettings?.perChallenge || {};
    for (const [challengeId, overrides] of Object.entries(perChallenge)) {
        visit(overrides, `override on challenge ${challengeId}`, false);
    }
    const profiles = mergedSettings.challengeSettings?.profiles;
    if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
        for (const name of Object.keys(profiles)) {
            if (RESERVED_PROFILE_NAMES.has(_normalizeProfileName(name))) continue;
            const values = profiles[name];
            if (values && typeof values === 'object' && !Array.isArray(values)) {
                visit(values, `profile "${name}"`, false);
            }
        }
    }
};

// Migrate the scheduled-fill triggers from scalars to lists (issue #26
// follow-up: multiple fill windows per challenge). Off-sentinel handling is
// SCOPE-DEPENDENT and load-bearing:
//   - globalDefaults: '' / 0 / corrupt → delete the key. Safe there only,
//     because getGlobalDefault falls back to the schema default, which is
//     also [] after this change.
//   - perChallenge / profiles: an off-sentinel '' / 0 migrates to [] IN
//     PLACE — never delete. getChallengeOverride distinguishes "no override"
//     (null → falls through to the global default) from "override present"
//     via hasOwnProperty: deleting an explicit '' opt-out on a challenge
//     whose GLOBAL default has a time would silently re-enable daily filling
//     there, and applyChallengeProfile builds overrides purely from the
//     profile's present keys, so a deleted profile key stops enforcing the
//     off. Corrupt (non-sentinel, unparseable) scalars never expressed a
//     working intent and are deleted in every scope.
const migrateScheduledFillLists = (mergedSettings) => {
    if (mergedSettings._scheduledFillListsMigratedV1) return false;

    const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
    const migrateKey = (scope, key, label, isGlobalScope, toList) => {
        if (!scope || !Object.prototype.hasOwnProperty.call(scope, key)) return;
        const value = scope[key];
        if (Array.isArray(value)) return; // already migrated / new-shape write
        const list = toList(value);
        if (list) {
            scope[key] = list;
        } else if (isGlobalScope || !isOffSentinel(key, value)) {
            delete scope[key];
        } else {
            scope[key] = []; // explicit opt-out preserved as an explicit empty list
        }
        logger
            .withCategory('settings')
            .info(`Migrated scalar ${key} ${label} to ${JSON.stringify(scope[key] ?? '(removed)')}`, null);
    };
    const isOffSentinel = (key, value) => (key === 'scheduledFillTime' ? value === '' : value === 0);

    _eachScheduledFillScope(mergedSettings, (scope, label, isGlobalScope) => {
        migrateKey(scope, 'scheduledFillTime', label, isGlobalScope, (v) =>
            typeof v === 'string' && TIME_RE.test(v) ? [v] : null,
        );
        migrateKey(scope, 'scheduledFillBeforeEnd', label, isGlobalScope, (v) =>
            Number.isInteger(v) && v >= 1 ? [v] : null,
        );
    });

    mergedSettings._scheduledFillListsMigratedV1 = true;
    return true;
};

// One-time bounds pass over the scheduled-fill lists (dedupe, canonical sort,
// entry cap), same rationale as migrateAutoFillScheduleBounds: the Settings
// modal resubmits every persisted key on save, so one out-of-bounds array
// would block saving ANY setting, and _sanitizeProfileValues would drop a
// profile's whole key instead of keeping its valid entries. Unlike
// autoFillSchedule (structurally capped at 3 rows by count-dedupe) these
// lists have no structural ceiling, so the hot-path consumers additionally
// slice to MAX_SCHEDULED_FILL_ENTRIES defensively — a post-flag hand edit
// can't inflate per-cycle Intl work.
const migrateScheduledFillListBounds = (mergedSettings) => {
    if (mergedSettings._scheduledFillListBoundsV1) return false;

    _eachScheduledFillScope(mergedSettings, (scope, label) => {
        if (!scope) return;
        const cleanedTimes = sanitizeTimeOfDayList(scope.scheduledFillTime);
        if (cleanedTimes !== null) {
            logger
                .withCategory('settings')
                .info(`Sanitized scheduledFillTime ${label} to current bounds: ${JSON.stringify(cleanedTimes)}`, null);
            scope.scheduledFillTime = cleanedTimes;
        }
        const cleanedBefores = sanitizeBeforeEndList(scope.scheduledFillBeforeEnd);
        if (cleanedBefores !== null) {
            logger
                .withCategory('settings')
                .info(
                    `Sanitized scheduledFillBeforeEnd ${label} to current bounds: ${JSON.stringify(cleanedBefores)}`,
                    null,
                );
            scope.scheduledFillBeforeEnd = cleanedBefores;
        }
    });

    mergedSettings._scheduledFillListBoundsV1 = true;
    return true;
};

/**
 * Run every flag-gated migration over the merged settings (mutating them
 * in place) and persist the result when anything changed. Order matters:
 * the interval→schedule migration must precede the schedule-bounds pass,
 * whose output always conforms already; likewise the scheduled-fill
 * scalar→list migration precedes its bounds pass.
 */
const runMigrations = (mergedSettings) => {
    let migrationChanges = false;

    migrationChanges = migrateTimeUnits(mergedSettings) || migrationChanges;
    migrationChanges = migrateEmergencyFillTime(mergedSettings) || migrationChanges;
    migrationChanges = migrateAutoFillSchedule(mergedSettings) || migrationChanges;
    migrationChanges = migrateAutoFillScheduleBounds(mergedSettings) || migrationChanges;
    migrationChanges = migrateScheduledFillLists(mergedSettings) || migrationChanges;
    migrationChanges = migrateScheduledFillListBounds(mergedSettings) || migrationChanges;

    // If migration made changes, save the updated settings
    if (migrationChanges) {
        storage.writeRaw(JSON.stringify(mergedSettings, null, 2));
    }
};

// Load settings from the userData directory
const loadSettings = () => {
    try {
        const settingsData = readRawSettings();

        // Check if the settings exist
        if (settingsData) {
            const mergedSettings = mergeWithDefaults(JSON.parse(settingsData));

            runMigrations(mergedSettings);

            // Run obsolete-settings cleanup once per process. The
            // re-entry guard exists because cleanupObsoleteSettings
            // calls back into loadSettings.
            if (!migrationInProgress) {
                migrationInProgress = true;
                try {
                    if (!cleanupCompleted && !isAutovoteRunning()) {
                        cleanupObsoleteSettings();
                        cleanupCompleted = true;
                    } else if (isAutovoteRunning()) {
                        logger
                            .withCategory('settings')
                            .debug('⏸️ Skipping obsolete settings cleanup - autovote is running');
                    }
                } catch (migrationError) {
                    logger.withCategory('settings').warning('Cleanup failed:', migrationError);
                } finally {
                    migrationInProgress = false;
                }
            }

            return mergedSettings;
        }

        // If the file doesn't exist, return default settings
        const defaultSettings = getDefaultSettings();
        logger
            .withCategory('settings')
            .info(
                `No settings file found, loaded default settings with keys: ${Object.keys(defaultSettings).join(', ')}`,
            );
        return defaultSettings;
    } catch (error) {
        logger.withCategory('settings').error('Error loading settings:', error);
        // Return default settings if there's an error
        const defaultSettings = getDefaultSettings();
        logger
            .withCategory('settings')
            .info(`Loaded default settings with keys: ${Object.keys(defaultSettings).join(', ')}`);
        return defaultSettings;
    }
};

// Save settings to the userData directory
const saveSettings = (settings) => {
    try {
        // Merge with existing settings
        const currentSettings = loadSettings();
        const mergedSettings = { ...currentSettings, ...settings };

        // Write via storage adapter (sync fs on Electron/CLI; cache + async write-behind on Capacitor)
        storage.writeRaw(JSON.stringify(mergedSettings, null, 2));

        return true;
    } catch (error) {
        logger.withCategory('settings').error('Error saving settings:', error);
        return false;
    }
};

// Get a specific setting
const getSetting = (key) => {
    const settings = loadSettings();
    if (!settings) {
        logger.withCategory('settings').warning(`Settings not loaded, returning default for key: ${key}`);
        const defaultSettings = getDefaultSettings();
        return defaultSettings[key];
    }
    return settings[key];
};

// Set a specific setting
const setSetting = (key, value) => {
    const settings = loadSettings();
    settings[key] = value;
    return saveSettings(settings);
};

/**
 * Check if a setting requires app reload when changed
 */
const isReloadRequired = (key) => {
    // Only these settings require a reload
    const reloadSettings = ['theme', 'language', 'timezone'];

    // Check if it's a challenge-specific setting
    const isChallengeSetting = SETTINGS_SCHEMA[key] && SETTINGS_SCHEMA[key].perChallenge;

    return reloadSettings.includes(key) || isChallengeSetting;
};

// Save window bounds for a specific window type
const saveWindowBounds = (windowType, bounds) => {
    const settings = loadSettings();
    if (!settings.windowBounds) {
        settings.windowBounds = {};
    }
    settings.windowBounds[windowType] = bounds;
    return saveSettings(settings);
};

// Get window bounds for a specific window type
const getWindowBounds = (windowType) => {
    const settings = loadSettings();
    if (!settings.windowBounds || !settings.windowBounds[windowType]) {
        return getDefaultSettings().windowBounds[windowType];
    }
    return settings.windowBounds[windowType];
};

/**
 * Schema-based Settings Helper Functions
 */

/**
 * Value equality for settings comparisons. JSON-based so reference types
 * (arrays like mustIncludeTags, plain objects) compare by content — a bare
 * !== would treat every array override as "differs from default" forever.
 */
const valuesEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Get global default value for a setting
 */
const getGlobalDefault = (settingKey) => {
    const settings = loadSettings();
    const challengeSettings = settings.challengeSettings || getDefaultSettings().challengeSettings;

    if (
        challengeSettings.globalDefaults &&
        Object.prototype.hasOwnProperty.call(challengeSettings.globalDefaults, settingKey)
    ) {
        return challengeSettings.globalDefaults[settingKey];
    }

    // Fallback to schema default if not found in settings
    return SETTINGS_SCHEMA[settingKey]?.default;
};

/**
 * Set global default value for a setting
 */
const setGlobalDefault = (settingKey, value) => {
    if (!SETTINGS_SCHEMA[settingKey]) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return false;
    }

    // Get current global defaults for context validation
    const settings = loadSettings();
    const currentGlobalDefaults = settings.challengeSettings?.globalDefaults || {};
    const contextSettings = { ...currentGlobalDefaults, [settingKey]: value };

    // Get detailed validation error information
    const validationError = getValidationError(settingKey, value, contextSettings);
    if (validationError) {
        logger.withCategory('settings').error(`Invalid value for setting ${settingKey}:`, value);
        logger.withCategory('settings').error(validationError, null);
        return false;
    }

    if (!settings.challengeSettings) {
        settings.challengeSettings = getDefaultSettings().challengeSettings;
    }
    if (!settings.challengeSettings.globalDefaults) {
        settings.challengeSettings.globalDefaults = {};
    }

    settings.challengeSettings.globalDefaults[settingKey] = value;
    return saveSettings(settings);
};

/**
 * Get per-challenge override value for a setting
 */
const getChallengeOverride = (settingKey, challengeId) => {
    const settings = loadSettings();
    const challengeSettings = settings.challengeSettings || getDefaultSettings().challengeSettings;

    if (
        challengeSettings.perChallenge &&
        challengeSettings.perChallenge[challengeId] &&
        Object.prototype.hasOwnProperty.call(challengeSettings.perChallenge[challengeId], settingKey)
    ) {
        return challengeSettings.perChallenge[challengeId][settingKey];
    }

    return null;
};

/**
 * Ensures the challengeSettings.perChallenge[challengeId] container
 * exists on the given settings object and returns it.
 */
const _ensureChallengeContainer = (settings, challengeId) => {
    if (!settings.challengeSettings) {
        settings.challengeSettings = getDefaultSettings().challengeSettings;
    }
    if (!settings.challengeSettings.perChallenge) {
        settings.challengeSettings.perChallenge = {};
    }
    if (!settings.challengeSettings.perChallenge[challengeId]) {
        settings.challengeSettings.perChallenge[challengeId] = {};
    }
    return settings.challengeSettings.perChallenge[challengeId];
};

/**
 * Validates a per-challenge override and writes it onto the in-memory
 * settings object. Returns one of: 'invalid' (rejected),
 * 'set' (override stored), 'cleared' (override removed because it
 * matched the global default).
 */
const _applyChallengeOverride = (settings, settingKey, challengeId, value, batchOverrides = null) => {
    if (!SETTINGS_SCHEMA[settingKey]) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return 'invalid';
    }
    if (!SETTINGS_SCHEMA[settingKey].perChallenge) {
        logger.withCategory('settings').error(`Setting ${settingKey} does not support per-challenge overrides`, null);
        return 'invalid';
    }

    const globalDefaults = settings.challengeSettings?.globalDefaults || {};
    const existingOverrides = settings.challengeSettings?.perChallenge?.[challengeId] || {};
    const contextSettings = batchOverrides
        ? { ...globalDefaults, ...existingOverrides, ...batchOverrides }
        : { ...globalDefaults, ...existingOverrides, [settingKey]: value };

    if (!validateSetting(settingKey, value, contextSettings, challengeId)) {
        logger.withCategory('settings').error(`Invalid value for setting ${settingKey}:`, value);
        return 'invalid';
    }

    const container = _ensureChallengeContainer(settings, challengeId);
    if (!valuesEqual(value, getGlobalDefault(settingKey))) {
        container[settingKey] = value;
        return 'set';
    }
    delete container[settingKey];
    return 'cleared';
};

/**
 * Set per-challenge override value for a setting.
 */
const setChallengeOverride = (settingKey, challengeId, value) => {
    const settings = loadSettings();
    const result = _applyChallengeOverride(settings, settingKey, challengeId, value);
    if (result === 'invalid') return false;

    // If the cleared override left the challenge container empty, drop it.
    const container = settings.challengeSettings?.perChallenge?.[challengeId];
    if (container && Object.keys(container).length === 0) {
        delete settings.challengeSettings.perChallenge[challengeId];
    }
    return saveSettings(settings);
};

/**
 * Set multiple per-challenge overrides efficiently, only saving values
 * that differ from global defaults.
 */
const setChallengeOverrides = (challengeId, overrides) => {
    const settings = loadSettings();
    _ensureChallengeContainer(settings, challengeId);

    const savedOverrides = [];
    const removedOverrides = [];
    let hasChanges = false;

    for (const [settingKey, value] of Object.entries(overrides)) {
        const result = _applyChallengeOverride(settings, settingKey, challengeId, value, overrides);
        if (result === 'set') {
            savedOverrides.push(`${settingKey}=${value}`);
            hasChanges = true;
        } else if (result === 'cleared') {
            removedOverrides.push(settingKey);
            hasChanges = true;
        }
    }

    if (Object.keys(settings.challengeSettings.perChallenge[challengeId]).length === 0) {
        delete settings.challengeSettings.perChallenge[challengeId];
        logger.withCategory('settings').debug(`🗑️ Removed empty challenge settings for challenge ${challengeId}`);
        hasChanges = true;
    }

    if (savedOverrides.length > 0) {
        logger
            .withCategory('general')
            .debug(`💾 Saved overrides for challenge ${challengeId}:`, savedOverrides.join(', '));
    }
    if (removedOverrides.length > 0) {
        logger
            .withCategory('general')
            .debug(`🗑️ Removed overrides for challenge ${challengeId}:`, removedOverrides.join(', '));
    }

    return hasChanges ? saveSettings(settings) : true;
};

/**
 * Remove per-challenge override for a setting
 */
const removeChallengeOverride = (settingKey, challengeId) => {
    const settings = loadSettings();
    if (
        !settings.challengeSettings ||
        !settings.challengeSettings.perChallenge ||
        !settings.challengeSettings.perChallenge[challengeId]
    ) {
        return true; // Nothing to remove
    }

    delete settings.challengeSettings.perChallenge[challengeId][settingKey];

    // If challenge has no more overrides, remove the challenge entry
    if (Object.keys(settings.challengeSettings.perChallenge[challengeId]).length === 0) {
        delete settings.challengeSettings.perChallenge[challengeId];
    }

    return saveSettings(settings);
};

/**
 * Returns a per-challenge exposure-threshold resolver. Falls back to the
 * schema default if a corrupt override would otherwise stall the cycle.
 * Single source so the IPC handlers and middleware agree.
 */
const getExposureResolver = () => (challengeId) => {
    try {
        return getEffectiveSetting('exposure', challengeId);
    } catch (error) {
        logger.withCategory('settings').warning(`Error getting exposure setting for challenge ${challengeId}:`, error);
        return SETTINGS_SCHEMA.exposure.default;
    }
};

/**
 * Get the effective value for a setting (per-challenge override or global default)
 */
const getEffectiveSetting = (settingKey, challengeId = null) => {
    if (!SETTINGS_SCHEMA[settingKey]) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return SETTINGS_SCHEMA[settingKey]?.default;
    }

    // If challengeId is provided and the setting supports per-challenge overrides, check for override
    if (challengeId && SETTINGS_SCHEMA[settingKey].perChallenge) {
        const override = getChallengeOverride(settingKey, challengeId);
        if (override !== null) {
            return override;
        }
    }

    // Return global default
    return getGlobalDefault(settingKey);
};

/**
 * Title-keyed tag rules. The setting keys these rules can carry — only the
 * two tag lists are title-scoped; everything else stays id-keyed.
 */
const TITLE_RULE_TAG_KEYS = ['mustIncludeTags', 'shouldIncludeTags'];

// Defensive caps on renderer-supplied title-rule input. The rules share the
// single settings JSON blob with every platform, so bound both the count and
// the per-title length to keep a malformed/oversized payload from bloating the
// file and slowing every findTitleRule scan. Real GuruShots titles are short,
// so 200 is comfortably generous for both.
const MAX_TITLE_RULES = 200;
const MAX_TITLE_LENGTH = 200;

// Stable match key for a challenge title: trimmed + lowercased. The same
// challenge recurs with the same title (but a new id) on each rotation, so
// this is what survives a rotation.
const normalizeTitle = (title) => (typeof title === 'string' ? title.trim().toLowerCase() : '');

/**
 * Order-preserving union of two tag lists with the base first. A null /
 * non-array base is treated as empty so the result is always a real array
 * when `extra` has entries.
 */
const unionTags = (base, extra) => {
    const out = [];
    const seen = new Set();
    for (const list of [Array.isArray(base) ? base : [], Array.isArray(extra) ? extra : []]) {
        for (const tag of list) {
            if (typeof tag !== 'string') continue;
            if (seen.has(tag)) continue;
            seen.add(tag);
            out.push(tag);
        }
    }
    return out;
};

/**
 * Get the saved title→tags rules. Tolerates settings persisted before this
 * feature existed (loadSettings shallow-merges, so an older challengeSettings
 * block overrides the default whole and has no titleRules array).
 */
const getTitleRules = () => {
    const settings = loadSettings();
    const rules = settings.challengeSettings?.titleRules;
    return Array.isArray(rules) ? rules : [];
};

/**
 * Find the first title rule matching a challenge title (exact, case-insensitive,
 * trimmed). Returns null when there is no title or no match.
 */
const findTitleRule = (title) => {
    const key = normalizeTitle(title);
    if (!key) return null;
    return getTitleRules().find((rule) => normalizeTitle(rule?.title) === key) || null;
};

/**
 * Persist the title→tags rules. Sanitizes input: trims titles, validates each
 * tag list against the schema's tag validator, drops rules with an empty title
 * or with both tag lists empty, and de-dupes by normalized title (last wins).
 */
const setTitleRules = (rules) => {
    if (!Array.isArray(rules)) {
        logger.withCategory('settings').error('setTitleRules expects an array', null);
        return false;
    }
    if (rules.length > MAX_TITLE_RULES) {
        logger
            .withCategory('settings')
            .error(`setTitleRules rejected: ${rules.length} rules exceeds the ${MAX_TITLE_RULES} cap`, null);
        return false;
    }

    // Bound a user-supplied title before it reaches a log line so an oversized
    // value can't produce a huge log event (defense in depth for log shipping).
    const forLog = (title) => (title.length > 80 ? `${title.slice(0, 80)}…` : title);

    const sanitizeTagList = (key, value) => {
        const list = (Array.isArray(value) ? value : [])
            .filter((tag) => typeof tag === 'string')
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0);
        // Reuse the schema's tags validator (tagsList: per-tag length + count caps).
        return validateSetting(key, list) ? list : null;
    };

    // De-dupe by normalized title, last occurrence wins, preserving the
    // user-facing title casing of that last occurrence.
    const byKey = new Map();
    for (const rule of rules) {
        const title = typeof rule?.title === 'string' ? rule.title.trim() : '';
        if (!title) continue;
        if (title.length > MAX_TITLE_LENGTH) {
            logger
                .withCategory('settings')
                .error(`Title rule rejected: title for "${forLog(title)}" exceeds ${MAX_TITLE_LENGTH} chars`, null);
            return false;
        }

        const mustIncludeTags = sanitizeTagList('mustIncludeTags', rule?.mustIncludeTags);
        const shouldIncludeTags = sanitizeTagList('shouldIncludeTags', rule?.shouldIncludeTags);
        if (mustIncludeTags === null || shouldIncludeTags === null) {
            logger.withCategory('settings').error(`Invalid tags in title rule for "${forLog(title)}"`, null);
            return false;
        }
        // A rule that contributes no tags is a no-op — drop it.
        if (mustIncludeTags.length === 0 && shouldIncludeTags.length === 0) continue;

        byKey.set(normalizeTitle(title), { title, mustIncludeTags, shouldIncludeTags });
    }

    const settings = loadSettings();
    if (!settings.challengeSettings) {
        settings.challengeSettings = getDefaultSettings().challengeSettings;
    }
    settings.challengeSettings.titleRules = Array.from(byKey.values());
    return saveSettings(settings);
};

// Defensive cap on the pin map size so an anomalously large challenge list
// can't bloat the shared settings blob. Real active lists are tens of
// entries; 500 is far above anything GuruShots returns.
const MAX_TITLE_PINS = 500;

// One warning while the cap stays saturated (cleared once the map drops back
// under it) — an anomalous response would otherwise re-log every fetch cycle.
let titlePinCapWarned = false;

/**
 * Get the persisted first-seen challenge-title pins as `{ [id]: title }`.
 * Returns a defensive copy so callers can't mutate stored state around
 * mergeTitlePins' validation. Copies via own-property iteration so an id
 * named `__proto__`/`constructor` can never surface a prototype member.
 *
 * No IPC wiring — deliberate asymmetry with titleRules (which has a
 * user-facing editor): pins are an internal, automatically-maintained cache.
 */
const getTitlePins = () => {
    const settings = loadSettings();
    const stored = settings.challengeSettings?.titlePins;
    const pins = {};
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        for (const id of Object.keys(stored)) {
            const title = stored[id];
            // Mirror mergeTitlePins' write-side trim check so a whitespace-only
            // value in a hand-edited/corrupted blob can't become a "pin" that
            // blanks a real incoming title.
            if (typeof title === 'string' && title.trim() !== '') {
                pins[id] = title;
            }
        }
    }
    return pins;
};

/**
 * Merge title pins into the persisted map — never a wholesale replace. Inside
 * the write the stored map is re-read; `adds` apply only to ids with no
 * existing pin (first-seen wins, so a concurrent writer's fresh pin is never
 * clobbered) and `removeIds` are deleted. Titles are truncated to
 * MAX_TITLE_LENGTH and the map is capped at MAX_TITLE_PINS entries.
 */
const mergeTitlePins = (adds, removeIds) => {
    const addEntries =
        adds && typeof adds === 'object' && !Array.isArray(adds)
            ? Object.entries(adds).filter(([, title]) => typeof title === 'string' && title.trim() !== '')
            : [];
    const removeList = Array.isArray(removeIds) ? removeIds.filter((id) => typeof id === 'string') : [];
    if (addEntries.length === 0 && removeList.length === 0) return true;

    const settings = loadSettings();
    if (!settings.challengeSettings) {
        settings.challengeSettings = getDefaultSettings().challengeSettings;
    }
    const stored = settings.challengeSettings.titlePins;
    // Rebuild via own-property copy (drops prototype-named keys and any
    // non-string/whitespace-only values a corrupted blob might carry).
    const pins = {};
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        for (const id of Object.keys(stored)) {
            if (typeof stored[id] === 'string' && stored[id].trim() !== '') {
                pins[id] = stored[id];
            }
        }
    }

    for (const id of removeList) {
        delete pins[id];
    }
    for (const [id, title] of addEntries) {
        if (Object.prototype.hasOwnProperty.call(pins, id)) continue; // first-seen wins
        if (Object.keys(pins).length >= MAX_TITLE_PINS) {
            // The id originates from the untrusted API response — strip CR/LF
            // and bound it before it reaches a log line (log-injection guard,
            // same treatment as logger.challengeTag). Warn once until the map
            // drops back under the cap, not on every fetch cycle.
            if (!titlePinCapWarned) {
                titlePinCapWarned = true;
                const safeId = String(id)
                    .replace(/[\r\n\t]/g, ' ')
                    .slice(0, 80);
                logger
                    .withCategory('settings')
                    .warning(
                        `mergeTitlePins: pin cap of ${MAX_TITLE_PINS} reached — not pinning challenge ${safeId}`,
                        null,
                    );
            }
            break;
        }
        pins[id] = title.slice(0, MAX_TITLE_LENGTH);
    }
    if (Object.keys(pins).length < MAX_TITLE_PINS) {
        titlePinCapWarned = false;
    }

    settings.challengeSettings.titlePins = pins;
    return saveSettings(settings);
};

/**
 * Effective value for one of the title-scoped tag lists. Starts from the
 * id-keyed effective value (per-challenge override or global default) and, when
 * a title rule matches, unions that rule's tags on top — so a recurring
 * challenge picks up its tags by title regardless of its rotating id.
 *
 * Falls back to plain getEffectiveSetting for any non-tag key, and preserves
 * the null "no filter" sentinel when there is no rule to contribute tags.
 */
const getEffectiveTagSetting = (settingKey, challenge) => {
    const challengeId = challenge?.id != null ? String(challenge.id) : null;
    const base = getEffectiveSetting(settingKey, challengeId);
    if (!TITLE_RULE_TAG_KEYS.includes(settingKey)) return base;

    const rule = findTitleRule(challenge?.title);
    const ruleTags = rule?.[settingKey];
    if (!Array.isArray(ruleTags) || ruleTags.length === 0) return base;

    return unionTags(base, ruleTags);
};

// Named challenge-settings profiles ("save this tactic, recall it later").
// Stored as challengeSettings.profiles = { [displayName]: { [settingKey]: value } }
// — name-keyed, NOT challenge-id-keyed, because ids rotate and id-keyed state
// gets pruned by cleanupStaleChallengeSetting. A profile holds only the sparse
// overrides that differ from global defaults, so later global-default tuning
// flows through every profile.
const MAX_CHALLENGE_PROFILES = 50;
const MAX_PROFILE_NAME_LENGTH = 60;

// A bare `profiles['__proto__'] = …` assignment reassigns the map's prototype
// instead of storing data (silent data loss + corrupted lookups), so these
// names are rejected on write and skipped on read — same guard family as
// getTitlePins' own-property iteration.
const RESERVED_PROFILE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

// Identity key for a profile name: trimmed + lowercased (the normalizeTitle
// contract) so "Portrait" and "portrait" are one profile, latest casing wins.
const _normalizeProfileName = (name) => (typeof name === 'string' ? name.trim().toLowerCase() : '');

// Bound a user-supplied profile name before it reaches a log line
// (log-injection guard, same treatment as setTitleRules' forLog).
const _profileNameForLog = (name) =>
    String(name)
        .replace(/[\r\n\t]/g, ' ')
        .slice(0, 80);

/**
 * Returns the stored profiles map when it is a plain object, else `{}`.
 * Never returns arrays or primitives from a corrupted blob.
 */
const _readProfilesMap = (settings) => {
    const stored = settings.challengeSettings?.profiles;
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
};

/**
 * Sanitize a profile's values map. Keeps only keys that are perChallenge in
 * SETTINGS_SCHEMA (unknown keys validate as true in validateSetting, so the
 * whitelist is mandatory) and validates each value with the full batch as
 * context so cross-field rules (e.g. exposureTarget >= exposure) hold.
 *
 * failClosed=true (save/apply): returns null on any invalid value, logging the
 * failing key. failClosed=false (read): drops invalid values silently — the
 * schema may have evolved since the profile was saved.
 */
const _sanitizeProfileValues = (values, failClosed, globalDefaults) => {
    const rejected = failClosed ? null : {};
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
        return rejected;
    }
    const rawKeys = Object.keys(values);
    // Coarse ceiling far above the schema's perChallenge key count — bounds
    // the work an oversized IPC payload can force before per-key validation.
    if (rawKeys.length > 100) {
        return rejected;
    }

    const whitelisted = {};
    for (const key of rawKeys) {
        // Prototype-shaped keys fall out here too: SETTINGS_SCHEMA['__proto__']
        // resolves to Object.prototype, whose .perChallenge is undefined.
        if (SETTINGS_SCHEMA[key]?.perChallenge) {
            whitelisted[key] = values[key];
        }
    }

    const contextSettings = { ...globalDefaults, ...whitelisted };
    const sanitized = {};
    for (const [key, value] of Object.entries(whitelisted)) {
        if (validateSetting(key, value, contextSettings)) {
            sanitized[key] = value;
        } else if (failClosed) {
            logger.withCategory('settings').error(`Invalid profile value for setting ${key}:`, value);
            return null;
        }
    }
    return sanitized;
};

/**
 * Find the stored key of the profile matching a normalized name, skipping
 * reserved/prototype-shaped stored keys. Returns null when absent.
 */
const _findProfileKey = (stored, normalizedName) => {
    for (const name of Object.keys(stored)) {
        const key = _normalizeProfileName(name);
        if (RESERVED_PROFILE_NAMES.has(key)) continue;
        if (key === normalizedName) return name;
    }
    return null;
};

/**
 * Batch reader for one challenge's sparse override map. Own-property-safe
 * copy filtered to schema-known perChallenge keys — shared by the GUI modal
 * load and the CLI save-profile snapshot.
 */
const getChallengeOverrides = (challengeId) => {
    const settings = loadSettings();
    const perChallenge = settings.challengeSettings?.perChallenge;
    const overrides = {};
    if (
        perChallenge &&
        typeof perChallenge === 'object' &&
        Object.prototype.hasOwnProperty.call(perChallenge, challengeId)
    ) {
        const stored = perChallenge[challengeId];
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
            for (const key of Object.keys(stored)) {
                if (SETTINGS_SCHEMA[key]?.perChallenge) {
                    overrides[key] = stored[key];
                }
            }
        }
    }
    return overrides;
};

/**
 * Get the saved profiles as `{ [displayName]: { [settingKey]: value } }`.
 * Defensive copy; values are sanitized drop-silently (stale schema keys and
 * now-invalid values disappear from the view without rewriting storage — the
 * next save of that profile persists the sanitized form).
 */
const getChallengeProfiles = () => {
    const settings = loadSettings();
    const stored = _readProfilesMap(settings);
    const globalDefaults = settings.challengeSettings?.globalDefaults || {};
    const profiles = {};
    for (const name of Object.keys(stored)) {
        if (RESERVED_PROFILE_NAMES.has(_normalizeProfileName(name))) continue;
        profiles[name] = _sanitizeProfileValues(stored[name], false, globalDefaults);
    }
    return profiles;
};

/**
 * Save (or overwrite) a named profile. Fail-closed: rejects a bad/reserved
 * name, the profile-count cap (new names only — overwriting an existing name
 * always succeeds), a non-plain-object values payload, or any invalid value.
 * An empty values map is allowed — it's a useful "all global defaults" preset.
 */
const saveChallengeProfile = (name, values) => {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    const normalized = _normalizeProfileName(trimmed);
    if (!trimmed || trimmed.length > MAX_PROFILE_NAME_LENGTH || RESERVED_PROFILE_NAMES.has(normalized)) {
        logger.withCategory('settings').error(`Invalid profile name: "${_profileNameForLog(name)}"`, null);
        return false;
    }

    const settings = loadSettings();
    const globalDefaults = settings.challengeSettings?.globalDefaults || {};
    const sanitized = _sanitizeProfileValues(values, true, globalDefaults);
    if (sanitized === null) {
        return false;
    }

    if (!settings.challengeSettings) {
        settings.challengeSettings = getDefaultSettings().challengeSettings;
    }
    const stored = _readProfilesMap(settings);
    // Rebuild via own-property copy: drops prototype-named keys a corrupted
    // blob might carry, and lets a same-normalized-name save replace the old
    // casing in place.
    const profiles = {};
    let existed = false;
    for (const existingName of Object.keys(stored)) {
        const key = _normalizeProfileName(existingName);
        if (RESERVED_PROFILE_NAMES.has(key)) continue;
        if (key === normalized) {
            existed = true;
            continue;
        }
        profiles[existingName] = stored[existingName];
    }
    if (!existed && Object.keys(profiles).length >= MAX_CHALLENGE_PROFILES) {
        logger
            .withCategory('settings')
            .error(`saveChallengeProfile rejected: profile cap of ${MAX_CHALLENGE_PROFILES} reached`, null);
        return false;
    }
    profiles[trimmed] = sanitized;
    settings.challengeSettings.profiles = profiles;
    return saveSettings(settings);
};

/**
 * Delete a profile by name (case-insensitive on the normalized name).
 * Returns false when no such profile exists.
 */
const deleteChallengeProfile = (name) => {
    const normalized = _normalizeProfileName(name);
    if (!normalized || RESERVED_PROFILE_NAMES.has(normalized)) {
        return false;
    }
    const settings = loadSettings();
    const stored = _readProfilesMap(settings);
    const storedKey = _findProfileKey(stored, normalized);
    if (storedKey === null) {
        return false;
    }
    delete stored[storedKey];
    settings.challengeSettings.profiles = stored;
    return saveSettings(settings);
};

/**
 * Apply a profile to a challenge: atomically REPLACE the challenge's whole
 * override container with the profile's sanitized values in one
 * load-modify-save.
 *
 * Deliberately NOT setChallengeOverrides + removeChallengeOverride sweeps:
 * that path validates each profile key against a context still containing the
 * challenge's stale, about-to-be-removed overrides (so e.g. a stale
 * exposure=95 override rejects a profile's exposureTarget=80), silently
 * swallows 'invalid' results, and leaves a multi-write window a running vote
 * loop could observe half-applied. Here every value is validated against
 * {globalDefaults + profile} — the same context the profile was saved under —
 * and nothing is written unless all of it passes.
 */
const applyChallengeProfile = (name, challengeId) => {
    const id = challengeId === null || challengeId === undefined ? '' : String(challengeId).trim();
    if (!id) {
        logger.withCategory('settings').error('applyChallengeProfile requires a challenge id', null);
        return false;
    }

    const normalized = _normalizeProfileName(name);
    if (!normalized || RESERVED_PROFILE_NAMES.has(normalized)) {
        logger.withCategory('settings').error(`Invalid profile name: "${_profileNameForLog(name)}"`, null);
        return false;
    }

    const settings = loadSettings();
    const stored = _readProfilesMap(settings);
    const storedKey = _findProfileKey(stored, normalized);
    if (storedKey === null) {
        logger.withCategory('settings').error(`Profile not found: "${_profileNameForLog(name)}"`, null);
        return false;
    }

    const globalDefaults = settings.challengeSettings?.globalDefaults || {};
    // Fail-closed: _sanitizeProfileValues logs the failing key, so a
    // schema-drifted profile's failure is diagnosable from the log.
    const sanitized = _sanitizeProfileValues(stored[storedKey], true, globalDefaults);
    if (sanitized === null) {
        return false;
    }

    if (!settings.challengeSettings.perChallenge) {
        settings.challengeSettings.perChallenge = {};
    }
    const container = {};
    for (const [settingKey, value] of Object.entries(sanitized)) {
        // Same pruning rule as _applyChallengeOverride: a value equal to its
        // effective global default is redundant as an override.
        const defaultValue = Object.prototype.hasOwnProperty.call(globalDefaults, settingKey)
            ? globalDefaults[settingKey]
            : SETTINGS_SCHEMA[settingKey]?.default;
        if (!valuesEqual(value, defaultValue)) {
            container[settingKey] = value;
        }
    }
    if (Object.keys(container).length > 0) {
        settings.challengeSettings.perChallenge[id] = container;
    } else {
        delete settings.challengeSettings.perChallenge[id];
    }
    return saveSettings(settings);
};

/**
 * Seed the curated "intent" presets (settings/intentProfiles.js) into the
 * named-profiles store on first run. Idempotent and collision-safe:
 *
 *  - A per-profile marker in `challengeSettings.seededProfiles` (normalized
 *    names) records which intents were already seeded, so deleting one does
 *    NOT resurrect it on the next run.
 *  - An intent is written only when no profile with that normalized name
 *    already exists — a user's own same-named profile is never clobbered.
 *  - Seeding goes through saveChallengeProfile so the reserved-name guard,
 *    perChallenge whitelist, and zod + contextValidation-as-a-set all run in
 *    the vetted path. Bundles are self-contained, so a validation failure is
 *    structural (schema drift): it is logged and the intent is marked seeded
 *    anyway to avoid retrying every load.
 *
 * Returns true when nothing needed seeding or the seed-marker write succeeded.
 */
const seedIntentProfiles = () => {
    const settings = loadSettings();
    const priorSeeded = Array.isArray(settings.challengeSettings?.seededProfiles)
        ? settings.challengeSettings.seededProfiles
        : [];
    const seededSet = new Set(priorSeeded.map(_normalizeProfileName));
    const stored = _readProfilesMap(settings);

    let changed = false;
    for (const intent of INTENT_PROFILES) {
        const normalized = _normalizeProfileName(intent.name);
        if (seededSet.has(normalized)) continue; // already seeded once — respect a later deletion
        // Never overwrite a user's own same-named profile.
        if (_findProfileKey(stored, normalized) === null) {
            const ok = saveChallengeProfile(intent.name, intent.values);
            if (!ok) {
                logger
                    .withCategory('settings')
                    .warning(
                        `Skipped seeding intent profile "${_profileNameForLog(intent.name)}" (invalid for this install)`,
                    );
            }
        }
        // Mark seeded regardless of outcome (success, name collision, or a
        // structural validation failure) so it is attempted at most once.
        seededSet.add(normalized);
        changed = true;
    }

    if (!changed) return true;

    // saveChallengeProfile persisted the new profiles via its own load/save,
    // so re-load fresh before recording the seed markers to avoid clobbering
    // them with this now-stale snapshot.
    const fresh = loadSettings();
    if (!fresh.challengeSettings) {
        fresh.challengeSettings = getDefaultSettings().challengeSettings;
    }
    fresh.challengeSettings.seededProfiles = Array.from(seededSet);
    return saveSettings(fresh);
};

/**
 * Cleanup stale challenge settings for challenges that no longer exist
 */
const cleanupStaleChallengeSetting = (activeChallengeIds) => {
    const settings = loadSettings();
    if (!settings.challengeSettings || !settings.challengeSettings.perChallenge) {
        return true; // Nothing to cleanup
    }

    const storedChallengeIds = Object.keys(settings.challengeSettings.perChallenge);
    const staleChallengeIds = storedChallengeIds.filter((id) => !activeChallengeIds.includes(id));

    if (staleChallengeIds.length === 0) {
        return true; // Nothing to cleanup
    }

    logger
        .withCategory('settings')
        .debug(`Cleaning up settings for ${staleChallengeIds.length} stale challenges:`, staleChallengeIds);

    staleChallengeIds.forEach((challengeId) => {
        delete settings.challengeSettings.perChallenge[challengeId];
    });

    return saveSettings(settings);
};

/**
 * Clean up obsolete settings that are no longer used
 */
const cleanupObsoleteSettings = () => {
    try {
        const settings = loadSettings();
        let hasChanges = false;

        if (settings.boostConfig) {
            logger.withCategory('settings').debug('Removing legacy boostConfig', null);
            delete settings.boostConfig;
            hasChanges = true;
        }

        // Clean up challengeSettings structure
        if (settings.challengeSettings) {
            // Ensure globalDefaults only contains valid schema keys
            if (settings.challengeSettings.globalDefaults) {
                const validSchemaKeys = Object.keys(SETTINGS_SCHEMA);
                const globalDefaultKeys = Object.keys(settings.challengeSettings.globalDefaults);
                const invalidGlobalKeys = globalDefaultKeys.filter((key) => !validSchemaKeys.includes(key));

                if (invalidGlobalKeys.length > 0) {
                    logger
                        .withCategory('settings')
                        .debug(`Removing invalid global default keys: ${invalidGlobalKeys.join(', ')}`);
                    invalidGlobalKeys.forEach((key) => {
                        delete settings.challengeSettings.globalDefaults[key];
                        hasChanges = true;
                    });
                }
            }

            // Clean up perChallenge overrides
            if (settings.challengeSettings.perChallenge) {
                const validSchemaKeys = Object.keys(SETTINGS_SCHEMA);
                const challengeIds = Object.keys(settings.challengeSettings.perChallenge);

                for (const challengeId of challengeIds) {
                    const challengeOverrides = settings.challengeSettings.perChallenge[challengeId];
                    const invalidKeys = Object.keys(challengeOverrides).filter((key) => !validSchemaKeys.includes(key));

                    if (invalidKeys.length > 0) {
                        logger
                            .withCategory('settings')
                            .debug(`Removing invalid override keys for challenge ${challengeId}:`, invalidKeys);
                        invalidKeys.forEach((key) => {
                            delete challengeOverrides[key];
                            hasChanges = true;
                        });
                    }

                    if (Object.keys(challengeOverrides).length === 0) {
                        delete settings.challengeSettings.perChallenge[challengeId];
                        hasChanges = true;
                    }
                }
            }
        }

        // Save cleaned settings if any changes were made
        if (hasChanges) {
            logger.withCategory('settings').debug('Settings cleanup completed - saving cleaned settings');
            saveSettings(settings);
        }
    } catch (error) {
        logger.withCategory('settings').error('Error during settings cleanup:', error);
    }
};

/**
 * Reset Functionality
 */

/**
 * Reset a single setting to its default value
 */
const resetSetting = (key) => {
    try {
        const defaultSettings = getDefaultSettings();

        if (!Object.prototype.hasOwnProperty.call(defaultSettings, key)) {
            logger.withCategory('settings').error(`Invalid setting key: ${key}`, null);
            return false;
        }

        const defaultValue = defaultSettings[key];
        return setSetting(key, defaultValue);
    } catch (error) {
        logger.withCategory('settings').error(`Error resetting setting ${key}:`, error);
        return false;
    }
};

/**
 * Reset global default for a schema-based setting
 */
const resetGlobalDefault = (settingKey) => {
    if (!SETTINGS_SCHEMA[settingKey]) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return false;
    }

    const defaultValue = SETTINGS_SCHEMA[settingKey].default;
    return setGlobalDefault(settingKey, defaultValue);
};

/**
 * Reset all global defaults for schema-based settings
 */
const resetAllGlobalDefaults = () => {
    try {
        const settings = loadSettings();
        if (!settings.challengeSettings) {
            settings.challengeSettings = getDefaultSettings().challengeSettings;
        }

        // Reset all global defaults to schema defaults
        const globalDefaults = {};
        Object.keys(SETTINGS_SCHEMA).forEach((key) => {
            globalDefaults[key] = SETTINGS_SCHEMA[key].default;
        });

        settings.challengeSettings.globalDefaults = globalDefaults;
        return saveSettings(settings);
    } catch (error) {
        logger.withCategory('settings').error('Error resetting all global defaults:', error);
        return false;
    }
};

/**
 * Reset all settings to their default values (preserves only essential user data)
 */
const resetAllSettings = () => {
    try {
        const currentSettings = loadSettings();
        const defaultSettings = getDefaultSettings();

        // Settings to preserve (only essential user data that shouldn't be reset)
        const preserveKeys = ['token', 'mock', 'apiHeaders'];

        // Start with defaults
        const newSettings = { ...defaultSettings };

        // Preserve specified user data
        preserveKeys.forEach((key) => {
            if (currentSettings[key] !== undefined) {
                newSettings[key] = currentSettings[key];
            }
        });

        // Save the reset settings
        const saveResult = saveSettings(newSettings);

        // Run cleanup to remove any obsolete settings
        if (saveResult) {
            cleanupObsoleteSettings();
        }

        return saveResult;
    } catch (error) {
        logger.withCategory('settings').error('Error resetting all settings:', error);
        return false;
    }
};

/**
 * Check if a setting has been modified from its default value
 */
const isSettingModified = (key) => {
    try {
        const currentSettings = loadSettings();
        const defaultSettings = getDefaultSettings();

        if (!Object.prototype.hasOwnProperty.call(defaultSettings, key)) {
            return false;
        }

        const currentValue = currentSettings[key];
        const defaultValue = defaultSettings[key];

        return !valuesEqual(currentValue, defaultValue);
    } catch (error) {
        logger.withCategory('settings').error(`Error checking if setting ${key} is modified:`, error);
        return false;
    }
};

/**
 * Check if a global default has been modified from its schema default
 */
const isGlobalDefaultModified = (settingKey) => {
    try {
        if (!SETTINGS_SCHEMA[settingKey]) {
            return false;
        }

        const currentValue = getGlobalDefault(settingKey);
        const schemaDefault = SETTINGS_SCHEMA[settingKey].default;

        return !valuesEqual(currentValue, schemaDefault);
    } catch (error) {
        logger.withCategory('settings').error(`Error checking if global default ${settingKey} is modified:`, error);
        return false;
    }
};

module.exports = {
    initializeAsync,
    flushPendingWrites,
    loadSettings,
    saveSettings,
    getSetting,
    setSetting,
    isReloadRequired,
    getDefaultSettings,
    getUserDataPath,
    getSettingsPath,
    saveWindowBounds,
    getWindowBounds,

    // Environment detection functions
    getEnvironmentInfo,

    // Challenge-specific settings
    getGlobalDefault,
    setGlobalDefault,
    getChallengeOverride,
    setChallengeOverride,
    setChallengeOverrides,
    removeChallengeOverride,
    getEffectiveSetting,
    getExposureResolver,

    // Title-keyed tag rules (survive challenge rotation)
    getTitleRules,
    setTitleRules,
    getEffectiveTagSetting,

    // Named challenge-settings profiles (survive challenge rotation).
    // The caps are exported so tests and the get-settings-schema handler
    // share the same literals the facade enforces.
    getChallengeOverrides,
    getChallengeProfiles,
    saveChallengeProfile,
    deleteChallengeProfile,
    applyChallengeProfile,
    seedIntentProfiles,
    MAX_CHALLENGE_PROFILES,
    MAX_PROFILE_NAME_LENGTH,

    // First-seen challenge-title pins (internal cache — no IPC wiring).
    // MAX_TITLE_LENGTH is exported so challengeTitlePin.js bounds incoming
    // titles with the SAME cap mergeTitlePins stores with — two drifting
    // literals would make an over-length title permanently mismatch its own
    // truncated pin (warn + overwrite on every fetch).
    getTitlePins,
    mergeTitlePins,
    MAX_TITLE_LENGTH,

    // Cleanup functions
    cleanupStaleChallengeSetting,
    cleanupObsoleteSettings,

    // Reset functions
    resetSetting,
    resetGlobalDefault,
    resetAllGlobalDefaults,
    resetAllSettings,

    // Validation functions
    getValidationError,

    // Utility functions
    getSettingsSchema,
    isSettingModified,
    isGlobalDefaultModified,

    // Schema
    SETTINGS_SCHEMA,
    SETTINGS_GROUPS,
};
