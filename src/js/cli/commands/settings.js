/**
 * CLI settings commands. Each function is a thin shell around the
 * settings facade; the CLI host (cli.js) handles argv parsing and
 * exit codes, this module formats values, validates schema keys,
 * and emits the user-facing logs.
 */

const logger = require('../../logger');
const settings = require('../../settings');
const { getDefaultSettings } = require('../../settings');
const { parseSettingValue } = require('../parseValue');

/**
 * Format a settings value for log output, redacting sensitive keys via
 * the same regex the on-disk sanitizer uses. Keys like `token` would
 * otherwise reach the log file embedded in the message string (which
 * the sanitizer does not see), defeating the Tier 1 protection.
 */
const formatSettingForLog = (key, value) => {
    const masked = logger.sanitizeForLog({ [key]: value });
    return masked[key] === '[REDACTED]' ? '[REDACTED]' : JSON.stringify(value);
};

// One consistent recovery message for a mistyped schema key, shared by every
// command that validates against SETTINGS_SCHEMA. Self-contained (lists the
// keys inline) so it stays correct for both hosts — the main CLI and the
// pnpm settings:* scripts wire different command names for the schema dump.
const logUnknownSchemaKey = (key) => {
    logger.withCategory('settings').error(`Unknown schema setting '${key}'`);
    logger
        .withCategory('settings')
        .info(`Available settings: ${Object.keys(settings.SETTINGS_SCHEMA).sort().join(', ')}`);
};

// Guard for the per-challenge variants: a key must declare perChallenge in
// the schema before it can carry an override. Logs and returns false on miss.
const requirePerChallenge = (key) => {
    if (!settings.SETTINGS_SCHEMA[key]?.perChallenge) {
        logger.withCategory('settings').error(`Setting '${key}' does not support per-challenge overrides`);
        return false;
    }
    return true;
};

const getSetting = (key, challengeId = null) => {
    try {
        if (challengeId) {
            if (!requirePerChallenge(key)) return;
            const effective = settings.getEffectiveSetting(key, challengeId);
            const isOverride = settings.getChallengeOverride(key, challengeId) !== null;
            const status = isOverride ? 'override' : 'inherited from global default';
            logger
                .withCategory('settings')
                .info(`${key} [challenge ${challengeId}]: ${formatSettingForLog(key, effective)} (${status})`);
            return true;
        }
        const value = settings.getSetting(key);
        if (value === undefined) {
            logger.withCategory('settings').error(`Setting '${key}' not found`);
            return false;
        }
        logger.withCategory('settings').info(`${key}: ${formatSettingForLog(key, value)}`);
        return true;
    } catch (error) {
        logger.withCategory('settings').error(`Error getting setting '${key}'`, error);
        return false;
    }
};

const setSetting = (key, value, challengeId = null) => {
    try {
        const parsedValue = parseSettingValue(value);
        if (challengeId) {
            if (!requirePerChallenge(key)) return false;
            if (settings.setChallengeOverride(key, challengeId, parsedValue)) {
                logger
                    .withCategory('settings')
                    .success(`Set ${key} = ${JSON.stringify(parsedValue)} for challenge ${challengeId}`);
                return true;
            }
            logger
                .withCategory('settings')
                .error(`Failed to set ${key} for challenge ${challengeId} — validation failed`);
            return false;
        }
        if (!settings.setSetting(key, parsedValue)) {
            logger.withCategory('settings').error(`Failed to save setting '${key}' - validation failed`);
            return false;
        }
        logger.withCategory('settings').success(`Set ${key} = ${JSON.stringify(parsedValue)}`);
        return true;
    } catch (error) {
        logger.withCategory('settings').error(`Error setting '${key}'`, error);
        return false;
    }
};

