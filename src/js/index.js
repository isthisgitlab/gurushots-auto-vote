const {app, BrowserWindow, ipcMain, session} = require('electron');
const path = require('path');
const fs = require('fs');
const settings = require('./settings');
const {initializeHeaders} = require('./api/randomizer');
const logger = require('./logger');
const votingLogic = require('./services/VotingLogic');
const { createApplicationMenu, updateMenuTranslations } = require('./ui/applicationMenu');
const { translationManager } = require('./translations');

// Initialize global translation manager for menu module access
global.translationManager = translationManager;

// Disable service workers at the application level
app.commandLine.appendSwitch('disable-features', 'ServiceWorker');

// Global force exit handler to ensure the application always terminates
let forceExitTimeout = null;

// Function to ensure the process exits completely
function ensureExit(reason) {
    // Clear any existing timeout to prevent multiple force exits
    if (forceExitTimeout) {
        clearTimeout(forceExitTimeout);
    }

    logger.info(`Ensuring exit after ${reason}...`);

    // Set a timeout to force exit after a delay
    forceExitTimeout = setTimeout(() => {
        logger.info(`Force exiting after ${reason}...`);
        process.exit(0);
    }, 1000); // 1 second timeout
}

// Keep a global reference of the windows to prevent them from being garbage collected
let loginWindow = null;
let mainWindow = null;

// Global voting cancellation flag
let shouldCancelVoting = false;

// Settings file watcher
let settingsWatcher = null;
let settingsReloadTimeout = null;

// Track main window creation time to prevent reload during login
let mainWindowCreatedTime = null;

function createLoginWindow() {
    // Get saved window bounds
    const bounds = settings.getWindowBounds('login');

    // Create the login window with saved bounds
    loginWindow = new BrowserWindow({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        icon: path.join(__dirname, '../assets/logo.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            webSecurity: true,
            // Use a custom session partition to isolate storage
            partition: 'persist:gurushots',
        },
    });

    // Load the login HTML file
    loginWindow.loadFile(path.join(__dirname, '../html/login.html'));

    // Open DevTools in development mode (optional)
    // loginWindow.webContents.openDevTools();

    // Ensure window is visible on screen
    loginWindow.once('ready-to-show', () => {
        if (!loginWindow.isVisible()) {
            loginWindow.center();
        }
    });

    // Save window bounds when window is moved or resized
    loginWindow.on('resize', () => {
        const newBounds = loginWindow.getBounds();
        settings.saveWindowBounds('login', newBounds);
    });

    loginWindow.on('move', () => {
        const newBounds = loginWindow.getBounds();
        settings.saveWindowBounds('login', newBounds);
    });

    // Handle window close
    loginWindow.on('closed', () => {
        loginWindow = null;
    });
}

function createMainWindow() {
    // Get saved window bounds
    const bounds = settings.getWindowBounds('main');

    // Track when main window is created to prevent reload during login
    mainWindowCreatedTime = Date.now();

    // Create the main application window with saved bounds
    mainWindow = new BrowserWindow({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        icon: path.join(__dirname, '../assets/logo.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            webSecurity: true,
            // Use a custom session partition to isolate storage
            partition: 'persist:gurushots',
        },
    });

    // Load the main application HTML file
    mainWindow.loadFile(path.join(__dirname, '../html/app.html'));

    // Ensure window is visible on screen
    mainWindow.once('ready-to-show', () => {
        if (!mainWindow.isVisible()) {
            mainWindow.center();
        }
    });

    // Save window bounds when window is moved or resized
    mainWindow.on('resize', () => {
        const newBounds = mainWindow.getBounds();
        settings.saveWindowBounds('main', newBounds);
    });

    mainWindow.on('move', () => {
        const newBounds = mainWindow.getBounds();
        settings.saveWindowBounds('main', newBounds);
    });

    // Handle window close
    mainWindow.on('closed', () => {
        mainWindow = null;
        // Stop watching settings file when window closes
        if (settingsWatcher) {
            settingsWatcher.close();
            settingsWatcher = null;
        }
    });

    // Watch settings file for changes and auto-reload with debouncing
    const settingsPath = path.join(settings.getUserDataPath(), 'settings.json');
    if (fs.existsSync(settingsPath)) {
        settingsWatcher = fs.watch(settingsPath, (eventType) => {
            if (eventType === 'change') {
                // Clear existing timeout to debounce rapid file changes
                if (settingsReloadTimeout) {
                    clearTimeout(settingsReloadTimeout);
                }

                // Reload after a short delay to avoid rapid reloads
                settingsReloadTimeout = setTimeout(() => {
                    // Prevent reload if main window was just created (during login)
                    const timeSinceCreation = Date.now() - mainWindowCreatedTime;
                    if (timeSinceCreation < 2000) { // 2 second window
                        logger.info('🔄 Settings file changed, but skipping reload (window recently created)');
                        return;
                    }
                    
                    logger.info('🔄 Settings file changed, reloading main window...');
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.reload();
                    }
                }, 500); // 500ms debounce
            }
        });
    }
}

