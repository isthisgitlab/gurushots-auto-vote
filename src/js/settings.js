const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const runtime = require('./runtime');

// Try to import electron, but don't fail if it's not available (CLI context)
let electronApp = null;
try {
    const electron = require('electron');
    electronApp = electron.app;
} catch (error) {
    // Electron not available (CLI context), we'll use fallback
    logger.withCategory('ui').info('Running in CLI context - using fallback userData path:', error.message);
}

/**
 * Detect if we're running from source code vs built app
 * @returns {boolean} - True if running from source, false if built
 */
const isSourceCode = () => {
    // If we're in Electron and it's packaged, we're definitely built
    if (electronApp && electronApp.isPackaged) {
        return false;
    }
    
    // For CLI: check if we're running as a pkg binary
    if (process.pkg) {
        return false;
    }
    
    // Check if __dirname contains .asar (Electron packaged but somehow not detected)
    if (__dirname.includes('.asar')) {
        return false;
    }
    
    // If none of the above, assume we're running from source
    return true;
};

/**
 * Get the app name with environment suffix if needed
 * @returns {string} - App name with -dev suffix for source code
 */
const getAppName = () => {
    const baseAppName = 'gurushots-auto-vote';
    return isSourceCode() ? `${baseAppName}-dev` : baseAppName;
};

// Define the settings file path in the userData directory
const getSettingsPath = () => {
    let userDataPath;

    if (electronApp && electronApp.getPath) {
        // Electron context - need to construct proper path based on source/built status
        if (isSourceCode()) {
            // Running from source code - use dev-specific directory
            const basePath = path.dirname(electronApp.getPath('userData'));
            userDataPath = path.join(basePath, 'gurushots-auto-vote-dev');
        } else {
            // Built app - use normal userData path
            userDataPath = electronApp.getPath('userData');
        }
    } else {
        // CLI context - create fallback userData path
        userDataPath = runtime.getUserDataDir(getAppName());

        // Ensure the directory exists
        if (!fs.existsSync(userDataPath)) {
            try {
                fs.mkdirSync(userDataPath, {recursive: true});
                logger.withCategory('ui').info(`Created userData directory: ${userDataPath}`, null);
            } catch (error) {
                logger.withCategory('ui').error('Error creating userData directory:', error);
                // Fallback to current directory if we can't create the proper path
                userDataPath = path.join(process.cwd(), 'userData');
                if (!fs.existsSync(userDataPath)) {
                    fs.mkdirSync(userDataPath, {recursive: true});
                }
            }
        }
    }

    return path.join(userDataPath, 'settings.json');
};

/**
 * Determine the default mock setting based on environment.
 * Dev wins over prod when both signals are set; default is prod (mock disabled).
 *
 * @returns {boolean} - True for development, false for production
 */
const getDefaultMockSetting = () => {
    if (runtime.isDevelopment()) return true;
    return false;
};

// Default settings with environment-aware mock setting
const getDefaultSettings = () => {
    // Generate global defaults from schema
    const globalDefaults = {};
    Object.keys(SETTINGS_SCHEMA).forEach(key => {
        globalDefaults[key] = SETTINGS_SCHEMA[key].default;
    });

    return {
        theme: 'light',
        stayLoggedIn: false,
        lastUsername: '',
        mock: getDefaultMockSetting(),
        token: '',
        timezone: 'Europe/Riga',
        customTimezones: [],
        language: 'en', // Default language
        // Timing settings (stored in user-friendly units)
        apiTimeout: 30, // API request timeout in seconds (default: 30 seconds)
        checkFrequency: 3, // Check frequency in minutes (default: 3 minutes)
        cliCronExpression: '*/3 * * * *', // CLI cron expression (default: every 3 minutes)
        // Window position and size settings
        windowBounds: {
            login: {x: undefined, y: undefined, width: 800, height: 960},
            main: {x: undefined, y: undefined, width: 800, height: 960},
        },
        // Schema-based challenge settings
        challengeSettings: {
            globalDefaults: globalDefaults,
            perChallenge: {}, // Challenge ID -> setting overrides mapping
        },
        // API headers for randomization (random per user installation)
        apiHeaders: {},
        // Add any other default settings as needed
    };
};