const setGlobalDefault = (key, value) => {
    try {
        const parsedValue = parseSettingValue(value);

        const schema = settings.SETTINGS_SCHEMA;
        if (!schema[key]) {
            logUnknownSchemaKey(key);
            return false;
        }

        const success = settings.setGlobalDefault(key, parsedValue);
        if (success) {
            const actualValue = settings.getGlobalDefault(key);
            logger.withCategory('settings').success(`Set global default ${key} = ${JSON.stringify(actualValue)}`);
            return true;
        }
        logger.withCategory('settings').error(`Failed to set global default '${key}' - validation failed`);
        logger.withCategory('settings').error(`Value ${JSON.stringify(parsedValue)} is invalid for this setting`);

        const config = schema[key];
        logger
            .withCategory('settings')
            .info(`Setting info: ${config.type} type, default: ${JSON.stringify(config.default)}`);
        return false;
    } catch (error) {
        logger.withCategory('settings').error(`Error setting global default '${key}'`, error);
        return false;
    }
};

const listSettings = (challengeId = null) => {
    try {
        if (challengeId) {
            const schema = settings.SETTINGS_SCHEMA;
            const perChallengeKeys = Object.keys(schema)
                .filter((key) => schema[key].perChallenge)
                .sort();

            logger.withCategory('settings').info(`=== Settings for challenge ${challengeId} ===`);
            perChallengeKeys.forEach((key) => {
                const effective = settings.getEffectiveSetting(key, challengeId);
                const isOverride = settings.getChallengeOverride(key, challengeId) !== null;
                const status = isOverride ? 'Override ✏️' : 'Inherited ✅';
                logger.withCategory('settings').info(`${key}: ${formatSettingForLog(key, effective)}  [${status}]`);
            });
            logger
                .withCategory('ui')
                .info('💡 Only per-challenge-capable settings are shown. Use "list-settings" for all global settings.');
            return;
        }

        const userSettings = settings.loadSettings();
        const defaultSettings = getDefaultSettings();

        logger.withCategory('settings').info('=== All Settings ===');

        const allKeys = new Set([...Object.keys(userSettings), ...Object.keys(defaultSettings)]);
        const sortedKeys = Array.from(allKeys).sort();

        sortedKeys.forEach((key) => {
            const currentValue = userSettings[key];
            const defaultValue = defaultSettings[key];
            const isModified = JSON.stringify(currentValue) !== JSON.stringify(defaultValue);

            logger.withCategory('settings').info(`${key}:`);
            logger.withCategory('settings').info(`  Current: ${formatSettingForLog(key, currentValue)}`);
            logger.withCategory('settings').info(`  Default: ${formatSettingForLog(key, defaultValue)}`);
            if (isModified) {
                logger.withCategory('settings').info('  Status:  Modified ✏️');
            } else {
                logger.withCategory('settings').info('  Status:  Default ✅');
            }
            logger.withCategory('settings').info('');
        });

        logger.withCategory('ui').info('💡 Use "help-settings" for detailed information about each setting');
    } catch (error) {
        logger.withCategory('settings').error('Error listing settings', error);
    }
};

const resetSetting = (key, challengeId = null) => {
    try {
        if (challengeId) {
            if (!requirePerChallenge(key)) return false;
            settings.removeChallengeOverride(key, challengeId);
            logger
                .withCategory('settings')
                .success(`Reset ${key} for challenge ${challengeId} (now inherits the global default)`);
            return true;
        }
        const defaultSettings = getDefaultSettings();
        const defaultValue = defaultSettings[key];

        if (defaultValue === undefined) {
            logger.withCategory('settings').error(`Setting '${key}' not found in defaults`);
            return false;
        }

        settings.setSetting(key, defaultValue);
        logger.withCategory('settings').success(`Reset ${key} to default: ${JSON.stringify(defaultValue)}`);
        return true;
    } catch (error) {
        logger.withCategory('settings').error(`Error resetting setting '${key}'`, error);
        return false;
    }
};

