const {app, BrowserWindow, ipcMain, session} = require('electron');
const path = require('path');
const fs = require('fs');
const settings = require('./settings');
const {initializeHeaders} = require('./api/randomizer');
const logger = require('./logger');
const AutoUpdater = require('./services/AutoUpdater');
const logIpc = require('./ipc/log.handlers');
const updateIpc = require('./ipc/update.handlers');
const miscIpc = require('./ipc/misc.handlers');
const settingsIpc = require('./ipc/settings.handlers');
const votingIpc = require('./ipc/voting.handlers');
const actionsIpc = require('./ipc/actions.handlers');
const {ensureExit} = require('./windows/lifecycle');
const { createApplicationMenu } = require('./ui/applicationMenu');
const { translationManager } = require('./translations/index');

// Initialize global translation manager for menu module access
global.translationManager = translationManager;

// Disable service workers at the application level
app.commandLine.appendSwitch('disable-features', 'ServiceWorker');

// ensureExit (force-exit safety net) lives in windows/lifecycle.js.

// Keep a global reference of the windows to prevent them from being garbage collected
let loginWindow = null;
let mainWindow = null;

// Settings file watcher
let settingsWatcher = null;
let settingsReloadTimeout = null;

// Global AutoUpdater instance
let autoUpdater = null;

// Track main window creation time to prevent reload during login
let mainWindowCreatedTime = null;

// Register IPC handlers extracted into focused modules. Each module
// receives the accessors it needs to read/write the still-shared
// module-level state (autoUpdater, mainWindow). Lifecycle of those
// objects stays in this file.
logIpc.register(ipcMain);
updateIpc.register(ipcMain, {
    getAutoUpdater: () => autoUpdater,
    setAutoUpdater: (v) => { autoUpdater = v; },
    getMainWindow: () => mainWindow,
});
miscIpc.register(ipcMain, {
    getMainWindow: () => mainWindow,
    getLoginWindow: () => loginWindow,
});
settingsIpc.register(ipcMain);
votingIpc.register(ipcMain);
actionsIpc.register(ipcMain);

/**
 * Compare two settings objects and return array of changes
 * @param {Object} oldSettings - Previous settings object
 * @param {Object} newSettings - New settings object
 * @returns {Array} Array of change objects with key, oldValue, newValue
 */
