const {app, BrowserWindow, ipcMain, session} = require('electron');
const path = require('path');
const fs = require('fs');
const settings = require('./settings');
const {initializeHeaders} = require('./api/randomizer');

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

    console.log(`Ensuring exit after ${reason}...`);

    // Set a timeout to force exit after a delay
    forceExitTimeout = setTimeout(() => {
        console.log(`Force exiting after ${reason}...`);
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
            // Disable service workers to prevent database IO errors
            webSecurity: false,
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
            // Disable service workers to prevent database IO errors
            webSecurity: false,
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
                        console.log('🔄 Settings file changed, but skipping reload (window recently created)');
                        return;
                    }
                    
                    console.log('🔄 Settings file changed, reloading main window...');
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
    console.log(`[App] UserData path: ${settings.getUserDataPath()}`);
    
    // Clear cache to prevent service worker database errors
    await session.defaultSession.clearCache();
    console.log('[App] Browser cache cleared to prevent service worker database errors');
    
    // Initialize API headers on app startup
    initializeHeaders();

    // Run log cleanup on app startup
    const logger = require('./logger');
    logger.cleanup();

    // Check for updates in the background (only if not checked recently)
    const UpdateChecker = require('./services/UpdateChecker');
    const updateChecker = new UpdateChecker();
    
    // Check for updates after a short delay to not block app startup
    setTimeout(async () => {
        try {
            // Only check if not checked recently, and save timestamp
            await updateChecker.checkForUpdates(true);
            // Don't show dialog automatically - user can check manually in settings
        } catch (error) {
            console.error('Error during update check:', error);
        }
    }, 3000); // 3 second delay

    await checkAutoLogin();

    // On macOS, re-create a window when dock icon is clicked and no windows are open
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            checkAutoLogin();
        }
    });

    // Handle SIGINT and SIGTERM signals to ensure clean exit
    process.on('SIGINT', () => {
        console.log('Received SIGINT signal. Exiting...');
        app.quit();
        // Use the global force exit handler to ensure the process terminates
        ensureExit('SIGINT');
    });

    process.on('SIGTERM', () => {
        console.log('Received SIGTERM signal. Exiting...');
        app.quit();
        // Use the global force exit handler to ensure the process terminates
        ensureExit('SIGTERM');
    });

    // Set up a global force exit handler to ensure the process always terminates
    process.on('exit', (code) => {
        console.log(`Process exiting with code: ${code}`);
    });
});

// Clear token when app is about to quit if stay logged in is not enabled
app.on('before-quit', () => {
    const userSettings = settings.loadSettings();

    // If stay logged in is not enabled, clear the token
    if (!userSettings.stayLoggedIn && userSettings.token) {
        settings.setSetting('token', '');
    }

    console.log('Application is about to quit. Forcing exit...');

    // Use the global force exit handler to ensure the process terminates
    ensureExit('before-quit');
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
        console.log('All windows closed. Forcing exit...');

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
        console.error('Error handling get-settings request:', error);
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
        console.error(`Error handling get-setting request for key "${key}":`, error);
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
        console.error(`Error handling set-setting request for key "${key}":`, error);
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
        console.error('Error handling save-settings request:', error);
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
        console.error('Error handling gui-vote request:', error);
        return {
            success: false,
            error: error.message || 'Failed to load challenges',
        };
    }
});

// Handle get-active-challenges request
ipcMain.handle('get-active-challenges', async (event, token) => {
    try {
        console.log('=== IPC get-active-challenges ===');
        console.log('Token received:', !!token);

        // Use the API factory to get the appropriate strategy
        const {getApiStrategy} = require('./apiFactory');
        const strategy = getApiStrategy();

        // Call the getActiveChallenges function
        const result = await strategy.getActiveChallenges(token);
        return result;
    } catch (error) {
        console.error('Error handling get-active-challenges request:', error);
        throw error;
    }
});