const resetGlobalDefault = (key) => {
    try {
        if (!settings.SETTINGS_SCHEMA[key]) {
            logUnknownSchemaKey(key);
            return false;
        }
        if (!settings.resetGlobalDefault(key)) {
            logger.withCategory('settings').error(`Failed to reset global default '${key}'`);
            return false;
        }
        const defaultValue = settings.SETTINGS_SCHEMA[key].default;
        logger.withCategory('settings').success(`Reset global default ${key} to: ${JSON.stringify(defaultValue)}`);
        return true;
    } catch (error) {
        logger.withCategory('settings').error(`Error resetting global default '${key}'`, error);
        return false;
    }
};

const resetAllSettings = () => {
    try {
        // Delegate to the facade so the CLI matches the GUI/IPC path and the
        // documented contract: it preserves token, mock flag, and apiHeaders.
        // (Re-implementing the loop here previously wiped the auth token because
        // getDefaultSettings() includes token:'' / mock / apiHeaders.)
        if (settings.resetAllSettings()) {
            logger
                .withCategory('settings')
                .success('All settings reset to defaults (token, mock flag, and API headers preserved)');
            logger.withCategory('ui').info('💡 Run "list-settings" to see all current values');
            return true;
        }
        logger.withCategory('settings').error('Failed to reset all settings');
        return false;
    } catch (error) {
        logger.withCategory('settings').error('Error resetting all settings', error);
        return false;
    }
};

/**
 * Print the full settings schema (type, default, per-challenge flag, label,
 * description per key). Shared by `pnpm settings:schema` and available to
 * the main CLI.
 */
const dumpSchema = () => {
    logger.withCategory('ui').info('Settings Schema:');
    logger.withCategory('ui').info('================');
    Object.entries(settings.SETTINGS_SCHEMA).forEach(([key, config]) => {
        logger.withCategory('ui').info(`\n${key}:`);
        logger.withCategory('ui').info(`  Type: ${config.type}`);
        logger.withCategory('ui').info(`  Default: ${JSON.stringify(config.default)}`);
        logger.withCategory('ui').info(`  Per-Challenge: ${config.perChallenge ? 'Yes' : 'No'}`);
        if (config.label) logger.withCategory('ui').info(`  Label: ${config.label}`);
        if (config.description) logger.withCategory('ui').info(`  Description: ${config.description}`);
    });
};

/**
 * Print the effective global default for every schema key (stored override
 * or schema default). Shared by `pnpm settings:global-defaults`.
 */
const listGlobalDefaults = () => {
    const stored = settings.loadSettings().challengeSettings?.globalDefaults || {};
    logger.withCategory('ui').info('Global Defaults for Schema Settings:');
    logger.withCategory('ui').info('===================================');
    Object.entries(settings.SETTINGS_SCHEMA).forEach(([key, config]) => {
        const currentValue = stored[key] !== undefined ? stored[key] : config.default;
        logger.withCategory('ui').info(`${key}: ${JSON.stringify(currentValue)}`);
    });
};

const listProfiles = () => {
    try {
        const profiles = settings.getChallengeProfiles();
        const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b));
        if (names.length === 0) {
            logger.withCategory('settings').info('No saved challenge profiles');
            logger.withCategory('ui').info('💡 Save one with: save-profile "<name>" --challenge=<id>');
            return;
        }
        logger.withCategory('settings').info('=== Challenge Profiles ===');
        names.forEach((name) => {
            const values = profiles[name];
            const keys = Object.keys(values).sort();
            const summary =
                keys.length === 0
                    ? '(no overrides — applying it resets the challenge to global defaults)'
                    : keys.map((key) => `${key}=${formatSettingForLog(key, values[key])}`).join(', ');
            logger.withCategory('settings').info(`${name} (${keys.length}): ${summary}`);
        });
    } catch (error) {
        logger.withCategory('settings').error('Error listing profiles', error);
    }
};

