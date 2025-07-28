const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const settings = require('./settings');
const { initializeHeaders } = require('./api/randomizer');

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
    });
}

// Check if we should auto-login based on saved token
async function checkAutoLogin() {
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
    // Initialize API headers on app startup
    initializeHeaders();
    
    // Run log cleanup on app startup
    const logger = require('./logger');
    logger.cleanup();
    
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
  
    // Force process to exit completely to prevent nodemon from waiting for changes
    console.log('Application is about to quit. Forcing exit...');
  
    // Use the global force exit handler to ensure the process terminates
    ensureExit('before-quit');
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
        // Force process to exit completely to prevent nodemon from waiting for changes
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
  
    const userSettings = settings.loadSettings();
  
    // Clear the token only if stay logged in is not enabled
    if (!userSettings.stayLoggedIn) {
        settings.setSetting('token', '');
    }
  
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
        console.log('Token received:', token ? `${token.substring(0, 10)}...` : 'none');
        console.log('Full token:', token || 'NO TOKEN');
    
        // Use the API factory to get the appropriate strategy
        const { getApiStrategy } = require('./apiFactory');
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
        return { success: true };
    } catch (error) {
        console.error('Error handling refresh-api request:', error);
        return { success: false, error: error.message };
    }
});

// Logger handlers
const logger = require('./logger');

ipcMain.handle('log-debug', async (event, message, data) => {
    logger.debug(message, data);
    return { success: true };
});

ipcMain.handle('log-error', async (event, message, data) => {
    logger.error(message, data);
    return { success: true };
});

ipcMain.handle('log-api', async (event, message, data) => {
    logger.api(message, data);
    return { success: true };
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
        const settings = require('./settings');
        return settings.getBoostThreshold(challengeId);
    } catch (error) {
        console.error('Error getting boost threshold:', error);
        return 3600; // Default 1 hour
    }
});

ipcMain.handle('set-boost-threshold', async (event, challengeId, threshold) => {
    try {
        const settings = require('./settings');
        settings.setBoostThreshold(challengeId, threshold);
        return { success: true };
    } catch (error) {
        console.error('Error setting boost threshold:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('set-default-boost-threshold', async (event, threshold) => {
    try {
        const settings = require('./settings');
        settings.setDefaultBoostThreshold(threshold);
        return { success: true };
    } catch (error) {
        console.error('Error setting default boost threshold:', error);
        return { success: false, error: error.message };
    }
});

// Handle open external URL request
ipcMain.handle('open-external-url', async (event, url) => {
    try {
        const { shell } = require('electron');
        await shell.openExternal(url);
        return { success: true };
    } catch (error) {
        console.error('Error opening external URL:', error);
        return { success: false, error: error.message };
    }
});

// Handle authenticate request for login
ipcMain.handle('authenticate', async (event, username, password, isMock) => {
    try {
        if (isMock) {
            // Use mock authentication
            const { mockLoginSuccess, mockLoginFailure } = require('./mock/auth');
      
            // Simulate network delay for realistic behavior
            await new Promise(resolve => setTimeout(resolve, 500));
      
            // For mock login, accept any credentials
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
            const { authenticate } = require('./api/login');
      
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
        const userSettings = settings.loadSettings();
    
        if (!userSettings.token) {
            return {
                success: false,
                error: 'No authentication token found',
            };
        }
    
        // Use the API factory to get the appropriate strategy
        const { getApiStrategy } = require('./apiFactory');
        const strategy = getApiStrategy();
        
        // Reset cancellation flag before starting
        shouldCancelVoting = false;
        
        // Set the cancellation flag in the API module
        const mainApi = require('./api/main');
        mainApi.setCancellationFlag(false);
        
        // Also set the cancellation flag in the mock API
        const mockApi = require('./mock');
        mockApi.setCancellationFlag(false);
        
        // Run the voting cycle
        const result = await strategy.fetchChallengesAndVote(userSettings.token);
    
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
        console.log('🔄 Vote on challenge request:', { challengeId, challengeTitle });
    
        const userSettings = settings.loadSettings();
    
        if (!userSettings.token) {
            console.log('❌ No token found for voting');
            return {
                success: false,
                error: 'No authentication token found',
            };
        }
    
        // Use the API factory to get the appropriate strategy
        const { getApiStrategy } = require('./apiFactory');
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
    
        console.log('📋 Found challenges:', challengesResponse.challenges.map(c => ({ id: c.id, title: c.title })));
        console.log('🔍 Looking for challenge ID:', challengeId, 'Type:', typeof challengeId);
    
        // Find the specific challenge (convert challengeId to number for comparison)
        const challenge = challengesResponse.challenges.find(c => c.id === parseInt(challengeId));
    
        console.log('🎯 Challenge found:', challenge ? { id: challenge.id, title: challenge.title } : 'NOT FOUND');
    
        if (!challenge) {
            console.log('❌ Challenge not found:', { challengeId, challengeTitle });
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
    
        if (challenge.member.ranking.exposure.exposure_factor >= 100) {
            return {
                success: false,
                error: `Challenge "${challengeTitle}" already has 100% exposure`,
            };
        }
    
        // Vote on the specific challenge
        console.log('🗳️ Starting voting process for challenge:', challenge.title);
    
        const voteImages = await strategy.getVoteImages(challenge, userSettings.token);
        console.log('📸 Vote images received:', voteImages ? { imageCount: voteImages.images?.length } : 'No vote images');
    
        if (voteImages && voteImages.images && voteImages.images.length > 0) {
            console.log('✅ Submitting votes...');
            await strategy.submitVotes(voteImages, userSettings.token);
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
        console.log('🚀 Apply boost to entry request:', { challengeId, imageId });
    
        const userSettings = settings.loadSettings();
    
        if (!userSettings.token) {
            console.log('❌ No token found for boost');
            return {
                success: false,
                error: 'No authentication token found',
            };
        }
    
        // Use the API factory to get the appropriate strategy
        const { getApiStrategy } = require('./apiFactory');
        const strategy = getApiStrategy();
    
        // Apply boost to the specific entry
        console.log('🚀 Applying boost to entry:', { challengeId, imageId });
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