// Handle get-environment-info request
ipcMain.handle('get-environment-info', async () => {
    try {
        return settings.getEnvironmentInfo();
    } catch (error) {
        console.error('Error handling get-environment-info request:', error);
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
        console.log('🔄 Refreshing API due to settings change');
        const apiFactory = require('./apiFactory');
        apiFactory.refreshApi();
        return {success: true};
    } catch (error) {
        console.error('Error handling refresh-api request:', error);
        return {success: false, error: error.message};
    }
});

// Logger handlers
const logger = require('./logger');

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
        console.error('Error getting boost threshold:', error);
        return settings.SETTINGS_SCHEMA.boostTime.default;
    }
});

ipcMain.handle('set-boost-threshold', async (event, challengeId, threshold) => {
    try {
        settings.setChallengeOverride('boostTime', challengeId.toString(), threshold);
        return {success: true};
    } catch (error) {
        console.error('Error setting boost threshold:', error);
        return {success: false, error: error.message};
    }
});

ipcMain.handle('set-default-boost-threshold', async (event, threshold) => {
    try {
        settings.setGlobalDefault('boostTime', threshold);
        return {success: true};
    } catch (error) {
        console.error('Error setting default boost threshold:', error);
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
        console.error('Error getting settings schema:', error);
        return {};
    }
});

ipcMain.handle('get-global-default', async (event, settingKey) => {
    try {
        const settings = require('./settings');
        return settings.getGlobalDefault(settingKey);
    } catch (error) {
        console.error('Error getting global default:', error);
        return null;
    }
});

ipcMain.handle('set-global-default', async (event, settingKey, value) => {
    try {
        const settings = require('./settings');
        return settings.setGlobalDefault(settingKey, value);
    } catch (error) {
        console.error('Error setting global default:', error);
        return false;
    }
});

ipcMain.handle('get-challenge-override', async (event, settingKey, challengeId) => {
    try {
        const settings = require('./settings');
        return settings.getChallengeOverride(settingKey, challengeId);
    } catch (error) {
        console.error('Error getting challenge override:', error);
        return null;
    }
});

ipcMain.handle('set-challenge-override', async (event, settingKey, challengeId, value) => {
    try {
        const settings = require('./settings');
        return settings.setChallengeOverride(settingKey, challengeId, value);
    } catch (error) {
        console.error('Error setting challenge override:', error);
        return false;
    }
});

ipcMain.handle('set-challenge-overrides', async (event, challengeId, overrides) => {
    try {
        const settings = require('./settings');
        return settings.setChallengeOverrides(challengeId, overrides);
    } catch (error) {
        console.error('Error setting challenge overrides:', error);
        return false;
    }
});

ipcMain.handle('remove-challenge-override', async (event, settingKey, challengeId) => {
    try {
        const settings = require('./settings');
        return settings.removeChallengeOverride(settingKey, challengeId);
    } catch (error) {
        console.error('Error removing challenge override:', error);
        return false;
    }
});

ipcMain.handle('get-effective-setting', async (event, settingKey, challengeId) => {
    try {
        const settings = require('./settings');
        return settings.getEffectiveSetting(settingKey, challengeId);
    } catch (error) {
        console.error('Error getting effective setting:', error);
        return null;
    }
});

ipcMain.handle('cleanup-stale-challenge-setting', async (event, activeChallengeIds) => {
    try {
        const settings = require('./settings');
        return settings.cleanupStaleChallengeSetting(activeChallengeIds);
    } catch (error) {
        console.error('Error cleaning up stale challenge settings:', error);
        return false;
    }
});

ipcMain.handle('cleanup-obsolete-settings', async () => {
    try {
        const settings = require('./settings');
        return settings.cleanupObsoleteSettings();
    } catch (error) {
        console.error('Error cleaning up obsolete settings:', error);
        return false;
    }
});

// Reset settings handlers
ipcMain.handle('reset-setting', async (event, key) => {
    try {
        const settings = require('./settings');
        return settings.resetSetting(key);
    } catch (error) {
        console.error('Error resetting setting:', error);
        return false;
    }
});

ipcMain.handle('reset-global-default', async (event, settingKey) => {
    try {
        const settings = require('./settings');
        return settings.resetGlobalDefault(settingKey);
    } catch (error) {
        console.error('Error resetting global default:', error);
        return false;
    }
});

