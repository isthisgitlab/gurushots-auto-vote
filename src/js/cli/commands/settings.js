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

const getSetting = (key) => {
    try {
        const value = settings.getSetting(key);
        if (value === undefined) {
            logger.withCategory('settings').error(`Setting '${key}' not found`);
            return;
        }
        logger.withCategory('settings').info(`${key}: ${formatSettingForLog(key, value)}`);
    } catch (error) {
        logger.withCategory('settings').error(`Error getting setting '${key}'`, error);
    }
};

const setSetting = (key, value) => {
    try {
        const parsedValue = parseSettingValue(value);
        settings.setSetting(key, parsedValue);
        logger.withCategory('settings').success(`Set ${key} = ${JSON.stringify(parsedValue)}`);
    } catch (error) {
        logger.withCategory('settings').error(`Error setting '${key}'`, error);
    }
};

const setGlobalDefault = (key, value) => {
    try {
        const parsedValue = parseSettingValue(value);

        const schema = settings.SETTINGS_SCHEMA;
        if (!schema[key]) {
            logger.withCategory('settings').error(`Unknown schema setting '${key}'`);
            logger.withCategory('settings').info('Available settings:');
            Object.keys(schema).forEach((settingKey) => {
                logger.withCategory('settings').info(`  ${settingKey}`);
            });
            return;
        }

        const success = settings.setGlobalDefault(key, parsedValue);
        if (success) {
            const actualValue = settings.getGlobalDefault(key);
            logger.withCategory('settings').success(`Set global default ${key} = ${JSON.stringify(actualValue)}`);
        } else {
            logger.withCategory('settings').error(`Failed to set global default '${key}' - validation failed`);
            logger.withCategory('settings').error(`Value ${JSON.stringify(parsedValue)} is invalid for this setting`);

            const config = schema[key];
            logger
                .withCategory('settings')
                .info(`Setting info: ${config.type} type, default: ${JSON.stringify(config.default)}`);
        }
    } catch (error) {
        logger.withCategory('settings').error(`Error setting global default '${key}'`, error);
    }
};

const listSettings = () => {
    try {
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

const resetSetting = (key) => {
    try {
        const defaultSettings = getDefaultSettings();
        const defaultValue = defaultSettings[key];

        if (defaultValue === undefined) {
            logger.withCategory('settings').error(`Setting '${key}' not found in defaults`);
            return;
        }

        settings.setSetting(key, defaultValue);
        logger.withCategory('settings').success(`Reset ${key} to default: ${JSON.stringify(defaultValue)}`);
    } catch (error) {
        logger.withCategory('settings').error(`Error resetting setting '${key}'`, error);
    }
};

const resetAllSettings = () => {
    try {
        const defaultSettings = getDefaultSettings();

        Object.keys(defaultSettings).forEach((key) => {
            settings.setSetting(key, defaultSettings[key]);
        });

        logger.withCategory('settings').success('All settings reset to defaults');
        logger.withCategory('ui').info('💡 Run "list-settings" to see all current values');
    } catch (error) {
        logger.withCategory('settings').error('Error resetting all settings', error);
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

Common Settings:
  apiTimeout           - API request timeout in seconds (default: 30)
  checkFrequencyMin    - Minimum minutes between voting cycles (default: 3)
  checkFrequencyMax    - Maximum minutes between voting cycles (default: 3). Each cycle picks
                         a random delay in [min, max]; set min === max for a fixed cadence.
  mock                 - Use mock API for testing (default: false)
  theme                - UI theme: "light" or "dark" (default: "light")
  language             - UI language: "en" or "lv" (default: "en")
  timezone             - Timezone for timestamps (default: "Europe/Riga")

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
    resetAllSettings,
    helpSettings,
    resetWindows,
};
