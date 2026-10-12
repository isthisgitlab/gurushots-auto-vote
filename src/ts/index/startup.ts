import { app, BrowserWindow, powerMonitor } from 'electron';
import * as settings from '../settings';
import { holdDesktopAppLock, isCliSessionActive, refreshDesktopAppLock } from '../settings/cliSessionLock';
import { initializeHeaders } from '../api/randomizer';
import * as logger from '../logger';
import { AutoUpdater } from '../services/AutoUpdater';
import { ensureExit } from '../windows/lifecycle';
import { bypassQuitGuard } from '../windows/quitGuard';
import { applyImminentBoostsOnSuspend } from '../windows/suspendBoost';
import { failureText } from '../format/logSafe';
import { createApplicationMenu } from '../ui/applicationMenu';
import { appState } from './state';
import { checkAutoLogin } from './windows';
import { installPermissionHandlers } from './permissions';

/**
 * A login a run left behind (a crash or a kill skips the quit-time clear) is cleared at the next start unless "Stay
 * Logged In" is on. Only the desktop app does this, and only in the instance that holds the single-instance lock
 * (onReady runs for no other): a CLI session that is running may be using the login, so it is left alone then.
 */
const clearLeftoverToken = async () => {
    try {
        const userSettings = settings.loadSettings();
        if (userSettings.stayLoggedIn || !userSettings.token) return;
        if (await isCliSessionActive()) {
            logger
                .withCategory('authentication')
                .info('Kept the saved token: a CLI session is running and may be using it', null);
            return;
        }
        if (settings.setSetting('token', '')) {
            logger
                .withCategory('authentication')
                .info('Cleared a saved token left by an earlier run (Stay Logged In is off)', null);
        }
    } catch (error) {
        logger.withCategory('authentication').error('Failed to clear a leftover token at startup:', error);
    }
};

/**
 * Marks this process as the running desktop app for as long as it runs, so a CLI `reset-data` waits for it instead of
 * pulling the files out from under it. A marker that cannot be written only costs that check.
 */
const holdAppMarker = () => {
    try {
        app.on('will-quit', holdDesktopAppLock());
    } catch (error) {
        logger
            .withCategory('ui')
            .warning('Could not mark the app as running (a CLI reset-data will not wait for it):', error);
    }
};

/** Setup that needs no window: permissions, headers, presets, the leftover login, the log cleanup and the menu. */
const prepareApp = async () => {
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

    await clearLeftoverToken();

    logger.cleanup();

    createApplicationMenu();
};

const registerPowerHandlers = () => {
    // Linux/macOS shutdown or reboot: never veto the OS with a dialog.
    powerMonitor.on('shutdown', bypassQuitGuard);

    // Waking: the app marker's timer did not count the sleep, so it is refreshed now rather than at its next beat.
    powerMonitor.on('resume', refreshDesktopAppLock);

    // Sleep: a boost due soon goes out now, while the network is still up
    // (best effort — see windows/suspendBoost.ts). Auto-vote state is read at event time.
    powerMonitor.on('suspend', () => {
        applyImminentBoostsOnSuspend().catch((error: unknown) => {
            logger.withCategory('boost').error(`Boost on sleep could not run: ${failureText(error)}`, null);
        });
    });
};

/** Opens the first window, running the startup update check before it (auto-login) or shortly after it (login window). */
const openFirstWindow = async () => {
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
};

const registerLifecycleHandlers = () => {
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
};

/**
 * Everything that runs once Electron has finished initialization.
 */
async function onReady() {
    holdAppMarker();
    await prepareApp();
    registerPowerHandlers();
    await openFirstWindow();
    registerLifecycleHandlers();
}

export { onReady };