// Check if we should auto-login based on saved token
function checkAutoLogin() {
    const userSettings = settings.loadSettings();

    // If we have a token and stay logged in is enabled, auto-login
    if (userSettings.token && userSettings.stayLoggedIn) {
        createMainWindow();
        return true;
    }

    // Otherwise, show the login window
    createLoginWindow();
    return false;
}

// When Electron has finished initialization
app.whenReady().then(async () => {
    // Log userData path for verification
    logger.info(`[App] UserData path: ${settings.getUserDataPath()}`);
    
    // Clear cache to prevent service worker database errors
    await session.defaultSession.clearCache();
    logger.info('[App] Browser cache cleared to prevent service worker database errors');
    
    // Initialize API headers on app startup
    initializeHeaders();

    // Run log cleanup on app startup
    logger.cleanup();

    // Create application menu
    createApplicationMenu();

    // Check if we should auto-login and run update check before creating main window
    const userSettings = settings.loadSettings();
    const shouldAutoLogin = userSettings.token && userSettings.stayLoggedIn;

    // If auto-login is enabled, check for updates before creating the main window
    if (shouldAutoLogin) {
        const UpdateChecker = require('./services/UpdateChecker');
        const updateChecker = new UpdateChecker();
        
        // Check for updates immediately (no delay) to prevent double challenge loading
        try {
            await updateChecker.checkForUpdates(true);
        } catch (error) {
            logger.error('Error during update check:', error);
        }
    }

    await checkAutoLogin();

    // If not auto-login, check for updates after login window is shown
    if (!shouldAutoLogin) {
        const UpdateChecker = require('./services/UpdateChecker');
        const updateChecker = new UpdateChecker();
        
        // Check for updates after a short delay to not block app startup
        setTimeout(async () => {
            try {
                await updateChecker.checkForUpdates(true);
            } catch (error) {
                logger.error('Error during update check:', error);
            }
        }, 3000); // 3 second delay
    }

    // On macOS, re-create a window when dock icon is clicked and no windows are open
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            checkAutoLogin();
        }
    });

    // Handle SIGINT and SIGTERM signals to ensure clean exit
    process.on('SIGINT', () => {
        logger.info('Received SIGINT signal. Exiting...');
        app.quit();
        // Use the global force exit handler to ensure the process terminates
        ensureExit('SIGINT');
    });

    process.on('SIGTERM', () => {
        logger.info('Received SIGTERM signal. Exiting...');
        app.quit();
        // Use the global force exit handler to ensure the process terminates
        ensureExit('SIGTERM');
    });

    // Set up a global force exit handler to ensure the process always terminates
    process.on('exit', (code) => {
        logger.info(`Process exiting with code: ${code}`);
    });
});

