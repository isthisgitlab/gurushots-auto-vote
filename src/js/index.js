const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const settings = require('./settings');
const { initializeHeaders } = require('./api/randomizer');
const logger = require('./logger');
const AutoUpdater = require('./services/AutoUpdater');
const { clearAuthToken } = require('./services/auth');
const logIpc = require('./ipc/log.handlers');
const updateIpc = require('./ipc/update.handlers');
const miscIpc = require('./ipc/misc.handlers');
const settingsIpc = require('./ipc/settings.handlers');
const votingIpc = require('./ipc/voting.handlers');
const actionsIpc = require('./ipc/actions.handlers');
const computationsIpc = require('./ipc/computations.handlers');
const { isTrustedSender } = require('./ipc/registerHandlers');
const { ensureExit, focusExistingWindow, clearTokenOnQuit } = require('./windows/lifecycle');
const { watchSettingsFile } = require('./windows/settingsWatcher');
const { createApplicationMenu } = require('./ui/applicationMenu');
const { translationManager } = require('./translations/index');

// Initialize global translation manager for menu module access
global.translationManager = translationManager;

// Disable service workers at the application level. Kept deliberately:
// with contextIsolation on, the preload.js register() patch only covers
// the isolated world — this switch is the only main-world-and-subframe-
// effective service worker block.
app.commandLine.appendSwitch('disable-features', 'ServiceWorker');

// Enforce a single running instance. A second launch would share the same
// userData dir and fight over Chromium's LevelDB locks (the source of the
// "Failed to delete the database: Database IO error" startup error).
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    logger.withCategory('ui').info('Another instance is already running — exiting this one.', null);
    app.quit();
}

// ensureExit (force-exit safety net) lives in windows/lifecycle.js.

// Keep a global reference of the windows to prevent them from being garbage collected
let loginWindow = null;
let mainWindow = null;

// Settings file watcher (created per main window by watchSettingsFile;
// the debounce timeout lives in windows/settingsWatcher.js)
let settingsWatcher = null;

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
    setAutoUpdater: (v) => {
        autoUpdater = v;
    },
    getMainWindow: () => mainWindow,
});
miscIpc.register(ipcMain, {
    getMainWindow: () => mainWindow,
    getLoginWindow: () => loginWindow,
});
settingsIpc.register(ipcMain);
votingIpc.register(ipcMain);
actionsIpc.register(ipcMain);
computationsIpc.register(ipcMain);

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
            // Bundled by scripts/build-react.js — the sandboxed preload cannot
            // require() the relative channel manifest, so it ships pre-bundled.
            preload: path.join(__dirname, '..', '..', 'dist', 'preload-bundle.js'),
            webSecurity: true,
            // Use a custom session partition to isolate storage
            partition: 'persist:gurushots',
        },
    });

    // Load the login HTML file
    loginWindow.loadFile(path.join(__dirname, '../html/login.html')).catch((error) => {
        logger.withCategory('ui').error('Failed to load login window content:', error);
    });

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
            // Bundled by scripts/build-react.js — the sandboxed preload cannot
            // require() the relative channel manifest, so it ships pre-bundled.
            preload: path.join(__dirname, '..', '..', 'dist', 'preload-bundle.js'),
            webSecurity: true,
            // Use a custom session partition to isolate storage
            partition: 'persist:gurushots',
        },
    });

    // Load the main application HTML file
    mainWindow.loadFile(path.join(__dirname, '../html/app.html')).catch((error) => {
        logger.withCategory('ui').error('Failed to load main window content:', error);
    });

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

    // Watch settings file for changes and auto-reload with debouncing.
    // Extracted to windows/settingsWatcher.js; accessors keep the watcher
    // reading the current window state this module still owns.
    settingsWatcher = watchSettingsFile({
        getMainWindow: () => mainWindow,
        getMainWindowCreatedTime: () => mainWindowCreatedTime,
    });
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

