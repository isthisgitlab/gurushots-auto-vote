const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');

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
        const appName = getAppName();

        // Use platform-specific paths
        switch (process.platform) {
        case 'darwin': // macOS
            userDataPath = path.join(os.homedir(), 'Library', 'Application Support', appName);
            break;
        case 'win32': // Windows
            userDataPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
            break;
        default: // Linux and others
            userDataPath = path.join(os.homedir(), '.config', appName);
            break;
        }

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
 * Determine the default mock setting based on environment
 *
 * @returns {boolean} - True for development, false for production
 */
const getDefaultMockSetting = () => {
    // Check for explicit environment variables
    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'dev') {
        return true;
    }

    if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod') {
        return false;
    }

    // Check for other development indicators
    if (process.env.DEV === 'true' || process.env.DEV === '1') {
        return true;
    }

    if (process.env.PROD === 'true' || process.env.PROD === '1') {
        return false;
    }

    // Check if running in development mode (common patterns)
    const isProd =
        process.env.NODE_ENV === 'production' ||
        process.env.NODE_ENV === 'prod' ||
        process.env.PROD === 'true' ||
        process.env.PROD === '1';

    // Default to production mode (mock disabled) for safety
    if (isProd) {
        return false;
    }

    // Default to production mode (mock disabled) for safety
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
 * Settings validation system
 *
 * This validation system ensures data integrity by validating settings values
 * against a schema. Invalid values are automatically reset to their defaults.
 * This prevents issues caused by corrupted settings or manual edits to the settings file.
 */

/**
 * Validation schema for settings
 * Each key has a function that returns true if the value is valid, false otherwise
 */
const settingsSchema = {
    theme: (value) => ['light', 'dark'].includes(value),
    stayLoggedIn: (value) => typeof value === 'boolean',
    lastUsername: (value) => typeof value === 'string',
    mock: (value) => typeof value === 'boolean',
    token: (value) => typeof value === 'string',
    timezone: (value) => typeof value === 'string',
    customTimezones: (value) => Array.isArray(value),
    language: (value) => ['en', 'lv'].includes(value),
    apiTimeout: (value) => typeof value === 'number' && value >= 1 && value <= 120,
    checkFrequency: (value) => typeof value === 'number' && value >= 1 && value <= 60,
    windowBounds: (value) => typeof value === 'object' && value !== null,
    challengeSettings: (value) => {
        if (typeof value !== 'object' || value === null) return false;
        if (typeof value.globalDefaults !== 'object' || value.globalDefaults === null) return false;
        if (typeof value.perChallenge !== 'object' || value.perChallenge === null) return false;

        // Validate global defaults against schema
        for (const [key] of Object.entries(SETTINGS_SCHEMA)) {
            if (Object.prototype.hasOwnProperty.call(value.globalDefaults, key)) {
                // Use the enhanced validateSetting function for consistency
                if (!validateSetting(key, value.globalDefaults[key], value.globalDefaults)) return false;
            }
        }

        // Validate per-challenge overrides against schema
        for (const [, challengeOverrides] of Object.entries(value.perChallenge)) {
            if (typeof challengeOverrides !== 'object' || challengeOverrides === null) return false;
            for (const [key, overrideValue] of Object.entries(challengeOverrides)) {
                if (SETTINGS_SCHEMA[key]) {
                    // Merge global defaults with challenge overrides for context
                    const contextSettings = {...value.globalDefaults, ...challengeOverrides};
                    if (!validateSetting(key, overrideValue, contextSettings)) return false;
                }
            }
        }

        return true;
    },
    apiHeaders: (value) => typeof value === 'object' && value !== null,
};

/**
 * Validates a single setting against its schema
 * @param {string} key - The setting key to validate
 * @param {any} value - The value to validate
 * @param {Object} allSettings - All settings values for context validation (optional)
 * @param {string} challengeId - Challenge ID for per-challenge validation context (optional)
 * @returns {boolean} - True if valid, false otherwise
 */