// Clear token when app is about to quit if stay logged in is not enabled
app.on('before-quit', () => {
    const userSettings = settings.loadSettings();

    // If stay logged in is not enabled, clear the token
    if (!userSettings.stayLoggedIn && userSettings.token) {
        settings.setSetting('token', '');
    }

    logger.info('Application is about to quit. Forcing exit...');

    // Use the global force exit handler to ensure the process terminates
    ensureExit('before-quit');
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
        logger.info('All windows closed. Forcing exit...');

        // Use the global force exit handler to ensure the process terminates
        ensureExit('window-all-closed');
    }
});

// Handle login success
ipcMain.on('login-success', () => {
    // Close login window
    if (loginWindow) {
        loginWindow.close();
    }
    // Create main application window
    createMainWindow();
});

// Handle logout
ipcMain.on('logout', () => {
    if (!mainWindow) return;

    // Always clear the token on logout (regardless of stay logged in setting)
    settings.setSetting('token', '');

    // Reset mock value to environment default while preserving theme and remember me settings
    const envInfo = settings.getEnvironmentInfo();
    settings.setSetting('mock', envInfo.defaultMock);

    // Open the login window only after the main window is fully closed
    mainWindow.once('closed', () => {
        // If a login window is already open, just focus it instead of creating a second one
        if (loginWindow) {
            loginWindow.focus();
        } else {
            createLoginWindow();
        }
    });

    // Close main window
    mainWindow.close();
});

/**
 * IPC Handlers for Settings Management
 *
 * These handlers provide robust error handling for IPC communication between
 * the main process and renderer processes. They validate input parameters,
 * catch and log errors, and provide fallback values when errors occur.
 * This makes the application more resilient to unexpected errors.
 */

// Handle get-settings request
ipcMain.handle('get-settings', async () => {
    try {
        return settings.loadSettings();
    } catch (error) {
        logger.error('Error handling get-settings request:', error);
        return settings.getDefaultSettings(); // Return default settings on error
    }
});

// Handle get-setting request for a specific key
ipcMain.handle('get-setting', async (event, key) => {
    try {
        // Validate input parameter
        if (typeof key !== 'string') {
            throw new Error('Invalid key type, expected string');
        }
        return settings.getSetting(key);
    } catch (error) {
        logger.error(`Error handling get-setting request for key "${key}":`, error);
        // Return the default value for this key if it exists, otherwise null
        const defaultSettings = settings.getDefaultSettings();
        return defaultSettings[key] !== undefined
            ? defaultSettings[key]
            : null;
    }
});

// Handle set-setting request
ipcMain.handle('set-setting', async (event, key, value) => {
    try {
        // Validate input parameter
        if (typeof key !== 'string') {
            throw new Error('Invalid key type, expected string');
        }
        return settings.setSetting(key, value);
    } catch (error) {
        logger.error(`Error handling set-setting request for key "${key}":`, error);
        return false; // Indicate failure
    }
});

// Handle save-settings request
ipcMain.handle('save-settings', async (event, newSettings) => {
    try {
        // Validate input parameter
        if (typeof newSettings !== 'object' || newSettings === null) {
            throw new Error('Invalid settings type, expected object');
        }
        return settings.saveSettings(newSettings);
    } catch (error) {
        logger.error('Error handling save-settings request:', error);
        return false; // Indicate failure
    }
});

// Handle gui-vote request
ipcMain.handle('gui-vote', async () => {
    try {
        const userSettings = settings.loadSettings();

        if (!userSettings.token) {
            return {
                success: false,
                error: 'No authentication token found',
            };
        }

        // Use the API factory to get the appropriate middleware
        const apiFactory = require('./apiFactory');
        const middleware = apiFactory.getMiddleware();

        // Call the GUI vote function
        const result = await middleware.guiVote();
        return result;
    } catch (error) {
        logger.error('Error handling gui-vote request:', error);
        return {
            success: false,
            error: error.message || 'Failed to load challenges',
        };
    }
});

