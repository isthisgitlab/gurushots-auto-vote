import { app, BrowserWindow, powerMonitor } from 'electron';
import * as settings from '../settings';
import { initializeHeaders } from '../api/randomizer';
import * as logger from '../logger';
import { AutoUpdater } from '../services/AutoUpdater';
import { ensureExit } from '../windows/lifecycle';
import { bypassQuitGuard } from '../windows/quitGuard';
import { createApplicationMenu } from '../ui/applicationMenu';
import { appState } from './state';
import { checkAutoLogin } from './windows';
import { installPermissionHandlers } from './permissions';

/**
 * Everything that runs once Electron has finished initialization.
 */
async function onReady() {
    logger.withCategory('ui').info(`[App] UserData path: ${settings.getUserDataPath()}`, null);

    // Before any window exists: a page must never see Electron's grant-by-default.
    installPermissionHandlers();

    initializeHeaders();

    // Seed the curated intent presets once (idempotent; never fatal).
    try {
        settings.seedIntentProfiles();
    } catch (err) {
        logger.withCategory('settings').warning('Intent profile seeding failed (non-fatal):', err);
    }

    logger.cleanup();

    createApplicationMenu();

    // Linux/macOS shutdown or reboot: never veto the OS with a dialog.
    powerMonitor.on('shutdown', bypassQuitGuard);

    // Check if we should auto-login and run update check before creating main window
    const userSettings = settings.loadSettings();
    const shouldAutoLogin = userSettings.token && userSettings.stayLoggedIn;

    // Initialize global AutoUpdater instance. Deliberately constructed
    // WITHOUT a window — unlike the windowed constructions in
    // ipc/update.handlers.ts and ui/applicationMenu.ts — because the
    // startup check below runs before any window exists (pre-window so
    // an update prompt can't race the main window's challenge load and
    // double-load challenges).
    appState.autoUpdater = new AutoUpdater();

    // Background update check shared by both startup paths — never
    // lets an update-check failure break app startup.
    const safeCheckForUpdates = async () => {
        try {
            // Set just above; update.handlers may replace it, never with null.
            await (appState.autoUpdater as AutoUpdater).checkForUpdates(false);
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
        bypassQuitGuard();
        app.quit();
        // Use the global force exit handler to ensure the process terminates
        ensureExit('SIGINT');
    });

    process.on('SIGTERM', () => {
        logger.withCategory('ui').info('Received SIGTERM signal. Exiting...', null);
        bypassQuitGuard();
        app.quit();
        // Use the global force exit handler to ensure the process terminates
        ensureExit('SIGTERM');
    });

    // Set up a global force exit handler to ensure the process always terminates
    process.on('exit', (code) => {
        logger.withCategory('ui').info(`Process exiting with code: ${code}`, null);
    });
}

export { onReady };
