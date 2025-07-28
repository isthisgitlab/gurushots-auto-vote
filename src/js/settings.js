const fs = require('fs');
const path = require('path');
const os = require('os');

// Try to import electron, but don't fail if it's not available (CLI context)
let electronApp = null;
try {
    const electron = require('electron');
    electronApp = electron.app;
} catch (error) {
    // Electron not available (CLI context), we'll use fallback
    console.log('Running in CLI context - using fallback userData path:', error.message);
}

// Define the settings file path in the userData directory
const getSettingsPath = () => {
    let userDataPath;
    
    if (electronApp && electronApp.getPath) {
        // Electron context - use app.getPath('userData')
        userDataPath = electronApp.getPath('userData');
    } else {
        // CLI context - create fallback userData path
        const appName = 'gurushots-auto-vote';
        
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
                fs.mkdirSync(userDataPath, { recursive: true });
                console.log(`Created userData directory: ${userDataPath}`);
            } catch (error) {
                console.error('Error creating userData directory:', error);
                // Fallback to current directory if we can't create the proper path
                userDataPath = path.join(process.cwd(), 'userData');
                if (!fs.existsSync(userDataPath)) {
                    fs.mkdirSync(userDataPath, { recursive: true });
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
    
    // Default to development mode if not explicitly set to production
    if (isProd) {
        return false;
    }
    
    // Default to development mode (mock enabled) for safety
    return true;
};

// Default settings with environment-aware mock setting
const getDefaultSettings = () => ({
    theme: 'light',
    stayLoggedIn: false,
    lastUsername: '',
    mock: getDefaultMockSetting(),
    token: '',
    timezone: 'Europe/Riga',
    customTimezones: [],
    language: 'en', // Default language
    // Window position and size settings
    windowBounds: {
        login: { x: undefined, y: undefined, width: 800, height: 600 },
        main: { x: undefined, y: undefined, width: 800, height: 600 },
    },
    // Boost configuration
    boostConfig: {
        defaultThreshold: 3600, // Default 1 hour (3600 seconds)
        perChallenge: {}, // Challenge ID -> threshold mapping
    },
    // Add any other default settings as needed
});

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
    windowBounds: (value) => typeof value === 'object' && value !== null,
    boostConfig: (value) => typeof value === 'object' && value !== null && 
                           typeof value.defaultThreshold === 'number' && 
                           typeof value.perChallenge === 'object',
};

/**
 * Validates a single setting against its schema
 * @param {string} key - The setting key to validate
 * @param {any} value - The value to validate
 * @returns {boolean} - True if valid, false otherwise
 */
const validateSetting = (key, value) => {
    // If we don't have a validator for this key, assume it's valid
    if (!settingsSchema[key]) return true;
    
    // Run the validator
    return settingsSchema[key](value);
};

/**
 * Validates all settings against their schemas
 * @param {Object} settings - The settings object to validate
 * @returns {Object} - Object containing validated settings and whether changes were made
 */
const validateSettings = (settings) => {
    const validatedSettings = { ...settings };
    let hasChanges = false;
    
    // Check each setting against its validator
    Object.keys(validatedSettings).forEach(key => {
        if (settingsSchema[key] && !validateSetting(key, validatedSettings[key])) {
            // If invalid, reset to default
            console.warn(`Invalid setting value for ${key}, resetting to default`);
            validatedSettings[key] = getDefaultSettings()[key];
            hasChanges = true;
        }
    });
    
    return { validatedSettings, hasChanges };
};

/**
 * Simple settings storage
 * 
 * Since settings are primarily modified during login/logout and rarely change
 * after the login token is written, we use a simple approach without time-based caching.
 * This simplifies the code while still providing the necessary functionality.
 */
let settingsCache = null;

// Load settings from the userData directory
const loadSettings = () => {
    // Return cached settings if available
    if (settingsCache) {
        return settingsCache;
    }
    
    try {
        const settingsPath = getSettingsPath();
        
        // Check if the settings file exists
        if (fs.existsSync(settingsPath)) {
            // Read and parse the settings file
            const settingsData = fs.readFileSync(settingsPath, 'utf8');
            const settings = JSON.parse(settingsData);
            
            // Merge with default settings to ensure all properties exist
            const mergedSettings = { ...getDefaultSettings(), ...settings };
            
            // Mock setting can be user-controlled, but default to environment if not set
            if (mergedSettings.mock === undefined) {
                mergedSettings.mock = getDefaultMockSetting();
            }
            
            // Validate settings
            const { validatedSettings, hasChanges } = validateSettings(mergedSettings);
            
            // If validation changed any settings, save the corrected settings
            if (hasChanges) {
                fs.writeFileSync(settingsPath, JSON.stringify(validatedSettings, null, 2), 'utf8');
            }
            
            settingsCache = validatedSettings;
            return settingsCache;
        }
        
        // If the file doesn't exist, return default settings
        settingsCache = { ...getDefaultSettings() };
        return settingsCache;
    } catch (error) {
        console.error('Error loading settings:', error);
        // Return default settings if there's an error
        settingsCache = { ...getDefaultSettings() };
        return settingsCache;
    }
};

// Save settings to the userData directory
const saveSettings = (settings) => {
    try {
        const settingsPath = getSettingsPath();
        
        // Ensure the directory exists
        const settingsDir = path.dirname(settingsPath);
        if (!fs.existsSync(settingsDir)) {
            fs.mkdirSync(settingsDir, { recursive: true });
        }
        
        // Merge with existing settings
        const currentSettings = loadSettings();
        const mergedSettings = { ...currentSettings, ...settings };
        
        // Validate the merged settings
        const { validatedSettings, hasChanges } = validateSettings(mergedSettings);
        
        // If validation made changes, log a warning
        if (hasChanges) {
            console.warn('Some settings were invalid and have been reset to defaults');
        }
        
        // Write the validated settings to the file
        fs.writeFileSync(settingsPath, JSON.stringify(validatedSettings, null, 2), 'utf8');
        
        // Update the cache with the validated settings
        settingsCache = validatedSettings;
        
        return true;
    } catch (error) {
        console.error('Error saving settings:', error);
        // Invalidate the cache on error to force a fresh read next time
        settingsCache = null;
        return false;
    }
};

// Get a specific setting
const getSetting = (key) => {
    const settings = loadSettings();
    return settings[key];
};

// Set a specific setting
const setSetting = (key, value) => {
    const settings = loadSettings();
    settings[key] = value;
    const result = saveSettings(settings);
    
    // Clear cache to ensure fresh settings on next load
    settingsCache = null;
    
    return result;
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
    return {
        nodeEnv: process.env.NODE_ENV,
        dev: process.env.DEV,
        prod: process.env.PROD,
        defaultMock: getDefaultMockSetting(),
        platform: process.platform,
        userDataPath: getUserDataPath(),
    };
};

/**
 * Boost configuration helpers
 */
const getBoostThreshold = (challengeId) => {
    const settings = loadSettings();
    const boostConfig = settings.boostConfig || getDefaultSettings().boostConfig;
    
    // Check if there's a specific threshold for this challenge
    if (boostConfig.perChallenge && boostConfig.perChallenge[challengeId]) {
        return boostConfig.perChallenge[challengeId];
    }
    
    // Return default threshold
    return boostConfig.defaultThreshold || 3600;
};

const setBoostThreshold = (challengeId, threshold) => {
    const settings = loadSettings();
    const boostConfig = settings.boostConfig || getDefaultSettings().boostConfig;
    
    // Ensure perChallenge object exists
    if (!boostConfig.perChallenge) {
        boostConfig.perChallenge = {};
    }
    
    // Set the threshold for this challenge
    boostConfig.perChallenge[challengeId] = threshold;
    
    // Save the updated settings
    settings.boostConfig = boostConfig;
    saveSettings(settings);
    settingsCache = null; // Clear cache to ensure fresh settings on next load
};

const setDefaultBoostThreshold = (threshold) => {
    const settings = loadSettings();
    const boostConfig = settings.boostConfig || getDefaultSettings().boostConfig;
    
    boostConfig.defaultThreshold = threshold;
    
    // Save the updated settings
    settings.boostConfig = boostConfig;
    saveSettings(settings);
    settingsCache = null; // Clear cache to ensure fresh settings on next load
};

module.exports = {
    loadSettings,
    saveSettings,
    getSetting,
    setSetting,
    getUserDataPath,
    getEnvironmentInfo,
    getDefaultSettings,
    getDefaultMockSetting,
    saveWindowBounds,
    getWindowBounds,
    getBoostThreshold,
    setBoostThreshold,
    setDefaultBoostThreshold,
};