function compareSettings(oldSettings, newSettings) {
    const changes = [];
    
    // Function to safely stringify values for comparison and logging
    const stringify = (value) => {
        if (value === null || value === undefined) return 'null';
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
    };
    
    // Recursive function to compare nested objects
    const compareRecursive = (oldObj, newObj, path = '') => {
        // Handle null/undefined cases
        if (oldObj === null || oldObj === undefined || newObj === null || newObj === undefined) {
            if (oldObj !== newObj) {
                changes.push({
                    key: path,
                    oldValue: stringify(oldObj),
                    newValue: stringify(newObj),
                });
            }
            return;
        }
        
        // If both are objects, recurse into them
        if (typeof oldObj === 'object' && typeof newObj === 'object' && !Array.isArray(oldObj) && !Array.isArray(newObj)) {
            const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
            
            for (const key of allKeys) {
                const newPath = path ? `${path}.${key}` : key;
                const oldValue = oldObj[key];
                const newValue = newObj[key];
                
                compareRecursive(oldValue, newValue, newPath);
            }
        } else {
            // For primitive values or arrays, do direct comparison
            if (JSON.stringify(oldObj) !== JSON.stringify(newObj)) {
                changes.push({
                    key: path,
                    oldValue: stringify(oldObj),
                    newValue: stringify(newObj),
                });
            }
        }
    };
    
    // Start recursive comparison
    compareRecursive(oldSettings, newSettings);
    
    return changes;
}

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

    // Set main window reference for AutoUpdater IPC events
    if (autoUpdater) {
        autoUpdater.setMainWindow(mainWindow);
    }

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
    let previousSettings = null;
    
    // Store initial settings state
    if (fs.existsSync(settingsPath)) {
        try {
            previousSettings = settings.loadSettings();
        } catch (error) {
            logger.withCategory('settings').error('Failed to load initial settings for comparison:', error.message);
        }
        
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
                        logger.withCategory('settings').info('🔄 Settings file changed, but skipping reload (window recently created)');
                        return;
                    }
                    
                    // Load new settings and compare with previous
                    let newSettings;
                    let shouldReload = false;
                    try {
                        newSettings = settings.loadSettings();
                        
                        if (previousSettings) {
                            const changes = compareSettings(previousSettings, newSettings);
                            if (changes.length > 0) {
                                // Check if any of the changed settings require reload
                                const reloadRequiredChanges = changes.filter(change => {
                                    const settingKey = change.key.split('.')[0]; // Get main setting key
                                    return settings.isReloadRequired(settingKey);
                                });
                                
                                if (reloadRequiredChanges.length > 0) {
                                    logger.withCategory('settings').info('🔄 Reload-required settings changed, reloading main window...');
                                    reloadRequiredChanges.forEach(change => {
                                        logger.withCategory('settings').info(`  • ${change.key}: ${change.oldValue} → ${change.newValue} (reload required)`);
                                    });
                                    shouldReload = true;
                                } else {
                                    logger.withCategory('settings').info('🔄 Settings changed (no reload required):');
                                    changes.forEach(change => {
                                        logger.withCategory('settings').info(`  • ${change.key}: ${change.oldValue} → ${change.newValue}`);
                                    });
                                }
                            } else {
                                logger.withCategory('settings').info('🔄 Settings file changed (no property differences detected)');
                            }
                        } else {
                            logger.withCategory('settings').info('🔄 Settings file changed, reloading main window...');
                            shouldReload = true;
                        }
                        
                        // Update previous settings for next comparison
                        previousSettings = newSettings;
                    } catch (error) {
                        logger.withCategory('settings').error('Failed to load new settings for comparison:', error.message);
                        logger.withCategory('settings').info('🔄 Settings file changed, reloading main window...');
                        shouldReload = true;
                    }
                    
                    if (shouldReload && mainWindow && !mainWindow.isDestroyed()) {
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
    logger.withCategory('ui').info(`[App] UserData path: ${settings.getUserDataPath()}`, null);
    
    // Clear cache to prevent service worker database errors
    await session.defaultSession.clearCache();
    logger.withCategory('ui').info('[App] Browser cache cleared to prevent service worker database errors', null);
    
    // Initialize API headers on app startup
    initializeHeaders();

    // Run log cleanup on app startup
    logger.cleanup();

    // Create application menu
    createApplicationMenu();

    // Check if we should auto-login and run update check before creating main window
    const userSettings = settings.loadSettings();
    const shouldAutoLogin = userSettings.token && userSettings.stayLoggedIn;

    // Initialize global AutoUpdater instance
    autoUpdater = new AutoUpdater();

    // If auto-login is enabled, check for updates before creating the main window
    if (shouldAutoLogin) {
        // Check for updates immediately (no delay) to prevent double challenge loading
        try {
            await autoUpdater.checkForUpdates(false);
        } catch (error) {
            logger.withCategory('update').error('Error during update check:', error);
        }
    }

    await checkAutoLogin();

    // If not auto-login, check for updates after login window is shown
    if (!shouldAutoLogin) {
        // Check for updates after a short delay to not block app startup
        setTimeout(async () => {
            try {
                await autoUpdater.checkForUpdates(false);
            } catch (error) {
                logger.withCategory('update').error('Error during update check:', error);
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
        logger.withCategory('ui').info('Received SIGINT signal. Exiting...', null);
        app.quit();
        // Use the global force exit handler to ensure the process terminates
        ensureExit('SIGINT');
    });

    process.on('SIGTERM', () => {
        logger.withCategory('ui').info('Received SIGTERM signal. Exiting...', null);
        app.quit();
        // Use the global force exit handler to ensure the process terminates
        ensureExit('SIGTERM');
    });

    // Set up a global force exit handler to ensure the process always terminates
    process.on('exit', (code) => {
        logger.withCategory('ui').info(`Process exiting with code: ${code}`, null);
    });
});

// Clear token when app is about to quit if stay logged in is not enabled
app.on('before-quit', () => {
    const userSettings = settings.loadSettings();

    // If stay logged in is not enabled, clear the token
    if (!userSettings.stayLoggedIn && userSettings.token) {
        settings.setSetting('token', '');
    }

    logger.withCategory('ui').info('Application is about to quit. Forcing exit...', null);

    // Use the global force exit handler to ensure the process terminates
    ensureExit('before-quit');
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
        logger.withCategory('ui').info('All windows closed. Forcing exit...', null);

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

// Settings IPC handlers live in ipc/settings.handlers.js — that
// includes get-settings, get-setting, set-setting, save-settings,
// schema, boost thresholds, get-environment-info, refresh-api, the
// thin passthrough table, and cleanup-stale-metadata.

// gui-vote, run-voting-cycle, vote-all-challenges-manual, vote-on-challenge,
// vote-on-challenge-manual, should-cancel-voting, set-cancel-voting all
// live in ipc/voting.handlers.js.

// Logger handlers live in ipc/log.handlers.js.
// open-external-url, reload-window, refresh-menu live in ipc/misc.handlers.js.
// authenticate, get-active-challenges, play-auto-turbo, apply-turbo-to-entry,
// apply-boost-to-entry live in ipc/actions.handlers.js.






// AutoUpdater IPC handlers live in ipc/update.handlers.js.

// Log streaming + log file IPC handlers live in ipc/log.handlers.js.