ipcMain.handle('reset-all-global-defaults', async () => {
    try {
        const settings = require('./settings');
        return settings.resetAllGlobalDefaults();
    } catch (error) {
        console.error('Error resetting all global defaults:', error);
        return false;
    }
});

ipcMain.handle('reset-all-settings', async () => {
    try {
        const settings = require('./settings');
        return settings.resetAllSettings();
    } catch (error) {
        console.error('Error resetting all settings:', error);
        return false;
    }
});

ipcMain.handle('is-setting-modified', async (event, key) => {
    try {
        const settings = require('./settings');
        return settings.isSettingModified(key);
    } catch (error) {
        console.error('Error checking if setting is modified:', error);
        return false;
    }
});

ipcMain.handle('is-global-default-modified', async (event, settingKey) => {
    try {
        const settings = require('./settings');
        return settings.isGlobalDefaultModified(settingKey);
    } catch (error) {
        console.error('Error checking if global default is modified:', error);
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
        console.error('Error opening external URL:', error);
        return {success: false, error: error.message};
    }
});

// Handle authenticate request for login
ipcMain.handle('authenticate', async (event, username, password, isMock) => {
    try {
        if (isMock) {
            // Use mock authentication
            const {mockLoginSuccess, mockLoginFailure} = require('./mock/auth');

            // Simulate network delay for realistic behavior
            await new Promise(resolve => setTimeout(resolve, 500));


            const isValidCredential = true;

            if (isValidCredential) {
                return {
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
            } else {
                return {
                    success: false,
                    message: mockLoginFailure.message || 'Invalid mock credentials',
                };
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
            if (response.success === true && response.token) {
                return {
                    success: true,
                    token: response.token,
                    message: 'Production login successful',
                    user: {
                        id: response.member_id,
                        email: username,
                        username: response.user_name,
                        display_name: response.user_name,
                    },
                };
            } else {
                return {
                    success: false,
                    message: 'Authentication failed - invalid response from server',
                };
            }
        }
    } catch (error) {
        console.error('Error handling authenticate request:', error);
        return {
            success: false,
            message: error.message || 'Authentication failed due to network error',
        };
    }
});

// Handle run-voting-cycle request
ipcMain.handle('run-voting-cycle', async () => {
    try {
        console.log('🔄 Starting voting cycle...');

        const userSettings = settings.loadSettings();

        if (!userSettings.token) {
            console.log('❌ No token found for voting cycle');
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
                console.warn(`Error getting exposure setting for challenge ${challengeId}:`, error);
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
        console.error('Error handling run-voting-cycle request:', error);
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
        console.log('🔄 Vote on challenge request:', {challengeId, challengeTitle});

        const userSettings = settings.loadSettings();

        if (!userSettings.token) {
            console.log('❌ No token found for voting');
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
            console.log('❌ Failed to fetch challenges for voting');
            return {
                success: false,
                error: 'Failed to fetch challenges',
            };
        }

        console.log('📋 Found challenges:', challengesResponse.challenges.map(c => ({id: c.id, title: c.title})));
        console.log('🔍 Looking for challenge ID:', challengeId, 'Type:', typeof challengeId);

        // Find the specific challenge (convert challengeId to number for comparison)
        const challenge = challengesResponse.challenges.find(c => c.id === parseInt(challengeId));

        console.log('🎯 Challenge found:', challenge ? {id: challenge.id, title: challenge.title} : 'NOT FOUND');

        if (!challenge) {
            console.log('❌ Challenge not found:', {challengeId, challengeTitle});
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

        // Get the effective exposure threshold and lastminute threshold for this challenge
        const effectiveThreshold = settings.getEffectiveSetting('exposure', challengeId);
        const effectiveLastMinutes = settings.getEffectiveSetting('lastMinutes', challengeId);
        const timeUntilEnd = challenge.close_time - now;
        const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinutes * 60) && timeUntilEnd > 0;

        // Get the vote-only-in-last-threshold setting for this challenge
        const voteOnlyInLastThreshold = settings.getEffectiveSetting('voteOnlyInLastThreshold', challengeId);

        // Check if we should allow voting based on lastminute threshold logic
        let shouldAllowVoting = false;
        let errorMessage = '';

        if (challenge.type === 'flash') {
            // Flash type: ignore exposure threshold, boost only and vote when below 100
            if (challenge.member.ranking.exposure.exposure_factor >= 100) {
                errorMessage = `Challenge "${challengeTitle}" already has 100% exposure (flash type)`;
            } else {
                shouldAllowVoting = true;
            }
        } else if (voteOnlyInLastThreshold && !isWithinLastMinuteThreshold) {
            // Skip voting if vote-only-in-last-threshold is enabled and we're not within the last threshold
            errorMessage = `Challenge "${challengeTitle}" voting is restricted to last ${effectiveLastMinutes} minutes only`;
        } else if (isWithinLastMinuteThreshold) {
            // Within lastminute threshold: ignore exposure threshold, auto-vote if exposure < 100
            if (challenge.member.ranking.exposure.exposure_factor >= 100) {
                errorMessage = `Challenge "${challengeTitle}" already has 100% exposure (lastminute threshold: ${effectiveLastMinutes}m)`;
            } else {
                shouldAllowVoting = true;
            }
        } else {
            // Normal logic: check against exposure threshold
            if (challenge.member.ranking.exposure.exposure_factor >= effectiveThreshold) {
                errorMessage = `Challenge "${challengeTitle}" already has ${effectiveThreshold}% exposure`;
            } else {
                shouldAllowVoting = true;
            }
        }

        if (!shouldAllowVoting) {
            return {
                success: false,
                error: errorMessage,
            };
        }

        // Vote on the specific challenge
        console.log('🗳️ Starting voting process for challenge:', challenge.title);

        const voteImages = await strategy.getVoteImages(challenge, userSettings.token);
        console.log('📸 Vote images received:', voteImages ? {imageCount: voteImages.images?.length} : 'No vote images');

        if (voteImages && voteImages.images && voteImages.images.length > 0) {
            console.log('✅ Submitting votes...');
            // Always vote to 100% (always vote to 100, not just to threshold)
            const submissionThreshold = 100;
            await strategy.submitVotes(voteImages, userSettings.token, submissionThreshold);
            console.log('✅ Votes submitted successfully');
        } else {
            console.log('⚠️ No vote images available');
        }

        return {
            success: true,
            message: `Successfully voted on challenge "${challengeTitle}"`,
        };
    } catch (error) {
        console.error('Error handling vote-on-challenge request:', error);
        return {
            success: false,
            error: error.message || 'Failed to vote on challenge',
        };
    }
});

// Handle apply boost to entry request
ipcMain.handle('apply-boost-to-entry', async (event, challengeId, imageId) => {
    try {
        console.log('🚀 Apply boost to entry request:', {challengeId, imageId});

        const userSettings = settings.loadSettings();

        if (!userSettings.token) {
            console.log('❌ No token found for boost');
            return {
                success: false,
                error: 'No authentication token found',
            };
        }

        // Use the API factory to get the appropriate strategy
        const {getApiStrategy} = require('./apiFactory');
        const strategy = getApiStrategy();

        // Apply boost to the specific entry
        console.log('🚀 Applying boost to entry:', {challengeId, imageId});
        const result = await strategy.applyBoostToEntry(challengeId, imageId, userSettings.token);

        if (result) {
            console.log('✅ Boost applied successfully');
            return {
                success: true,
                message: 'Boost applied successfully',
            };
        } else {
            console.log('❌ Failed to apply boost');
            return {
                success: false,
                error: 'Failed to apply boost',
            };
        }
    } catch (error) {
        console.error('Error applying boost to entry:', error);
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
        console.error('Error reloading window:', error);
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
        console.error('Error checking for updates:', error);
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
        console.error('Error skipping update version:', error);
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
        console.error('Error clearing skip version:', error);
        return {success: false, error: error.message};
    }
});