const saveProfileFromChallenge = (name, challengeId) => {
    try {
        const overrides = settings.getChallengeOverrides(challengeId);
        if (settings.saveChallengeProfile(name, overrides)) {
            const count = Object.keys(overrides).length;
            logger
                .withCategory('settings')
                .success(`Saved profile "${name}" with ${count} override(s) from challenge ${challengeId}`);
        } else {
            logger
                .withCategory('settings')
                .error(
                    'Failed to save profile — the name is empty/too long/reserved, the profile cap is reached, or a value failed validation (see the settings log)',
                );
        }
    } catch (error) {
        logger.withCategory('settings').error('Error saving profile', error);
    }
};

const applyProfile = (name, challengeId) => {
    try {
        if (settings.applyChallengeProfile(name, challengeId)) {
            logger.withCategory('settings').success(`Applied profile "${name}" to challenge ${challengeId}`);
            logger
                .withCategory('ui')
                .info(`💡 Run "list-settings --challenge=${challengeId}" to review the applied overrides`);
        } else {
            logger
                .withCategory('settings')
                .error(
                    `Failed to apply profile "${name}" — no such profile, or a value failed validation (see the settings log)`,
                );
        }
    } catch (error) {
        logger.withCategory('settings').error('Error applying profile', error);
    }
};

const deleteProfile = (name) => {
    try {
        if (settings.deleteChallengeProfile(name)) {
            logger.withCategory('settings').success(`Deleted profile "${name}"`);
        } else {
            logger.withCategory('settings').error(`No profile named "${name}"`);
        }
    } catch (error) {
        logger.withCategory('settings').error('Error deleting profile', error);
    }
};

