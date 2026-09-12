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
            // fill time. A rule may also assign one named settings profile,
            // which becomes the inherited baseline below any id-keyed manual
            // overrides. Shape:
            // [{ title, profile?, mustIncludeTags: [], shouldIncludeTags: [] }].
            titleRules: [],
            // Challenge ids where a manually applied named profile replaces,
            // rather than layers over, an automatic title profile.
            titleProfileSuppressions: {},
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

// Rename the "last hour exposure" feature keys to their "final window"
// equivalents (the fixed 1h window became the configurable finalWindowDuration
// setting). A pure key rename that must run BEFORE cleanupObsoleteSettings,
// which would otherwise delete the now-schemaless old keys and lose the user's
// persisted values. Walks all three scopes via _eachScheduledFillScope
// (globalDefaults, every perChallenge map, every non-reserved profile). The new
// finalWindowDuration setting needs no migration: absent → schema default 3600,
// which reproduces the legacy fixed one-hour behaviour.
const migrateFinalWindowExposureRename = (mergedSettings) => {
    if (mergedSettings._finalWindowExposureRenamedV1) return false;

    const RENAMES = {
        useLastHourExposure: 'useFinalWindowExposure',
        lastHourExposure: 'finalWindowExposure',
        lastHourExposureTarget: 'finalWindowExposureTarget',
        voteBeforeLastHour: 'voteBeforeFinalWindow',
        voteBeforeLastHourLeadMin: 'voteBeforeFinalWindowLeadMin',
    };

    _eachScheduledFillScope(mergedSettings, (scope, label) => {
        if (!scope) return;
        for (const [oldKey, newKey] of Object.entries(RENAMES)) {
            if (!Object.prototype.hasOwnProperty.call(scope, oldKey)) continue;
            // Preserve an existing new-key value (already migrated / new write)
            // over the legacy one; still drop the stale old key either way.
            if (!Object.prototype.hasOwnProperty.call(scope, newKey)) {
                scope[newKey] = scope[oldKey];
                logger
                    .withCategory('settings')
                    .info(`Renamed ${oldKey} ${label} to ${newKey} (value ${JSON.stringify(scope[oldKey])})`, null);
            }
            delete scope[oldKey];
        }
    });

    mergedSettings._finalWindowExposureRenamedV1 = true;
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
    migrationChanges = migrateFinalWindowExposureRename(mergedSettings) || migrationChanges;

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

    const globalDefaults = _globalChallengeValues(settings);
    const titleProfile = _getTitleProfileForChallengeId(settings, challengeId);
    const inheritedDefaults = { ...globalDefaults, ...(titleProfile?.values || {}) };
    const existingOverrides = settings.challengeSettings?.perChallenge?.[challengeId] || {};
    const contextSettings = batchOverrides
        ? { ...inheritedDefaults, ...existingOverrides, ...batchOverrides }
        : { ...inheritedDefaults, ...existingOverrides, [settingKey]: value };
    const candidates = batchOverrides || { [settingKey]: value };

    if (!_challengeValueSetIsValid(contextSettings, candidates, challengeId)) {
        logger.withCategory('settings').error(`Invalid value for setting ${settingKey}:`, value);
        return 'invalid';
    }

    const container = _ensureChallengeContainer(settings, challengeId);
    const inheritedValue = Object.prototype.hasOwnProperty.call(inheritedDefaults, settingKey)
        ? inheritedDefaults[settingKey]
        : SETTINGS_SCHEMA[settingKey].default;
    if (!valuesEqual(value, inheritedValue)) {
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
 * Atomically merge multiple per-challenge overrides, saving only values that
 * differ from the inherited global/title-profile baseline.
 */
const setChallengeOverrides = (challengeId, overrides) => {
    const id = challengeId === null || challengeId === undefined ? '' : String(challengeId).trim();
    if (!id || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return false;
    const settings = loadSettings();
    if (!settings.challengeSettings) settings.challengeSettings = getDefaultSettings().challengeSettings;
    const current = settings.challengeSettings.perChallenge?.[id] || {};
    const next = { ...current, ...overrides };
    if (!_replaceChallengeOverridesInSettings(settings, id, next, _isTitleProfileSuppressed(settings, id))) {
        return false;
    }
    return saveSettings(settings);
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

    const current = settings.challengeSettings.perChallenge[challengeId];
    if (!Object.prototype.hasOwnProperty.call(current, settingKey)) return true;
    const next = { ...current };
    delete next[settingKey];
    if (
        !_replaceChallengeOverridesInSettings(
            settings,
            challengeId,
            next,
            _isTitleProfileSuppressed(settings, challengeId),
        )
    ) {
        return false;
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

    const settings = loadSettings();
    const challengeSettings = settings.challengeSettings || getDefaultSettings().challengeSettings;

    // Explicit id-keyed settings remain the highest-precedence layer.
    if (challengeId && SETTINGS_SCHEMA[settingKey].perChallenge) {
        const overrides = challengeSettings.perChallenge?.[challengeId];
        if (overrides && Object.prototype.hasOwnProperty.call(overrides, settingKey)) {
            return overrides[settingKey];
        }

        // An exact-title profile is an inherited baseline, not a copied
        // per-challenge override. That makes it survive rotating challenge ids
        // while still allowing a one-off manual override to win above it.
        const titleProfile = _getTitleProfileForChallengeId(settings, challengeId);
        if (titleProfile && Object.prototype.hasOwnProperty.call(titleProfile.values, settingKey)) {
            return titleProfile.values[settingKey];
        }
    }

    return Object.prototype.hasOwnProperty.call(challengeSettings.globalDefaults || {}, settingKey)
        ? challengeSettings.globalDefaults[settingKey]
        : SETTINGS_SCHEMA[settingKey].default;
};

/**
 * Setting keys whose title-rule contribution is merged as a tag union. Named
 * profiles are also title-scoped, but resolve as an inherited settings layer.
 */
const TITLE_RULE_TAG_KEYS = ['mustIncludeTags', 'shouldIncludeTags'];

// Defensive caps on renderer-supplied title-rule input. The rules share the
// single settings JSON blob with every platform, so bound both the count and
// the per-title length to keep a malformed/oversized payload from bloating the
// file and slowing every findTitleRule scan. Real GuruShots titles are short,
// so 200 is comfortably generous for both.
const MAX_TITLE_RULES = 200;
const MAX_TITLE_LENGTH = 200;

// Current id→title observations are process-local. Real API responses also
// persist first-seen title pins, but this cache is what lets the same resolver
// work in mock mode without writing mock ids into the user's real settings.
// Replacing the whole map on each successful fetch also drops stale ids.
let activeChallengeTitles = new Map();

// Stable match key for a challenge title: trimmed + lowercased. The same
// challenge recurs with the same title (but a new id) on each rotation, so
// this is what survives a rotation.
const normalizeTitle = (title) => (typeof title === 'string' ? title.trim().toLowerCase() : '');

/**
 * Remember the titles from the latest successful active-challenge response.
 * The input is API-owned/untrusted, so only bounded scalar ids/titles enter
 * the cache and the first row for a duplicate id wins.
 */
const rememberChallengeTitles = (challenges) => {
    if (!Array.isArray(challenges)) return false;
    const next = new Map();
    for (const challenge of challenges.slice(0, MAX_TITLE_RULES)) {
        if (challenge?.id === null || challenge?.id === undefined) continue;
        const id = String(challenge.id);
        if (!id || next.has(id)) continue;
        const title = typeof challenge?.title === 'string' ? challenge.title.trim() : '';
        // Keep an explicit miss for unusable/over-length observations so a
        // truncated legacy pin cannot be used as an apparently exact fallback.
        next.set(id, title && title.length <= MAX_TITLE_LENGTH ? title : null);
    }
    activeChallengeTitles = next;
    return true;
};

const _titleForChallengeId = (settings, challengeId) => {
    const id = challengeId === null || challengeId === undefined ? '' : String(challengeId);
    if (!id) return '';
    if (activeChallengeTitles.has(id)) return activeChallengeTitles.get(id) || '';
    const pinned = settings.challengeSettings?.titlePins;
    return pinned &&
        Object.prototype.hasOwnProperty.call(pinned, id) &&
        typeof pinned[id] === 'string' &&
        pinned[id].length < MAX_TITLE_LENGTH
        ? pinned[id]
        : '';
};

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
 * Get the saved title rules. Tolerates settings persisted before this
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

const _sanitizeTitleRuleTags = (key, value) => {
    const list = (Array.isArray(value) ? value : [])
        .filter((tag) => typeof tag === 'string')
        .map((tag) => tag.trim())
        .filter(Boolean);
    return validateSetting(key, list) ? list : null;
};

const _canonicalTitleRuleProfile = (storedProfiles, requested) => {
    const name = typeof requested === 'string' ? requested.trim() : '';
    if (!name) return '';
    return _findProfileKey(storedProfiles, _normalizeProfileName(name));
};

const _sanitizeTitleRule = (rule, storedProfiles) => {
    const title = typeof rule?.title === 'string' ? rule.title.trim() : '';
    if (!title) return { valid: true, rule: null };
    if (title.length > MAX_TITLE_LENGTH) return { valid: false, title };

    const mustIncludeTags = _sanitizeTitleRuleTags('mustIncludeTags', rule?.mustIncludeTags);
    const shouldIncludeTags = _sanitizeTitleRuleTags('shouldIncludeTags', rule?.shouldIncludeTags);
    if (mustIncludeTags === null || shouldIncludeTags === null) return { valid: false, title };

    const requestedProfile = typeof rule?.profile === 'string' ? rule.profile.trim() : '';
    const profile = _canonicalTitleRuleProfile(storedProfiles, requestedProfile);
    if (requestedProfile && profile === null) return { valid: false, title, requestedProfile };
    if (!profile && mustIncludeTags.length === 0 && shouldIncludeTags.length === 0) {
        return { valid: true, rule: null };
    }

    const sanitized = { title, mustIncludeTags, shouldIncludeTags };
    if (profile) sanitized.profile = profile;
    return { valid: true, rule: sanitized };
};

/**
 * Persist the title rules. A rule may add tags, inherit a named profile, or do
 * both. Sanitizes input: trims titles, validates tag lists against the schema,
 * resolves profile names case-insensitively, drops no-op rules, and de-dupes
 * by normalized title (last wins).
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

    const settings = loadSettings();
    const storedProfiles = _readProfilesMap(settings);
    const byKey = new Map();
    for (const rule of rules) {
        const result = _sanitizeTitleRule(rule, storedProfiles);
        if (!result.valid) {
            const detail = result.requestedProfile
                ? `unknown profile "${_profileNameForLog(result.requestedProfile)}"`
                : `invalid or over-length values`;
            logger.withCategory('settings').error(`Title rule rejected for "${forLog(result.title)}": ${detail}`, null);
            return false;
        }
        if (result.rule) byKey.set(normalizeTitle(result.rule.title), result.rule);
    }

    for (const rule of byKey.values()) {
        if (
            rule.profile &&
            !_titleProfileComposesWithKnownOverrides(settings, rule.title, storedProfiles[rule.profile])
        ) {
            logger
                .withCategory('settings')
                .error(`Title profile conflicts with manual overrides for "${forLog(rule.title)}"`, null);
            return false;
        }
    }

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
            // Older releases truncated pins to MAX_TITLE_LENGTH. A stored
            // value exactly at that boundary is therefore ambiguous: it may
            // be the prefix of a longer title and must never be restored as
            // an exact title match.
            if (typeof title === 'string' && title.trim() !== '' && title.length < MAX_TITLE_LENGTH) {
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
 * clobbered) and `removeIds` are deleted. Over-length titles are rejected
 * rather than truncated, preserving exact-match semantics. The map is capped.
 */
const mergeTitlePins = (adds, removeIds) => {
    const addEntries =
        adds && typeof adds === 'object' && !Array.isArray(adds)
            ? Object.entries(adds).filter(
                  ([, title]) => typeof title === 'string' && title.trim() !== '' && title.length < MAX_TITLE_LENGTH,
              )
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
            if (typeof stored[id] === 'string' && stored[id].trim() !== '' && stored[id].length < MAX_TITLE_LENGTH) {
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
        pins[id] = title;
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

const _challengeValueSetIsValid = (values, candidates, challengeId = null) => {
    const affected = new Set(Object.keys(candidates));
    let changed = true;
    while (changed) {
        changed = false;
        for (const [key, config] of Object.entries(SETTINGS_SCHEMA)) {
            if (affected.has(key) || !config.perChallenge || !config.dependsOn?.some((dep) => affected.has(dep))) {
                continue;
            }
            affected.add(key);
            changed = true;
        }
    }

    // Enabling the final-window feature activates its inherited trigger and
    // target even when the sparse candidate does not explicitly contain them.
    if (values.useFinalWindowExposure === true) {
        affected.add('finalWindowExposure');
        affected.add('finalWindowExposureTarget');
    }

    return Array.from(affected).every((key) => {
        const config = SETTINGS_SCHEMA[key];
        if (!config?.perChallenge) return true;
        // A disabled inherited final-window setting is dormant. Explicitly
        // supplied final-window values still validate before being stored.
        const inheritedFinalWindowValue =
            !Object.prototype.hasOwnProperty.call(candidates, key) &&
            (key === 'finalWindowExposure' || key === 'finalWindowExposureTarget');
        if (inheritedFinalWindowValue && values.useFinalWindowExposure !== true) return true;
        return validateSetting(key, values[key], values, challengeId);
    });
};

const _profileSchemaValues = (values) => {
    const whitelisted = {};
    for (const key of Object.keys(values)) {
        // Prototype-shaped keys fall out here too: SETTINGS_SCHEMA['__proto__']
        // resolves to Object.prototype, whose .perChallenge is undefined.
        if (SETTINGS_SCHEMA[key]?.perChallenge) whitelisted[key] = values[key];
    }
    return whitelisted;
};

const _logProfileValidationFailure = (logInvalid, message, value = null) => {
    if (logInvalid) logger.withCategory('settings').error(message, value);
};

const _validatedProfileValues = (whitelisted, contextSettings, failClosed, logInvalid) => {
    const sanitized = {};
    for (const [key, value] of Object.entries(whitelisted)) {
        if (validateSetting(key, value, contextSettings)) {
            sanitized[key] = value;
            continue;
        }
        if (!failClosed) continue;
        _logProfileValidationFailure(logInvalid, `Invalid profile value for setting ${key}:`, value);
        return null;
    }
    return sanitized;
};

/**
 * Sanitize a profile's values map. Keeps only keys that are perChallenge in
 * SETTINGS_SCHEMA (unknown keys validate as true in validateSetting, so the
 * whitelist is mandatory) and validates each value with the full batch as
 * context so cross-field rules (e.g. exposureTarget >= exposure) hold.
 *
 * failClosed=true (save/apply/automatic execution): returns null on any invalid
 * value. Mutation paths log the failing key; repeated automatic reads suppress
 * that diagnostic so one corrupt stored profile cannot amplify logs every
 * voting cycle. failClosed=false (profile-list display) drops invalid values
 * silently because the schema may have evolved.
 */
const _sanitizeProfileValues = (values, failClosed, globalDefaults, logInvalid = true) => {
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

    const whitelisted = _profileSchemaValues(values);
    const contextSettings = { ...globalDefaults, ...whitelisted };
    const sanitized = _validatedProfileValues(whitelisted, contextSettings, failClosed, logInvalid);
    if (sanitized === null) return null;
    // A changed trigger can invalidate an inherited dependent field that is
    // not itself present in the sparse profile (for example exposure=90 with
    // a global exposureTarget=80). Validate the complete effective baseline,
    // not only the keys contributed by the profile.
    if (failClosed && !_challengeValueSetIsValid(contextSettings, whitelisted)) {
        _logProfileValidationFailure(logInvalid, 'Profile values conflict with inherited challenge settings');
        return null;
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

const _globalChallengeValues = (settings) => ({
    ...getDefaultSettings().challengeSettings.globalDefaults,
    ...(settings.challengeSettings?.globalDefaults || {}),
});

const _isTitleProfileSuppressed = (settings, challengeId) => {
    const id = challengeId === null || challengeId === undefined ? '' : String(challengeId);
    const suppressions = settings.challengeSettings?.titleProfileSuppressions;
    return Boolean(
        id &&
        suppressions &&
        typeof suppressions === 'object' &&
        !Array.isArray(suppressions) &&
        Object.prototype.hasOwnProperty.call(suppressions, id) &&
        suppressions[id] === true,
    );
};

const _titleProfileComposesWithKnownOverrides = (settings, title, rawProfileValues) => {
    const globalValues = _globalChallengeValues(settings);
    const profileValues = _sanitizeProfileValues(rawProfileValues, true, globalValues);
    if (profileValues === null) return false;

    const titleKey = normalizeTitle(title);
    const perChallenge = settings.challengeSettings?.perChallenge || {};
    return Object.entries(perChallenge).every(([challengeId, overrides]) => {
        if (_isTitleProfileSuppressed(settings, challengeId)) return true;
        if (normalizeTitle(_titleForChallengeId(settings, challengeId)) !== titleKey) return true;
        if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return false;
        const effective = { ...globalValues, ...profileValues, ...overrides };
        return _challengeValueSetIsValid(effective, { ...profileValues, ...overrides }, challengeId);
    });
};

/**
 * Resolve one title rule's named profile against a supplied settings snapshot.
 * Stale/corrupt profile references fail closed as a whole: automatic behavior
 * never executes a partially sanitized profile.
 */
const _getTitleProfileFromSettings = (settings, title) => {
    const titleKey = normalizeTitle(title);
    if (!titleKey) return null;
    const rules = settings.challengeSettings?.titleRules;
    if (!Array.isArray(rules)) return null;
    const rule = rules.find((candidate) => normalizeTitle(candidate?.title) === titleKey);
    const normalizedProfile = _normalizeProfileName(rule?.profile);
    if (!normalizedProfile || RESERVED_PROFILE_NAMES.has(normalizedProfile)) return null;

    const stored = _readProfilesMap(settings);
    const storedKey = _findProfileKey(stored, normalizedProfile);
    if (storedKey === null) return null;
    const values = _sanitizeProfileValues(stored[storedKey], true, _globalChallengeValues(settings), false);
    if (values === null) return null;
    return { name: storedKey, values };
};

const _getTitleProfileForChallengeId = (settings, challengeId) =>
    _isTitleProfileSuppressed(settings, challengeId)
        ? null
        : _getTitleProfileFromSettings(settings, _titleForChallengeId(settings, challengeId));

/**
 * Public read model for the renderer: returns the sanitized profile inherited
 * by an exact challenge title, or null when the title has no valid assignment.
 */
const getTitleProfile = (title, challengeId = null) => {
    const settings = loadSettings();
    const profile = _getTitleProfileFromSettings(settings, title);
    if (!profile || challengeId === null || challengeId === undefined) return profile;
    return { ...profile, suppressed: _isTitleProfileSuppressed(settings, challengeId) };
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

const _challengeOverrideEntries = (overrides) => {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return null;
    const entries = Object.entries(overrides);
    return entries.some(([key]) => !SETTINGS_SCHEMA[key]?.perChallenge) ? null : entries;
};

const _writeTitleProfileSuppression = (challengeSettings, challengeId, suppressed) => {
    const prior = challengeSettings.titleProfileSuppressions;
    const next = prior && typeof prior === 'object' && !Array.isArray(prior) ? { ...prior } : {};
    if (suppressed) next[challengeId] = true;
    else delete next[challengeId];
    challengeSettings.titleProfileSuppressions = next;
};

const _replaceChallengeOverridesInSettings = (settings, challengeId, overrides, suppressTitleProfile) => {
    const entries = _challengeOverrideEntries(overrides);
    if (entries === null) return false;

    const globalValues = _globalChallengeValues(settings);
    const automaticProfile = suppressTitleProfile
        ? null
        : _getTitleProfileFromSettings(settings, _titleForChallengeId(settings, challengeId));
    const inherited = { ...globalValues, ...(automaticProfile?.values || {}) };
    const effective = { ...inherited, ...overrides };
    if (!_challengeValueSetIsValid(effective, { ...(automaticProfile?.values || {}), ...overrides }, challengeId)) {
        return false;
    }

    const container = {};
    for (const [key, value] of entries) {
        if (!valuesEqual(value, inherited[key])) container[key] = value;
    }
    const challengeSettings = settings.challengeSettings;
    if (!challengeSettings.perChallenge) challengeSettings.perChallenge = {};
    if (Object.keys(container).length) challengeSettings.perChallenge[challengeId] = container;
    else delete challengeSettings.perChallenge[challengeId];

    _writeTitleProfileSuppression(challengeSettings, challengeId, suppressTitleProfile);
    return true;
};

/** Atomically replace a challenge form's manual settings and profile mode. */
const replaceChallengeOverrides = (challengeId, overrides, suppressTitleProfile = false) => {
    const id = challengeId === null || challengeId === undefined ? '' : String(challengeId).trim();
    if (!id || typeof suppressTitleProfile !== 'boolean') return false;
    const settings = loadSettings();
    if (!settings.challengeSettings) settings.challengeSettings = getDefaultSettings().challengeSettings;
    if (!_replaceChallengeOverridesInSettings(settings, id, overrides, suppressTitleProfile)) return false;
    return saveSettings(settings);
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
    const globalDefaults = _globalChallengeValues(settings);
    const profiles = {};
    for (const name of Object.keys(stored)) {
        if (RESERVED_PROFILE_NAMES.has(_normalizeProfileName(name))) continue;
        profiles[name] = _sanitizeProfileValues(stored[name], false, globalDefaults);
    }
    return profiles;
};

const _updateAssignedProfileRules = (settings, normalizedName, displayName, values) => {
    const rules = Array.isArray(settings.challengeSettings.titleRules) ? settings.challengeSettings.titleRules : [];
    const assigned = rules.filter((rule) => _normalizeProfileName(rule?.profile) === normalizedName);
    if (assigned.some((rule) => !_titleProfileComposesWithKnownOverrides(settings, rule.title, values))) {
        logger
            .withCategory('settings')
            .error(
                `Profile overwrite conflicts with manual challenge overrides: "${_profileNameForLog(displayName)}"`,
                null,
            );
        return false;
    }
    if (assigned.length) {
        settings.challengeSettings.titleRules = rules.map((rule) =>
            _normalizeProfileName(rule?.profile) === normalizedName ? { ...rule, profile: displayName } : rule,
        );
    }
    return true;
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
    const globalDefaults = _globalChallengeValues(settings);
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

    if (existed && !_updateAssignedProfileRules(settings, normalized, trimmed, sanitized)) return false;
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

    // A deleted profile cannot remain as an invisible stale assignment. Keep
    // any tags on the same title rule; drop the row only when the profile was
    // its sole contribution.
    const rules = settings.challengeSettings.titleRules;
    if (Array.isArray(rules)) {
        settings.challengeSettings.titleRules = rules.flatMap((rule) => {
            if (_normalizeProfileName(rule?.profile) !== normalized) return [rule];
            const withoutProfile = { ...rule };
            delete withoutProfile.profile;
            const hasTags =
                (Array.isArray(withoutProfile.mustIncludeTags) && withoutProfile.mustIncludeTags.length > 0) ||
                (Array.isArray(withoutProfile.shouldIncludeTags) && withoutProfile.shouldIncludeTags.length > 0);
            return hasTags ? [withoutProfile] : [];
        });
    }
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

    const globalDefaults = _globalChallengeValues(settings);
    // Fail-closed: _sanitizeProfileValues logs the failing key, so a
    // schema-drifted profile's failure is diagnosable from the log.
    const sanitized = _sanitizeProfileValues(stored[storedKey], true, globalDefaults);
    if (sanitized === null) {
        return false;
    }

    if (!_replaceChallengeOverridesInSettings(settings, id, sanitized, true)) return false;
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
 *    the vetted path. Bundles are self-contained, so a save failure that is NOT
 *    the profile cap is structural (schema drift): it is logged and the intent
 *    is marked seeded to avoid retrying every load. The profile cap, by
 *    contrast, is TRANSIENT — a user already at MAX_CHALLENGE_PROFILES is
 *    pre-checked and left UN-marked so the built-in seeds on a later run once
 *    they free capacity, rather than being permanently and silently suppressed.
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
    // Live count of real (non-reserved) profiles, kept in step with successful
    // saves so the cap pre-check stays accurate across the loop.
    let profileCount = Object.keys(stored).filter(
        (name) => !RESERVED_PROFILE_NAMES.has(_normalizeProfileName(name)),
    ).length;

    let changed = false;
    for (const intent of INTENT_PROFILES) {
        const normalized = _normalizeProfileName(intent.name);
        if (seededSet.has(normalized)) continue; // already seeded once — respect a later deletion

        // A user's own same-named profile — never clobber it; mark seeded so it
        // isn't retried.
        if (_findProfileKey(stored, normalized) !== null) {
            seededSet.add(normalized);
            changed = true;
            continue;
        }

        // Transient cap: do NOT mark seeded, so it retries once capacity frees.
        if (profileCount >= MAX_CHALLENGE_PROFILES) {
            logger
                .withCategory('settings')
                .info(
                    `Deferred seeding intent profile "${_profileNameForLog(intent.name)}" — profile cap (${MAX_CHALLENGE_PROFILES}) reached; will retry`,
                );
            continue;
        }

        const ok = saveChallengeProfile(intent.name, intent.values);
        if (ok) {
            profileCount += 1;
        } else {
            // Not the cap (pre-checked): a structural failure that won't
            // self-heal, so mark it seeded to avoid retrying every load.
            logger
                .withCategory('settings')
                .warning(
                    `Skipped seeding intent profile "${_profileNameForLog(intent.name)}" (invalid for this install)`,
                );
        }
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
    if (!settings.challengeSettings) {
        return true; // Nothing to cleanup
    }

    const activeIds = new Set(activeChallengeIds);
    const perChallenge = settings.challengeSettings.perChallenge || {};
    const suppressions = settings.challengeSettings.titleProfileSuppressions || {};
    const staleChallengeIds = Object.keys(perChallenge).filter((id) => !activeIds.has(id));
    const staleSuppressionIds = Object.keys(suppressions).filter((id) => !activeIds.has(id));

    if (staleChallengeIds.length === 0 && staleSuppressionIds.length === 0) {
        return true; // Nothing to cleanup
    }

    logger
        .withCategory('settings')
        .debug(`Cleaning up settings for ${staleChallengeIds.length} stale challenges:`, staleChallengeIds);

    staleChallengeIds.forEach((challengeId) => {
        delete perChallenge[challengeId];
    });
    staleSuppressionIds.forEach((challengeId) => {
        delete suppressions[challengeId];
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
    getTitleProfile,
    rememberChallengeTitles,

    // Named challenge-settings profiles (survive challenge rotation).
    // The caps are exported so tests and the get-settings-schema handler
    // share the same literals the facade enforces.
    getChallengeOverrides,
    replaceChallengeOverrides,
    getChallengeProfiles,
    saveChallengeProfile,
    deleteChallengeProfile,
    applyChallengeProfile,
    seedIntentProfiles,
    MAX_CHALLENGE_PROFILES,
    MAX_PROFILE_NAME_LENGTH,

    // First-seen challenge-title pins (internal cache — no IPC wiring).
    // MAX_TITLE_LENGTH is exported so challengeTitlePin.js bounds incoming
    // titles with the same cap mergeTitlePins accepts.
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