// Handle get-active-challenges request
ipcMain.handle('get-active-challenges', async (event, token) => {
    try {
        logger.debug('=== IPC get-active-challenges ===');
        logger.debug('Token received:', !!token);

        // Use the API factory to get the appropriate strategy
        const {getApiStrategy} = require('./apiFactory');
        const strategy = getApiStrategy();

        // Call the getActiveChallenges function
        const result = await strategy.getActiveChallenges(token);
        return result;
    } catch (error) {
        logger.error('Error handling get-active-challenges request:', error);
        throw error;
    }
});

// Handle get-environment-info request
ipcMain.handle('get-environment-info', async () => {
    try {
        return settings.getEnvironmentInfo();
    } catch (error) {
        logger.error('Error handling get-environment-info request:', error);
        return {
            nodeEnv: 'unknown',
            dev: undefined,
            prod: undefined,
            defaultMock: true, // Safe default
            platform: process.platform,
            userDataPath: 'unknown',
        };
    }
});

// Handle refresh-api request
ipcMain.handle('refresh-api', async () => {
    try {
        logger.info('🔄 Refreshing API due to settings change');
        const apiFactory = require('./apiFactory');
        apiFactory.refreshApi();
        return {success: true};
    } catch (error) {
        logger.error('Error handling refresh-api request:', error);
        return {success: false, error: error.message};
    }
});

// Logger handlers

ipcMain.handle('log-debug', async (event, message, data) => {
    logger.setContext('GUI');
    logger.debug(message, data);
    logger.clearContext();
    return {success: true};
});

ipcMain.handle('log-error', async (event, message, data) => {
    logger.setContext('GUI');
    logger.error(message, data);
    logger.clearContext();
    return {success: true};
});

ipcMain.handle('log-api', async (event, message, data) => {
    logger.setContext('GUI');
    logger.api(message, data);
    logger.clearContext();
    return {success: true};
});

ipcMain.handle('get-log-file', async () => {
    return logger.getLogFile();
});

ipcMain.handle('get-error-log-file', async () => {
    return logger.getErrorLogFile();
});

ipcMain.handle('get-api-log-file', async () => {
    return logger.getApiLogFile();
});

// Boost configuration handlers
ipcMain.handle('get-boost-threshold', async (event, challengeId) => {
    try {
        return settings.getEffectiveSetting('boostTime', challengeId);
    } catch (error) {
        logger.error('Error getting boost threshold:', error);
        return settings.SETTINGS_SCHEMA.boostTime.default;
    }
});

ipcMain.handle('set-boost-threshold', async (event, challengeId, threshold) => {
    try {
        settings.setChallengeOverride('boostTime', challengeId.toString(), threshold);
        return {success: true};
    } catch (error) {
        logger.error('Error setting boost threshold:', error);
        return {success: false, error: error.message};
    }
});

ipcMain.handle('set-default-boost-threshold', async (event, threshold) => {
    try {
        settings.setGlobalDefault('boostTime', threshold);
        return {success: true};
    } catch (error) {
        logger.error('Error setting default boost threshold:', error);
        return {success: false, error: error.message};
    }
});

// New schema-based settings handlers
ipcMain.handle('get-settings-schema', async () => {
    try {
        const settings = require('./settings');
        const schema = settings.SETTINGS_SCHEMA;

        // Create a serializable version of the schema (without functions)
        const serializableSchema = {};
        Object.keys(schema).forEach(key => {
            serializableSchema[key] = {
                type: schema[key].type,
                default: schema[key].default,
                perChallenge: schema[key].perChallenge,
                label: schema[key].label,
                description: schema[key].description,

            };
        });

        return serializableSchema;
    } catch (error) {
        logger.error('Error getting settings schema:', error);
        return {};
    }
});

// Handle get validation error
ipcMain.handle('get-validation-error', async (event, settingKey, value, allSettings) => {
    try {
        const settings = require('./settings');
        return settings.getValidationError(settingKey, value, allSettings);
    } catch (error) {
        logger.error('Error getting validation error:', error);
        return 'Validation error';
    }
});