/**
 * Validates a single setting value against SETTINGS_SCHEMA. Keys that
 * are not in the schema are treated as valid because the schema is
 * the only source of validation rules for per-challenge tunables.
 *
 * @param {string} key
 * @param {any} value
 * @param {Object} [allSettings] - Other settings for context-aware validation.
 * @param {string} [challengeId]
 * @returns {boolean}
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
 * Simple settings storage without caching
 *
 * Settings are always read fresh from disk to ensure consistency
 * between CLI and GUI, especially for edit operations.
 */

// Module-local guards so cleanupObsoleteSettings (which itself calls
// loadSettings) doesn't recurse and doesn't re-run on every read.
let migrationInProgress = false;
let cleanupCompleted = false;

// Detects whether autovote is currently running. The flag is set by
// the autovote orchestration code, possibly on different global
// surfaces depending on whether we're in Electron main, renderer, or
// the CLI.
const isAutovoteRunning = () => {
    if (typeof global !== 'undefined' && global.autovoteRunning) return true;
    if (typeof globalThis !== 'undefined' && globalThis.autovoteRunning) return true;
    try {
        // eslint-disable-next-line no-undef
        if (typeof window !== 'undefined' && window.autovoteRunning) return true;
    } catch {
        // window not available outside the renderer; ignore
    }
    return false;
};