if (gotSingleInstanceLock) {
    // Registered synchronously, not inside whenReady: second-instance can
    // fire while the primary is still booting, and an event emitted before
    // a listener exists is lost, not queued.
    app.on('second-instance', () => {
        const windowToFocus = mainWindow ?? loginWindow;
        if (windowToFocus) {
            logger.withCategory('ui').info('Second instance launch blocked — focusing existing window.', null);
        } else {
            logger
                .withCategory('ui')
                .info('Second instance launch blocked — no window to focus yet (still starting up).', null);
        }
        if (process.platform === 'darwin') {
            // Cmd+H hides at the NSApplication level; win.show() alone can't undo it.
            app.show();
        }
        focusExistingWindow(windowToFocus);
    });

    // When Electron has finished initialization
    app.whenReady()
        .then(async () => {
            // Log userData path for verification
            logger.withCategory('ui').info(`[App] UserData path: ${settings.getUserDataPath()}`, null);

            // Initialize API headers on app startup
            initializeHeaders();

            // Seed the curated intent presets once (idempotent; never fatal).
            try {
                settings.seedIntentProfiles();
            } catch (err) {
                logger.withCategory('settings').warning('Intent profile seeding failed (non-fatal):', err);
            }

            // Run log cleanup on app startup
            logger.cleanup();

            // Create application menu
            createApplicationMenu();

            // Check if we should auto-login and run update check before creating main window
            const userSettings = settings.loadSettings();
            const shouldAutoLogin = userSettings.token && userSettings.stayLoggedIn;

            // Initialize global AutoUpdater instance. Deliberately constructed
            // WITHOUT a window — unlike the windowed constructions in
            // ipc/update.handlers.js and ui/applicationMenu.js — because the
            // startup check below runs before any window exists (pre-window so
            // an update prompt can't race the main window's challenge load and
            // double-load challenges).
            autoUpdater = new AutoUpdater();

            // Background update check shared by both startup paths — never
            // lets an update-check failure break app startup.
            const safeCheckForUpdates = async () => {
                try {
                    await autoUpdater.checkForUpdates(false);
                } catch (error) {
                    logger.withCategory('update').error('Error during update check:', error);
                }
            };

            // If auto-login is enabled, check for updates before creating the main window
            if (shouldAutoLogin) {
                // Check for updates immediately (no delay) to prevent double challenge loading
                await safeCheckForUpdates();
            }

            // Synchronous — the window exists before the handlers below are registered.
            checkAutoLogin();

            // If not auto-login, check for updates after login window is shown
            if (!shouldAutoLogin) {
                // Check for updates after a short delay to not block app startup
                setTimeout(() => {
                    void safeCheckForUpdates();
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
        })
        .catch((error) => {
            // The main process has no global unhandledRejection handler (unlike the
            // CLI), so a throw anywhere in the bootstrap above would otherwise vanish.
            logger.withCategory('ui').error('Startup failed:', error);
        });
}

// Clear token when app is about to quit if stay logged in is not enabled.
// Gated on the lock inside the helper — a losing second instance must not
// touch the shared settings.json and wipe the primary's session.
app.on('before-quit', () => {
    // A throw here must never skip ensureExit — the force-exit net below is
    // the guarantee that quit always terminates the process.
    try {
        clearTokenOnQuit(gotSingleInstanceLock, settings);
    } catch (error) {
        logger.withCategory('ui').error('Failed to clear token on quit:', error);
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

// Handle login success.
//
// registerHandlers applies isTrustedSender to every ipcMain.handle channel, but these two
// are registered with ipcMain.on (a send, with no reply) and so bypassed it entirely — this
// one swaps windows and the next clears the auth token. Nothing untrusted is loaded today,
// so the exposure is theoretical, but there is no reason for these to be the exceptions.
ipcMain.on('login-success', (event) => {
    if (!isTrustedSender(event)) {
        logger.withCategory('api').warning("Refused IPC 'login-success' from untrusted frame", null);
        return;
    }
    // Close login window
    if (loginWindow) {
        loginWindow.close();
    }
    // Create main application window
    createMainWindow();
});

// Handle logout. ipcMain.on expects a void listener, so the async flow runs
// in a caught IIFE — a failed token flush is logged, and the window teardown
// still proceeds so the user is never stuck on a dead main window.
ipcMain.on('logout', (event) => {
    if (!isTrustedSender(event)) {
        logger.withCategory('api').warning("Refused IPC 'logout' from untrusted frame", null);
        return;
    }
    if (!mainWindow) return;

    void (async () => {
        // Always clear the token on logout (regardless of stay logged in setting)
        await clearAuthToken();
    })()
        .catch((err) => {
            logger.withCategory('authentication').error('Logout failed to clear token', err);
        })
        .finally(() => {
            // Reset mock value to environment default while preserving theme and remember me settings
            const envInfo = settings.getEnvironmentInfo();
            settings.setSetting('mock', envInfo.defaultMock);

            // Re-check the window here, not just at entry. clearAuthToken awaits a settings
            // flush, and the user can close the main window during that await — dereferencing
            // a destroyed window inside .finally() threw an unhandled rejection in the main
            // process, which has no global handler. Nothing left to tear down in that case,
            // so just make sure they land back on a login window.
            if (!mainWindow || mainWindow.isDestroyed()) {
                if (loginWindow) {
                    loginWindow.focus();
                } else {
                    createLoginWindow();
                }
                return;
            }

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