ipcMain.handle('get-global-default', async (event, settingKey) => {
    try {
        const settings = require('./settings');
        return settings.getGlobalDefault(settingKey);
    } catch (error) {
        logger.error('Error getting global default:', error);
        return null;
    }
});

ipcMain.handle('set-global-default', async (event, settingKey, value) => {
    try {
        const settings = require('./settings');
        return settings.setGlobalDefault(settingKey, value);
    } catch (error) {
        logger.error('Error setting global default:', error);
        return false;
    }
});

ipcMain.handle('get-challenge-override', async (event, settingKey, challengeId) => {
    try {
        const settings = require('./settings');
        return settings.getChallengeOverride(settingKey, challengeId);
    } catch (error) {
        logger.error('Error getting challenge override:', error);
        return false;
    }
});

ipcMain.handle('set-challenge-override', async (event, settingKey, challengeId, value) => {
    try {
        const settings = require('./settings');
        return settings.setChallengeOverride(settingKey, challengeId, value);
    } catch (error) {
        logger.error('Error setting challenge override:', error);
        return false;
    }
});

ipcMain.handle('set-challenge-overrides', async (event, challengeId, overrides) => {
    try {
        const settings = require('./settings');
        return settings.setChallengeOverrides(challengeId, overrides);
    } catch (error) {
        logger.error('Error setting challenge overrides:', error);
        return false;
    }
});

ipcMain.handle('remove-challenge-override', async (event, settingKey, challengeId) => {
    try {
        const settings = require('./settings');
        return settings.removeChallengeOverride(settingKey, challengeId);
    } catch (error) {
        logger.error('Error removing challenge override:', error);
        return false;
    }
});

ipcMain.handle('get-effective-setting', async (event, settingKey, challengeId) => {
    try {
        const settings = require('./settings');
        return settings.getEffectiveSetting(settingKey, challengeId);
    } catch (error) {
        logger.error('Error getting effective setting:', error);
        return null;
    }
});

ipcMain.handle('cleanup-stale-challenge-setting', async (event, activeChallengeIds) => {
    try {
        const settings = require('./settings');
        return settings.cleanupStaleChallengeSetting(activeChallengeIds);
    } catch (error) {
        logger.error('Error cleaning up stale challenge settings:', error);
        return false;
    }
});

ipcMain.handle('cleanup-stale-metadata', async (event, activeChallengeIds) => {
    try {
        const metadata = require('./metadata');
        return metadata.cleanupStaleMetadata(activeChallengeIds);
    } catch (error) {
        logger.error('Error cleaning up stale metadata:', error);
        return false;
    }
});

ipcMain.handle('cleanup-obsolete-settings', async () => {
    try {
        const settings = require('./settings');
        return settings.cleanupObsoleteSettings();
    } catch (error) {
        logger.error('Error cleaning up obsolete settings:', error);
        return false;
    }
});

// Reset settings handlers
ipcMain.handle('reset-setting', async (event, key) => {
    try {
        const settings = require('./settings');
        return settings.resetSetting(key);
    } catch (error) {
        logger.error('Error resetting setting:', error);
        return false;
    }
});

ipcMain.handle('reset-global-default', async (event, settingKey) => {
    try {
        const settings = require('./settings');
        return settings.resetGlobalDefault(settingKey);
    } catch (error) {
        logger.error('Error resetting global default:', error);
        return false;
    }
});

ipcMain.handle('reset-all-global-defaults', async () => {
    try {
        const settings = require('./settings');
        return settings.resetAllGlobalDefaults();
    } catch (error) {
        logger.error('Error resetting all global defaults:', error);
        return false;
    }
});

ipcMain.handle('reset-all-settings', async () => {
    try {
        const settings = require('./settings');
        return settings.resetAllSettings();
    } catch (error) {
        logger.error('Error resetting all settings:', error);
        return false;
    }
});

ipcMain.handle('is-setting-modified', async (event, key) => {
    try {
        const settings = require('./settings');
        return settings.isSettingModified(key);
    } catch (error) {
        logger.error('Error checking if setting is modified:', error);
        return false;
    }
});