// Load settings from the userData directory
const loadSettings = () => {

    try {
        const settingsPath = getSettingsPath();

        // Check if the settings file exists
        if (fs.existsSync(settingsPath)) {
            // Read and parse the settings file
            const settingsData = fs.readFileSync(settingsPath, 'utf8');
            const settings = JSON.parse(settingsData);

            // Merge with default settings to ensure all properties exist
            const mergedSettings = {...getDefaultSettings(), ...settings};

            // Mock setting can be user-controlled, but default to environment if not set
            if (mergedSettings.mock === undefined) {
                mergedSettings.mock = getDefaultMockSetting();
            }

            // Migration: Handle old setting names
            let migrationChanges = false;
            
            // Migrate lastMinutes to lastMinuteThreshold
            if (mergedSettings.lastMinutes !== undefined && mergedSettings.lastMinuteThreshold === undefined) {
                mergedSettings.lastMinuteThreshold = mergedSettings.lastMinutes;
                delete mergedSettings.lastMinutes;
                migrationChanges = true;
                logger.withCategory('settings').info('Migrated lastMinutes to lastMinuteThreshold', null);
            }
            
            // Migrate voteOnlyInLastThreshold to voteOnlyInLastMinute
            if (mergedSettings.voteOnlyInLastThreshold !== undefined && mergedSettings.voteOnlyInLastMinute === undefined) {
                mergedSettings.voteOnlyInLastMinute = mergedSettings.voteOnlyInLastThreshold;
                delete mergedSettings.voteOnlyInLastThreshold;
                migrationChanges = true;
                logger.withCategory('settings').info('Migrated voteOnlyInLastThreshold to voteOnlyInLastMinute', null);
            }
            
            // Migrate lastThresholdCheckFrequency to lastMinuteCheckFrequency
            if (mergedSettings.lastThresholdCheckFrequency !== undefined && mergedSettings.lastMinuteCheckFrequency === undefined) {
                mergedSettings.lastMinuteCheckFrequency = mergedSettings.lastThresholdCheckFrequency;
                delete mergedSettings.lastThresholdCheckFrequency;
                migrationChanges = true;
                logger.withCategory('settings').info('Migrated lastThresholdCheckFrequency to lastMinuteCheckFrequency', null);
            }
            
            // Migrate votingInterval to votingFrequency
            if (mergedSettings.votingInterval !== undefined && mergedSettings.votingFrequency === undefined) {
                mergedSettings.votingFrequency = mergedSettings.votingInterval;
                delete mergedSettings.votingInterval;
                migrationChanges = true;
                logger.withCategory('settings').info('Migrated votingInterval to votingFrequency', null);
            }
            
            // Migrate votingFrequency to voteFrequency
            if (mergedSettings.votingFrequency !== undefined && mergedSettings.voteFrequency === undefined) {
                mergedSettings.voteFrequency = mergedSettings.votingFrequency;
                delete mergedSettings.votingFrequency;
                migrationChanges = true;
                logger.withCategory('settings').info('Migrated votingFrequency to voteFrequency', null);
            }
            
            // Migrate voteFrequency to checkFrequency
            if (mergedSettings.voteFrequency !== undefined && mergedSettings.checkFrequency === undefined) {
                mergedSettings.checkFrequency = mergedSettings.voteFrequency;
                delete mergedSettings.voteFrequency;
                migrationChanges = true;
                logger.withCategory('settings').info('Migrated voteFrequency to checkFrequency', null);
            }

            // If migration made changes, save the updated settings
            if (migrationChanges) {
                fs.writeFileSync(settingsPath, JSON.stringify(mergedSettings, null, 2), 'utf8');
            }

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
                        logger.withCategory('settings').debug('⏸️ Skipping obsolete settings cleanup - autovote is running');
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
        logger.withCategory('settings').info(`No settings file found, loaded default settings with keys: ${Object.keys(defaultSettings).join(', ')}`);
        return defaultSettings;
    } catch (error) {
        logger.withCategory('settings').error('Error loading settings:', error);
        // Return default settings if there's an error
        const defaultSettings = getDefaultSettings();
        logger.withCategory('settings').info(`Loaded default settings with keys: ${Object.keys(defaultSettings).join(', ')}`);
        return defaultSettings;
    }
};

// Save settings to the userData directory
const saveSettings = (settings) => {
    try {
        const settingsPath = getSettingsPath();

        // Ensure the directory exists
        const settingsDir = path.dirname(settingsPath);
        if (!fs.existsSync(settingsDir)) {
            fs.mkdirSync(settingsDir, {recursive: true});
        }

        // Merge with existing settings
        const currentSettings = loadSettings();
        const mergedSettings = {...currentSettings, ...settings};

        // Write the settings to the file
        fs.writeFileSync(settingsPath, JSON.stringify(mergedSettings, null, 2), 'utf8');

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
 * @param {string} key - The setting key to check
 * @returns {boolean} - True if reload is required, false otherwise
 */
const isReloadRequired = (key) => {
    // Only these settings require a reload
    const reloadSettings = ['theme', 'language', 'timezone'];
    
    // Check if it's a challenge-specific setting
    const isChallengeSetting = SETTINGS_SCHEMA[key] && SETTINGS_SCHEMA[key].perChallenge;
    
    return reloadSettings.includes(key) || isChallengeSetting;
};

// Get the userData directory path (useful for debugging)
const getUserDataPath = () => {
    return path.dirname(getSettingsPath());
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

// Get current environment information
const getEnvironmentInfo = () => {
    const isElectronPackaged = electronApp ? electronApp.isPackaged : false;
    const isBuiltApp = isElectronPackaged || !isSourceCode();
    
    return {
        ...runtime.getEnvSnapshot(),
        defaultMock: getDefaultMockSetting(),
        platform: process.platform,
        userDataPath: getUserDataPath(),
        isSourceCode: isSourceCode(),
        isElectronPackaged: isElectronPackaged,
        isBuiltApp: isBuiltApp,
        appName: getAppName(),
    };
};

/**
 * Schema-based Settings Helper Functions
 */

/**
 * Get global default value for a setting
 * @param {string} settingKey - The setting key from SETTINGS_SCHEMA
 * @returns {any} - The global default value
 */
const getGlobalDefault = (settingKey) => {
    const settings = loadSettings();
    const challengeSettings = settings.challengeSettings || getDefaultSettings().challengeSettings;

    if (challengeSettings.globalDefaults && Object.prototype.hasOwnProperty.call(challengeSettings.globalDefaults, settingKey)) {
        return challengeSettings.globalDefaults[settingKey];
    }

    // Fallback to schema default if not found in settings
    return SETTINGS_SCHEMA[settingKey]?.default;
};

/**
 * Get detailed validation error information for a setting
 * @param {string} settingKey - The setting key
 * @param {*} value - The value to validate
 * @param {object} allSettings - All settings for context validation
 * @returns {string|null} - Error message if validation fails, null if valid
 */
const getValidationError = (settingKey, value, allSettings = null) => {
    const schemaConfig = SETTINGS_SCHEMA[settingKey];
    if (!schemaConfig) {
        return null; // No schema config, assume valid
    }

    // Check basic validation first
    if (schemaConfig.validation && !schemaConfig.validation(value)) {
        return 'Invalid value';
    }

    // Check context validation only if basic validation passes
    if (schemaConfig.contextValidation && allSettings) {
        if (!schemaConfig.contextValidation(value, allSettings)) {
            // Return context-specific error if available
            if (schemaConfig.getContextError) {
                return schemaConfig.getContextError(value, allSettings);
            }
            return 'Invalid value in current context';
        }
    }

    return null; // Valid
};

/**
 * Set global default value for a setting
 * @param {string} settingKey - The setting key from SETTINGS_SCHEMA
 * @param {any} value - The value to set
 * @returns {boolean} - True if successful, false otherwise
 */
const setGlobalDefault = (settingKey, value) => {
    if (!SETTINGS_SCHEMA[settingKey]) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return false;
    }

    // Get current global defaults for context validation
    const settings = loadSettings();
    const currentGlobalDefaults = settings.challengeSettings?.globalDefaults || {};
    const contextSettings = {...currentGlobalDefaults, [settingKey]: value};
    
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
 * @param {string} settingKey - The setting key from SETTINGS_SCHEMA
 * @param {string} challengeId - The challenge ID
 * @returns {any|null} - The override value, or null if no override exists
 */
const getChallengeOverride = (settingKey, challengeId) => {
    const settings = loadSettings();
    const challengeSettings = settings.challengeSettings || getDefaultSettings().challengeSettings;

    if (challengeSettings.perChallenge &&
        challengeSettings.perChallenge[challengeId] &&
        Object.prototype.hasOwnProperty.call(challengeSettings.perChallenge[challengeId], settingKey)) {
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
        ? {...globalDefaults, ...existingOverrides, ...batchOverrides}
        : {...globalDefaults, ...existingOverrides, [settingKey]: value};

    if (!validateSetting(settingKey, value, contextSettings, challengeId)) {
        logger.withCategory('settings').error(`Invalid value for setting ${settingKey}:`, value);
        return 'invalid';
    }

    const container = _ensureChallengeContainer(settings, challengeId);
    if (value !== getGlobalDefault(settingKey)) {
        container[settingKey] = value;
        return 'set';
    }
    delete container[settingKey];
    return 'cleared';
};

/**
 * Set per-challenge override value for a setting.
 * @param {string} settingKey
 * @param {string} challengeId
 * @param {any} value
 * @returns {boolean}
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
 * @param {string} challengeId
 * @param {Object} overrides - { settingKey: value, ... }
 * @returns {boolean}
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
        logger.withCategory('general').debug(`💾 Saved overrides for challenge ${challengeId}:`, savedOverrides.join(', '));
    }
    if (removedOverrides.length > 0) {
        logger.withCategory('general').debug(`🗑️ Removed overrides for challenge ${challengeId}:`, removedOverrides.join(', '));
    }

    return hasChanges ? saveSettings(settings) : true;
};

/**
 * Remove per-challenge override for a setting
 * @param {string} settingKey - The setting key from SETTINGS_SCHEMA
 * @param {string} challengeId - The challenge ID
 * @returns {boolean} - True if successful, false otherwise
 */
const removeChallengeOverride = (settingKey, challengeId) => {
    const settings = loadSettings();
    if (!settings.challengeSettings ||
        !settings.challengeSettings.perChallenge ||
        !settings.challengeSettings.perChallenge[challengeId]) {
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
 * Get the effective value for a setting (per-challenge override or global default)
 * @param {string} settingKey - The setting key from SETTINGS_SCHEMA
 * @param {string} challengeId - The challenge ID (optional for global-only settings)
 * @returns {any} - The effective value to use
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
 * Cleanup stale challenge settings for challenges that no longer exist
 * @param {string[]} activeChallengeIds - Array of currently active challenge IDs
 * @returns {boolean} - True if cleanup was successful, false otherwise
 */
const cleanupStaleChallengeSetting = (activeChallengeIds) => {
    const settings = loadSettings();
    if (!settings.challengeSettings || !settings.challengeSettings.perChallenge) {
        return true; // Nothing to cleanup
    }

    const storedChallengeIds = Object.keys(settings.challengeSettings.perChallenge);
    const staleChallengeIds = storedChallengeIds.filter(id => !activeChallengeIds.includes(id));

    if (staleChallengeIds.length === 0) {
        return true; // Nothing to cleanup
    }

    logger.withCategory('settings').debug(`Cleaning up settings for ${staleChallengeIds.length} stale challenges:`, staleChallengeIds);


    staleChallengeIds.forEach(challengeId => {
        delete settings.challengeSettings.perChallenge[challengeId];
    });

    return saveSettings(settings);
};

/**
 * Clean up obsolete settings that are no longer used
 * This function removes deprecated settings to keep the settings file clean
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
                const invalidGlobalKeys = globalDefaultKeys.filter(key => !validSchemaKeys.includes(key));

                if (invalidGlobalKeys.length > 0) {
                    logger.withCategory('settings').debug(`Removing invalid global default keys: ${invalidGlobalKeys.join(', ')}`);
                    invalidGlobalKeys.forEach(key => {
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
                    const invalidKeys = Object.keys(challengeOverrides).filter(key => !validSchemaKeys.includes(key));

                    if (invalidKeys.length > 0) {
                        logger.withCategory('settings').debug(`Removing invalid override keys for challenge ${challengeId}:`, invalidKeys);
                        invalidKeys.forEach(key => {
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
 * @param {string} key - The setting key to reset
 * @returns {boolean} - True if successful, false otherwise
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
 * @param {string} settingKey - The setting key from SETTINGS_SCHEMA
 * @returns {boolean} - True if successful, false otherwise
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
 * @returns {boolean} - True if successful, false otherwise
 */
const resetAllGlobalDefaults = () => {
    try {
        const settings = loadSettings();
        if (!settings.challengeSettings) {
            settings.challengeSettings = getDefaultSettings().challengeSettings;
        }

        // Reset all global defaults to schema defaults
        const globalDefaults = {};
        Object.keys(SETTINGS_SCHEMA).forEach(key => {
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
 * @returns {boolean} - True if successful, false otherwise
 */
const resetAllSettings = () => {
    try {
        const currentSettings = loadSettings();
        const defaultSettings = getDefaultSettings();
        
        // Settings to preserve (only essential user data that shouldn't be reset)
        const preserveKeys = ['token', 'mock', 'apiHeaders'];
        
        // Start with defaults
        const newSettings = {...defaultSettings};
        
        // Preserve specified user data
        preserveKeys.forEach(key => {
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
 * @param {string} key - The setting key to check
 * @returns {boolean} - True if modified from default, false if at default value
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
        
        return JSON.stringify(currentValue) !== JSON.stringify(defaultValue);
    } catch (error) {
        logger.withCategory('settings').error(`Error checking if setting ${key} is modified:`, error);
        return false;
    }
};

/**
 * Check if a global default has been modified from its schema default
 * @param {string} settingKey - The setting key from SETTINGS_SCHEMA
 * @returns {boolean} - True if modified from schema default, false if at schema default
 */
const isGlobalDefaultModified = (settingKey) => {
    try {
        if (!SETTINGS_SCHEMA[settingKey]) {
            return false;
        }

        const currentValue = getGlobalDefault(settingKey);
        const schemaDefault = SETTINGS_SCHEMA[settingKey].default;
        
        return JSON.stringify(currentValue) !== JSON.stringify(schemaDefault);
    } catch (error) {
        logger.withCategory('settings').error(`Error checking if global default ${settingKey} is modified:`, error);
        return false;
    }
};

/**
 * Helper to get schema default at runtime (avoids circular reference during schema construction)
 * @param {string} key - The schema key
 * @returns {any} - The default value for the key
 */
const getSchemaDefault = (key) => SETTINGS_SCHEMA[key]?.default;

/**
 * Centralized Settings Schema
 *
 * Single source of truth for all configurable settings.
 * Each setting defines its type, default value, validation, and whether it supports per-challenge overrides.
 */
const SETTINGS_SCHEMA = {
    boostTime: {
        type: 'time', // Special type for hours/minutes input
        default: 3600, // 1 hour in seconds
        perChallenge: true,
        validation: (value) => typeof value === 'number' && value >= 0,
        validationOrder: 1, // Validate first (no dependencies)
        label: 'app.boostTime',
        description: 'app.boostTimeDesc',
    },
    exposure: {
        type: 'number',
        default: 100,
        perChallenge: true,
        validation: (value) => typeof value === 'number' && value >= 1 && value <= 100,
        validationOrder: 1, // Validate first (no dependencies)
        label: 'app.exposure',
        description: 'app.exposureDesc',
    },
    lastMinuteThreshold: {
        type: 'number',
        default: 10,
        perChallenge: true,
        validation: (value) => typeof value === 'number' && value >= 1 && value <= 59,
        validationOrder: 1, // Validate first (no dependencies)
        label: 'app.lastMinuteThreshold',
        description: 'app.lastMinuteThresholdDesc',
    },
    onlyBoost: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: (value) => typeof value === 'boolean',
        validationOrder: 1, // Validate first (no dependencies)
        label: 'app.onlyBoost',
        description: 'app.onlyBoostDesc',
    },
    voteOnlyInLastMinute: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: (value) => typeof value === 'boolean',
        validationOrder: 1, // Validate first (no dependencies)
        label: 'app.voteOnlyInLastMinute',
        description: 'app.voteOnlyInLastMinuteDesc',
    },
    lastMinuteCheckFrequency: {
        type: 'number',
        default: 1,
        perChallenge: false,
        validation: (value) => typeof value === 'number' && value >= 1 && value <= 59,
        validationOrder: 1, // Validate first (no dependencies)
        label: 'app.lastMinuteCheckFrequency',
        description: 'app.lastMinuteCheckFrequencyDesc',
    },
    lastHourExposure: {
        type: 'number',
        default: 100,
        perChallenge: true,
        validation: (value) => typeof value === 'number' && value >= 1 && value <= 100,
        contextValidation: (value, allSettings) => {
            const exposureValue = allSettings.exposure;
            // If exposure is not set or invalid, use the exposure default for comparison
            const effectiveExposure = (typeof exposureValue === 'number' && exposureValue >= 1 && exposureValue <= 100) 
                ? exposureValue 
                : getSchemaDefault('exposure');
            return value <= effectiveExposure;
        },
        getContextError: (value, allSettings) => {
            const exposureValue = allSettings.exposure;
            const effectiveExposure = (typeof exposureValue === 'number' && exposureValue >= 1 && exposureValue <= 100) 
                ? exposureValue 
                : getSchemaDefault('exposure');
            // Return a string that the UI will translate
            return `VALIDATION_LESS_OR_EQUAL|app.exposure|${effectiveExposure}`;
        },
        dependsOn: ['exposure'],
        validationOrder: 2, // Validate after dependencies
        label: 'app.lastHourExposure',
        description: 'app.lastHourExposureDesc',
    },
    useLastHourExposure: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: (value) => typeof value === 'boolean',
        validationOrder: 1, // Validate first (no dependencies)
        label: 'app.useLastHourExposure',
        description: 'app.useLastHourExposureDesc',
    },
    autoTurbo: {
        type: 'boolean',
        default: true,
        perChallenge: true,
        validation: (value) => typeof value === 'boolean',
        validationOrder: 1,
        label: 'app.autoTurbo',
        description: 'app.autoTurboDesc',
    },
    useTurbo: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: (value) => typeof value === 'boolean',
        validationOrder: 1,
        label: 'app.useTurbo',
        description: 'app.useTurboDesc',
    },
    turboTime: {
        type: 'time',
        default: 7200, // 2 hours in seconds
        perChallenge: true,
        validation: (value) => typeof value === 'number' && value >= 0,
        validationOrder: 1,
        label: 'app.turboTime',
        description: 'app.turboTimeDesc',
    },
    turboImageIndex: {
        type: 'number',
        default: 1,
        perChallenge: true,
        validation: (value) => Number.isInteger(value) && value >= 1,
        validationOrder: 1,
        label: 'app.turboImageIndex',
        description: 'app.turboImageIndexDesc',
    },
    turboApplyWhenBoostActive: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: (value) => typeof value === 'boolean',
        validationOrder: 1,
        label: 'app.turboApplyWhenBoostActive',
        description: 'app.turboApplyWhenBoostActiveDesc',
    },
};

/**
 * Get the settings schema
 *
 * @returns {Promise<object>} - Settings schema
 */
const getSettingsSchema = async () => {
    return SETTINGS_SCHEMA;
};

module.exports = {
    loadSettings,
    saveSettings,
    getSetting,
    setSetting,
    isReloadRequired,
    getDefaultSettings,
    getUserDataPath,
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
};