const validateSetting = (key, value, allSettings = null, challengeId = null) => {
    // Check both settingsSchema (legacy) and SETTINGS_SCHEMA (new)
    const legacyValidator = settingsSchema[key];
    const schemaConfig = SETTINGS_SCHEMA[key];
    
    // If we have neither validator, assume it's valid
    if (!legacyValidator && !schemaConfig) return true;
    
    // Run legacy validator if it exists
    if (legacyValidator && !legacyValidator(value)) {
        return false;
    }
    
    // Run schema validation if it exists
    if (schemaConfig) {
        // Basic validation
        if (schemaConfig.validation && !schemaConfig.validation(value)) {
            return false;
        }
        
        // Context validation (requires allSettings)
        if (schemaConfig.contextValidation && allSettings) {
            if (!schemaConfig.contextValidation(value, allSettings, challengeId)) {
                return false;
            }
        }
    }
    
    return true;
};


/**
 * Simple settings storage without caching
 *
 * Settings are always read fresh from disk to ensure consistency
 * between CLI and GUI, especially for edit operations.
 */

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

            // Run migration for boost configuration if needed - but avoid recursion
            if (!global.migrationInProgress) {
                global.migrationInProgress = true;
                try {
                    // Only run cleanup once per app session, not on every settings load
                    // Also skip cleanup if autovote is running to avoid interfering with active operations
                    // Check if autovote is running across different environments
                    let isAutovoteRunning = false;
                    if (typeof global !== 'undefined' && global.autovoteRunning) {
                        isAutovoteRunning = true;
                    }
                    if (typeof globalThis !== 'undefined' && globalThis.autovoteRunning) {
                        isAutovoteRunning = true;
                    }
                    try {
                        // eslint-disable-next-line no-undef
                        if (typeof window !== 'undefined' && window.autovoteRunning) {
                            isAutovoteRunning = true;
                        }
                    } catch {
                        // window not available (Node.js context)
                    }
                    
                    if (!global.cleanupCompleted && !isAutovoteRunning) {
                        cleanupObsoleteSettings();
                        global.cleanupCompleted = true;
                    } else if (isAutovoteRunning) {
                        logger.withCategory('settings').debug('⏸️ Skipping obsolete settings cleanup - autovote is running');
                    }
                } catch (migrationError) {
                    logger.withCategory('settings').warning('Cleanup failed:', migrationError);
                } finally {
                    global.migrationInProgress = false;
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
        nodeEnv: process.env.NODE_ENV,
        dev: process.env.DEV,
        prod: process.env.PROD,
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
 * Set per-challenge override value for a setting
 * @param {string} settingKey - The setting key from SETTINGS_SCHEMA
 * @param {string} challengeId - The challenge ID
 * @param {any} value - The value to set
 * @returns {boolean} - True if successful, false otherwise
 */
const setChallengeOverride = (settingKey, challengeId, value) => {
    if (!SETTINGS_SCHEMA[settingKey]) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return false;
    }

    if (!SETTINGS_SCHEMA[settingKey].perChallenge) {
        logger.withCategory('settings').error(`Setting ${settingKey} does not support per-challenge overrides`, null);
        return false;
    }

    // Get current settings for context validation
    const settings = loadSettings();
    const globalDefaults = settings.challengeSettings?.globalDefaults || {};
    const existingOverrides = settings.challengeSettings?.perChallenge?.[challengeId] || {};
    const contextSettings = {...globalDefaults, ...existingOverrides, [settingKey]: value};

    if (!validateSetting(settingKey, value, contextSettings, challengeId)) {
        logger.withCategory('settings').error(`Invalid value for setting ${settingKey}:`, value);
        return false;
    }

    if (!settings.challengeSettings) {
        settings.challengeSettings = getDefaultSettings().challengeSettings;
    }
    if (!settings.challengeSettings.perChallenge) {
        settings.challengeSettings.perChallenge = {};
    }
    if (!settings.challengeSettings.perChallenge[challengeId]) {
        settings.challengeSettings.perChallenge[challengeId] = {};
    }

    // Get the global default value for comparison
    const globalDefault = getGlobalDefault(settingKey);

    // Only save if the value is different from global default
    if (value !== globalDefault) {
        settings.challengeSettings.perChallenge[challengeId][settingKey] = value;
    } else {
        // If value matches global default, remove the override
        delete settings.challengeSettings.perChallenge[challengeId][settingKey];

        // If challenge has no more overrides, remove the challenge entry
        if (Object.keys(settings.challengeSettings.perChallenge[challengeId]).length === 0) {
            delete settings.challengeSettings.perChallenge[challengeId];
        }
    }

    return saveSettings(settings);
};

/**
 * Set multiple per-challenge overrides efficiently, only saving values that differ from global defaults
 * @param {string} challengeId - The challenge ID
 * @param {Object} overrides - Object with settingKey -> value mappings
 * @returns {boolean} - True if successful, false otherwise
 */
const setChallengeOverrides = (challengeId, overrides) => {
    const settings = loadSettings();
    if (!settings.challengeSettings) {
        settings.challengeSettings = getDefaultSettings().challengeSettings;
    }
    if (!settings.challengeSettings.perChallenge) {
        settings.challengeSettings.perChallenge = {};
    }
    if (!settings.challengeSettings.perChallenge[challengeId]) {
        settings.challengeSettings.perChallenge[challengeId] = {};
    }

    let hasChanges = false;
    const savedOverrides = [];
    const removedOverrides = [];

    // Process each override
    for (const [settingKey, value] of Object.entries(overrides)) {
        if (!SETTINGS_SCHEMA[settingKey]) {
            logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
            continue;
        }

        if (!SETTINGS_SCHEMA[settingKey].perChallenge) {
            logger.withCategory('settings').error(`Setting ${settingKey} does not support per-challenge overrides`, null);
            continue;
        }

        // Create context with global defaults and current batch of overrides
        const globalDefaults = settings.challengeSettings?.globalDefaults || {};
        const existingOverrides = settings.challengeSettings?.perChallenge?.[challengeId] || {};
        const contextSettings = {...globalDefaults, ...existingOverrides, ...overrides};

        if (!validateSetting(settingKey, value, contextSettings, challengeId)) {
            logger.withCategory('settings').error(`Invalid value for setting ${settingKey}:`, value);
            continue;
        }

        // Get the global default value for comparison
        const globalDefault = getGlobalDefault(settingKey);

        // Only save if the value is different from global default
        if (value !== globalDefault) {
            settings.challengeSettings.perChallenge[challengeId][settingKey] = value;
            savedOverrides.push(`${settingKey}=${value}`);
            hasChanges = true;
        } else {
            // If value matches global default, remove the override
            delete settings.challengeSettings.perChallenge[challengeId][settingKey];
            removedOverrides.push(settingKey);
            hasChanges = true;
        }
    }

    // If challenge has no more overrides, remove the challenge entry
    if (Object.keys(settings.challengeSettings.perChallenge[challengeId]).length === 0) {
        delete settings.challengeSettings.perChallenge[challengeId];
        logger.withCategory('settings').debug(`🗑️ Removed empty challenge settings for challenge ${challengeId}`);
        hasChanges = true;
    }

    // Log the changes for debugging
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
                : SETTINGS_SCHEMA.exposure.default;
            return value <= effectiveExposure;
        },
        getContextError: (value, allSettings) => {
            const exposureValue = allSettings.exposure;
            const effectiveExposure = (typeof exposureValue === 'number' && exposureValue >= 1 && exposureValue <= 100) 
                ? exposureValue 
                : SETTINGS_SCHEMA.exposure.default;
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