ipcMain.handle('is-global-default-modified', async (event, settingKey) => {
    try {
        const settings = require('./settings');
        return settings.isGlobalDefaultModified(settingKey);
    } catch (error) {
        logger.error('Error checking if global default is modified:', error);
        return false;
    }
});

// Handle open external URL request
ipcMain.handle('open-external-url', async (event, url) => {
    try {
        const {shell} = require('electron');
        await shell.openExternal(url);
        return {success: true};
    } catch (error) {
        logger.error('Error opening external URL:', error);
        return {success: false, error: error.message};
    }
});

// Handle authenticate request for login
ipcMain.handle('authenticate', async (event, username, password, isMock) => {
    logger.info(`🔐 Authentication request received - Mock: ${isMock}, Username: ${username}`);
    try {
        if (isMock) {
            // Use mock authentication
            const {mockLoginSuccess, mockLoginFailure} = require('./mock/auth');

            // Simulate network delay for realistic behavior
            await new Promise(resolve => setTimeout(resolve, 500));


            const isValidCredential = true;

            if (isValidCredential) {
                const result = {
                    success: true,
                    token: mockLoginSuccess.token,
                    message: 'Mock login successful',
                    user: {
                        id: mockLoginSuccess.user.id,
                        email: username,
                        username: mockLoginSuccess.user.username,
                        display_name: mockLoginSuccess.user.display_name,
                    },
                };
                logger.info('🔐 Mock authentication successful:', result);
                return result;
            } else {
                const result = {
                    success: false,
                    message: mockLoginFailure.message || 'Invalid mock credentials',
                };
                logger.info('🔐 Mock authentication failed:', result);
                return result;
            }
        } else {
            // Use real authentication
            const {authenticate} = require('./api/login');

            const response = await authenticate(username, password);

            if (!response) {
                return {
                    success: false,
                    message: 'Authentication failed - no response from server',
                };
            }

            // Check if the response indicates success
            logger.info('🔐 Real authentication response:', response);
            
            // The GuruShots API might return different response structures
            // Let's check for common success indicators
            if (response && (response.token || response.success === true || response.status === 'success')) {
                const token = response.token || response.access_token || response.auth_token;
                if (token) {
                    const result = {
                        success: true,
                        token: token,
                        message: 'Production login successful',
                        user: {
                            id: response.member_id || response.user_id || response.id,
                            email: username,
                            username: response.user_name || response.username || response.name,
                            display_name: response.user_name || response.username || response.name || response.display_name,
                        },
                    };
                    logger.info('🔐 Real authentication successful:', result);
                    return result;
                }
            }
            
            // If we get here, the response doesn't indicate success
            const result = {
                success: false,
                message: response.error || response.message || 'Authentication failed - invalid response from server',
            };
            logger.info('🔐 Real authentication failed:', result);
            return result;
        }
    } catch (error) {
        logger.error('Error handling authenticate request:', error);
        return {
            success: false,
            message: error.message || 'Authentication failed due to network error',
        };
    }
});

// Handle run-voting-cycle request
ipcMain.handle('run-voting-cycle', async () => {
    try {
        logger.info('🔄 Starting voting cycle...');

        const userSettings = settings.loadSettings();

        if (!userSettings.token) {
            logger.warning('❌ No token found for voting cycle');
            return {
                success: false,
                error: 'No authentication token found',
            };
        }

        // Use the API factory to get the appropriate strategy
        const {getApiStrategy} = require('./apiFactory');
        const strategy = getApiStrategy();

        // Create a function to get the effective exposure setting for each challenge
        const getExposureThreshold = (challengeId) => {
            try {
                return settings.getEffectiveSetting('exposure', challengeId);
            } catch (error) {
                logger.warning(`Error getting exposure setting for challenge ${challengeId}:`, error);
                return settings.SETTINGS_SCHEMA.exposure.default; // Fallback to schema default
            }
        };

        // Reset cancellation flag before starting
        shouldCancelVoting = false;

        // Set the cancellation flag in the API module
        const mainApi = require('./api/main');
        mainApi.setCancellationFlag(false);

        // Also set the cancellation flag in the mock API
        const mockApi = require('./mock');
        mockApi.setCancellationFlag(false);

        // Run the voting cycle with per-challenge exposure settings
        const result = await strategy.fetchChallengesAndVote(userSettings.token, getExposureThreshold);

        if (result && result.success) {
            return {
                success: true,
                message: result.message || 'Voting cycle completed successfully',
            };
        } else {
            return {
                success: false,
                error: result?.error || 'Voting cycle failed',
            };
        }
    } catch (error) {
        logger.error('Error handling run-voting-cycle request:', error);
        return {
            success: false,
            error: error.message || 'Failed to run voting cycle',
        };
    }
});