const helpSettings = () => {
    logger.withCategory('ui').info(`
=== Settings Management Help ===

Available Commands:
  get-setting <key>     - Get current value of a setting
  set-setting <key> <value> - Set a setting value
  list-settings         - Show all settings and their values
  reset-setting <key>   - Reset a setting to its default value
  reset-all-settings    - Reset all settings to defaults
  help-settings         - Show this help message

Per-challenge overrides:
  Append --challenge=<id> to get-setting / set-setting / reset-setting /
  list-settings to read or write a single challenge's override. Without an
  override the challenge inherits the global default. Only settings that
  support per-challenge overrides accept the flag.
  Examples:
    set-setting exposure 80 --challenge=12345
    get-setting exposure --challenge=12345
    reset-setting exposure --challenge=12345   (clears the override)

Challenge profiles (named override presets — save a tactic once, recall it):
  list-profiles                              - Show saved profiles and their values
  save-profile <name> --challenge=<id>       - Save that challenge's current overrides as a named profile
  apply-profile <name> --challenge=<id>      - Replace that challenge's overrides with the profile's values
  delete-profile <name>                      - Delete a saved profile
  Profile names with spaces MUST be quoted, e.g.:
    save-profile "2-pic tactic" --challenge=12345
    apply-profile "2-pic tactic" --challenge=67890
  Saving an existing name overwrites it (names match case-insensitively).
  Applying replaces ALL of the challenge's overrides — settings the profile
  doesn't include revert to the global defaults. Profiles are name-keyed, so
  they survive challenge rotation; overrides applied to an id that later
  leaves the active challenge list are cleaned up automatically.

Common Settings:
  apiTimeout           - API request timeout in seconds (default: 30)
  apiMaxRetries        - Retries for transient API failures: network/timeout/429/5xx (default: 3; 0 disables)
  apiRetryBaseDelayMs  - Base backoff delay between retries in ms, doubling each attempt (default: 1000)
  checkFrequencyMin    - Minimum minutes between voting cycles (default: 3)
  checkFrequencyMax    - Maximum minutes between voting cycles (default: 3). Each cycle picks
                         a random delay in [min, max]; set min === max for a fixed cadence.
  mock                 - Use mock API for testing (default: false)
  theme                - UI theme: "light" or "dark" (default: "light")
  language             - UI language: "en" or "lv" (default: "en")
  timezone             - Timezone for timestamps (default: "Europe/Riga")

Time settings (stored in SECONDS — the GUI enters them as hours+minutes):
  boostTime            - Seconds before close to apply a timer boost (default: 3600 = 1h)
  turboTime            - Seconds before close to apply turbo (default: 7200 = 2h)
  emergencyFill        - Seconds before close to fill empty slots as a last resort
                         (default: 300 = 5 min; 0 = off). NOTE: this used to be minutes.

Scheduled fill (fill exposure at chosen times — per-challenge, set with
set-global-default or set-setting --challenge=<id>; every entry opens its own
fill window, all OR'd; older single values migrate to arrays automatically):
  useScheduledFill           - Master switch (default: false). Inert until a
                               time below is set; never applies to flash or
                               boost-only challenges.
  scheduledFillTime          - JSON array of daily 24h "HH:MM" times in the
                               app timezone setting, NOT the device clock.
                               e.g. '["09:00","21:30"]' ([] = off, max 6,
                               no duplicates)
  scheduledFillBeforeEnd     - JSON array of SECONDS-before-close offsets,
                               each opening a one-shot window. e.g.
                               '[14400,36000]' fills at 4h and 10h before the
                               end ([] = off, max 6, no duplicates, each
                               1s..30 days)
  scheduledFillWindowMinutes - How long each fill window stays open
                               (default: 60, range 5-720)
  scheduledFillReplaces      - true = scheduled windows become the ONLY
                               automatic fills (normal + last-hour voting are
                               blocked outside them; flash/last-minute rules
                               and manual voting still apply). A window missed
                               while the app is not running is skipped with no
                               catch-up. (default: false)
  Set them like autoFillSchedule (validated JSON values):
    set-global-default scheduledFillTime '["09:00","21:30"]'
    set-setting scheduledFillBeforeEnd '[14400,36000]' --challenge=12345

Auto-fill schedule (JSON array of {count, seconds} rows; replaces the old
autoFillIntervalMinutes — existing values are migrated automatically):
  autoFillSchedule     - Each row: have at least <count> entries once <seconds>
                         remain before close. Counts 2-4 (max 3 rows, unique) —
                         challenges allow at most 4 images and image 1 always
                         exists. Omit a count to never schedule that image; an
                         empty array [] means auto-fill never submits.
                         Default: [{"count":2,"seconds":1800},{"count":3,"seconds":1200},{"count":4,"seconds":600}]
  Set it with set-global-default (validated; set-setting without --challenge
  writes an unvalidated top-level key the scheduler never reads):
    set-global-default autoFillSchedule '[{"count":2,"seconds":172800},{"count":3,"seconds":10800},{"count":4,"seconds":900}]'
  Per-challenge override (also validated):
    set-setting autoFillSchedule '[{"count":2,"seconds":172800}]' --challenge=12345

Value Types:
  String:   "value" or value
  Number:   30, 3, 100
  Boolean:  true, false
  Array:    [1, 2, 3]
  Object:   {"key": "value"}

Examples:
  set-setting checkFrequencyMin 2
  set-setting checkFrequencyMax 5
  set-setting apiTimeout 60
  set-setting mock true
  get-setting checkFrequencyMin
  reset-setting checkFrequencyMax

💡 Tip: Use "list-settings" to see all available settings and their current values
`);
};

const resetWindows = () => {
    try {
        const userSettings = settings.loadSettings();
        const defaultSettings = settings.getDefaultSettings();
        userSettings.windowBounds = defaultSettings.windowBounds;
        settings.saveSettings(userSettings);
        logger.withCategory('settings').success('Window positions reset to default');
    } catch (error) {
        logger.withCategory('settings').error('Error resetting window positions', error);
    }
};

module.exports = {
    formatSettingForLog,
    getSetting,
    setSetting,
    setGlobalDefault,
    listSettings,
    resetSetting,
    resetGlobalDefault,
    resetAllSettings,
    dumpSchema,
    listGlobalDefaults,
    helpSettings,
    resetWindows,
    listProfiles,
    saveProfileFromChallenge,
    applyProfile,
    deleteProfile,
};