// Handle should-cancel-voting request
ipcMain.handle('should-cancel-voting', () => {
    return shouldCancelVoting;
});

// Handle set-cancel-voting request
ipcMain.handle('set-cancel-voting', (event, shouldCancel) => {
    shouldCancelVoting = shouldCancel;

    // Also set the flag in the API module
    const mainApi = require('./api/main');
    mainApi.setCancellationFlag(shouldCancel);

    // Also set the flag in the mock API
    const mockApi = require('./mock');
    mockApi.setCancellationFlag(shouldCancel);

    return shouldCancelVoting;
});

// Handle vote-on-challenge request
ipcMain.handle('vote-on-challenge', async (event, challengeId, challengeTitle) => {
    try {
        logger.info('🔄 Vote on challenge request:', {challengeId, challengeTitle});

        const userSettings = settings.loadSettings();

        if (!userSettings.token) {
            logger.warning('❌ No token found for voting');
            return {
                success: false,
                error: 'No authentication token found',
            };
        }

        // Use the API factory to get the appropriate strategy
        const {getApiStrategy} = require('./apiFactory');
        const strategy = getApiStrategy();

        // Get active challenges to find the specific challenge
        const challengesResponse = await strategy.getActiveChallenges(userSettings.token);

        if (!challengesResponse || !challengesResponse.challenges) {
            logger.warning('❌ Failed to fetch challenges for voting');
            return {
                success: false,
                error: 'Failed to fetch challenges',
            };
        }

        logger.debug('📋 Found challenges:', challengesResponse.challenges.map(c => ({id: c.id, title: c.title})));
        logger.debug('🔍 Looking for challenge ID:', challengeId, 'Type:', typeof challengeId);

        // Find the specific challenge (convert challengeId to number for comparison)
        const challenge = challengesResponse.challenges.find(c => c.id === parseInt(challengeId));

        logger.debug('🎯 Challenge found:', challenge ? {id: challenge.id, title: challenge.title} : 'NOT FOUND');

        if (!challenge) {
            logger.warning('❌ Challenge not found:', {challengeId, challengeTitle});
            return {
                success: false,
                error: `Challenge "${challengeTitle}" not found`,
            };
        }

        // Check if challenge is active and can be voted on
        const now = Math.floor(Date.now() / 1000);
        if (challenge.start_time >= now) {
            return {
                success: false,
                error: `Challenge "${challengeTitle}" has not started yet`,
            };
        }

        // Use the centralized voting logic service for manual voting decisions
        const {shouldAllowVoting, errorMessage, targetExposure} = votingLogic.evaluateManualVotingDecision(challenge, now, challengeTitle);

        if (!shouldAllowVoting) {
            return {
                success: false,
                error: errorMessage,
            };
        }

        // Vote on the specific challenge
        logger.info('🗳️ Starting voting process for challenge:', challenge.title);

        const voteImages = await strategy.getVoteImages(challenge, userSettings.token);
        logger.debug('📸 Vote images received:', voteImages ? {imageCount: voteImages.images?.length} : 'No vote images');

        if (voteImages && voteImages.images && voteImages.images.length > 0) {
            logger.info('✅ Submitting votes...');
            // Vote to target exposure (dynamic based on voting rules)
            await strategy.submitVotes(voteImages, userSettings.token, targetExposure);
            logger.success('✅ Votes submitted successfully');
        } else {
            logger.warning('⚠️ No vote images available');
        }

        return {
            success: true,
            message: `Successfully voted on challenge "${challengeTitle}"`,
        };
    } catch (error) {
        logger.error('Error handling vote-on-challenge request:', error);
        return {
            success: false,
            error: error.message || 'Failed to vote on challenge',
        };
    }
});

// Handle apply boost to entry request
ipcMain.handle('apply-boost-to-entry', async (event, challengeId, imageId) => {
    try {
        logger.info('🚀 Apply boost to entry request:', {challengeId, imageId});

        const userSettings = settings.loadSettings();

        if (!userSettings.token) {
            logger.warning('❌ No token found for boost');
            return {
                success: false,
                error: 'No authentication token found',
            };
        }

        // Use the API factory to get the appropriate strategy
        const {getApiStrategy} = require('./apiFactory');
        const strategy = getApiStrategy();

        // Apply boost to the specific entry
        logger.info('🚀 Applying boost to entry:', {challengeId, imageId});
        const result = await strategy.applyBoostToEntry(challengeId, imageId, userSettings.token);

        if (result) {
            logger.success('✅ Boost applied successfully');
            return {
                success: true,
                message: 'Boost applied successfully',
            };
        } else {
            logger.warning('❌ Failed to apply boost');
            return {
                success: false,
                error: 'Failed to apply boost',
            };
        }
    } catch (error) {
        logger.error('Error applying boost to entry:', error);
        return {
            success: false,
            error: error.message || 'Failed to apply boost',
        };
    }
});

// Handle reload window request (for CLI settings changes)
ipcMain.handle('reload-window', async () => {
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.reload();
            return {success: true};
        } else if (loginWindow && !loginWindow.isDestroyed()) {
            loginWindow.reload();
            return {success: true};
        } else {
            return {success: false, error: 'No active window to reload'};
        }
    } catch (error) {
        logger.error('Error reloading window:', error);
        return {success: false, error: error.message};
    }
});

// Update checker handlers
ipcMain.handle('check-for-updates', async () => {
    try {
        const UpdateChecker = require('./services/UpdateChecker');
        const updateChecker = new UpdateChecker();
        const updateInfo = await updateChecker.checkForUpdates(false); // Don't save timestamp for manual checks
        return {success: true, updateInfo};
    } catch (error) {
        logger.error('Error checking for updates:', error);
        return {success: false, error: error.message};
    }
});

ipcMain.handle('skip-update-version', async () => {
    try {
        const UpdateChecker = require('./services/UpdateChecker');
        const updateChecker = new UpdateChecker();
        
        // Get the latest version to skip
        const updateInfo = await updateChecker.forceCheckForUpdates();
        if (updateInfo) {
            updateChecker.skipVersion(updateInfo.latestVersion);
            return {success: true};
        }
        return {success: false, error: 'No update info available'};
    } catch (error) {
        logger.error('Error skipping update version:', error);
        return {success: false, error: error.message};
    }
});

ipcMain.handle('clear-skip-version', async () => {
    try {
        const UpdateChecker = require('./services/UpdateChecker');
        const updateChecker = new UpdateChecker();
        updateChecker.clearSkipVersion();
        return {success: true};
    } catch (error) {
        logger.error('Error clearing skip version:', error);
        return {success: false, error: error.message};
    }
});

// Handle refresh menu request
ipcMain.handle('refresh-menu', async () => {
    try {
        // Update global translation manager language from settings
        await global.translationManager.loadLanguageFromSettings();
        // Refresh menu with new translations
        updateMenuTranslations();
        return {success: true};
    } catch (error) {
        logger.error('Error refreshing menu:', error);
        return {success: false, error: error.message};
    }
});