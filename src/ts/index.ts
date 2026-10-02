import { app, ipcMain, shell } from 'electron';
import * as settings from './settings';
import * as logger from './logger';
import { clearAuthToken } from './services/auth';
import * as logIpc from './ipc/log.handlers';
import * as updateIpc from './ipc/update.handlers';
import * as miscIpc from './ipc/misc.handlers';
import * as settingsIpc from './ipc/settings.handlers';
import * as votingIpc from './ipc/voting.handlers';
import * as actionsIpc from './ipc/actions.handlers';
import * as computationsIpc from './ipc/computations.handlers';
import * as currencyIpc from './ipc/currency.handlers';
import * as scenariosIpc from './ipc/scenarios.handlers';
import { isTrustedSender } from './ipc/registerHandlers';
import { ensureExit, focusExistingWindow, clearTokenOnQuit } from './windows/lifecycle';
import { bypassQuitGuard } from './windows/quitGuard';
import { appState } from './index/state';
import { holdForOpenBoosts, createLoginWindow, createMainWindow } from './index/windows';
import { onReady } from './index/startup';
import { register as registerNavigationGuard } from './index/navigationGuard';

import type { AutoUpdater } from './services/AutoUpdater';

// Disable service workers at the application level. Kept deliberately:
// with contextIsolation on, the preload.ts register() patch only covers
// the isolated world — this switch is the only main-world-and-subframe-
// effective service worker block.
app.commandLine.appendSwitch('disable-features', 'ServiceWorker');

// Chromium encrypts the persist:gurushots cookie store with a key it keeps in
// the macOS Keychain, and re-prompts for it whenever the Electron binary
// changes. Nothing here relies on those cookies (the auth token lives in the
// settings store, API calls go through Node), so skip the real Keychain.
// No-op on other platforms.
app.commandLine.appendSwitch('use-mock-keychain');

// Applies to every web contents created from here on, so it is registered at
// module load, before any window exists.
registerNavigationGuard(app, shell);

// Enforce a single running instance. A second launch would share the same
// userData dir and fight over Chromium's LevelDB locks (the source of the
// "Failed to delete the database: Database IO error" startup error).
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    logger.withCategory('ui').info('Another instance is already running — exiting this one.', null);
    app.quit();
}

// ensureExit (force-exit safety net) lives in windows/lifecycle.ts.

// Register IPC handlers from their focused modules. Each module
// receives the accessors it needs to read/write the shared window and
// updater state (index/state.ts). The windows' lifecycle lives in
// index/windows.ts and the startup sequence in index/startup.ts.
logIpc.register(ipcMain);
updateIpc.register(ipcMain, {
    getAutoUpdater: () => appState.autoUpdater,
    setAutoUpdater: (v: AutoUpdater) => {
        appState.autoUpdater = v;
    },
    getMainWindow: () => appState.mainWindow,
});
miscIpc.register(ipcMain, {
    getMainWindow: () => appState.mainWindow,
    getLoginWindow: () => appState.loginWindow,
});
settingsIpc.register(ipcMain);
votingIpc.register(ipcMain);
actionsIpc.register(ipcMain);
computationsIpc.register(ipcMain);
currencyIpc.register(ipcMain);
scenariosIpc.register(ipcMain);

if (gotSingleInstanceLock) {
    // Registered synchronously, not inside whenReady: second-instance can
    // fire while the primary is still booting, and an event emitted before
    // a listener exists is lost, not queued.
    app.on('second-instance', () => {
        const windowToFocus = appState.mainWindow ?? appState.loginWindow;
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
        .then(onReady)
        .catch((error) => {
            // The main process has no global unhandledRejection handler (unlike the
            // CLI), so a throw anywhere in the bootstrap above would otherwise vanish.
            logger.withCategory('ui').error('Startup failed:', error);
        });
}

// Clear token when app is about to quit if stay logged in is not enabled.
// Gated on the lock inside the helper — a losing second instance must not
// touch the shared settings.json and wipe the primary's session.
app.on('before-quit', (event) => {
    // Lock first: a losing second instance must not read settings.json either.
    if (gotSingleInstanceLock && holdForOpenBoosts(event, () => app.quit())) return;

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
    if (appState.loginWindow) {
        appState.loginWindow.close();
    }
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
    if (!appState.mainWindow) return;

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
            if (!appState.mainWindow || appState.mainWindow.isDestroyed()) {
                if (appState.loginWindow) {
                    appState.loginWindow.focus();
                } else {
                    createLoginWindow();
                }
                return;
            }

            // Open the login window only after the main window is fully closed
            appState.mainWindow.once('closed', () => {
                // If a login window is already open, just focus it instead of creating a second one
                if (appState.loginWindow) {
                    appState.loginWindow.focus();
                } else {
                    createLoginWindow();
                }
            });

            // Close main window — logging out is its own confirmation.
            bypassQuitGuard();
            appState.mainWindow.close();
        });
});

// Settings IPC handlers live in ipc/settings.handlers.ts — that
// includes get-settings, get-setting, set-setting, save-settings,
// schema, boost thresholds, get-environment-info, refresh-api, the
// thin passthrough table, and cleanup-stale-metadata.

// gui-vote, run-voting-cycle, vote-all-challenges-manual, vote-on-challenge,
// vote-on-challenge-manual, should-cancel-voting, set-cancel-voting all
// live in ipc/voting.handlers.ts.

// Logger handlers live in ipc/log.handlers.ts.
// open-external-url, reload-window, refresh-menu live in ipc/misc.handlers.ts.
// authenticate, get-active-challenges, play-auto-turbo, apply-turbo-to-entry,
// apply-boost-to-entry live in ipc/actions.handlers.ts.

// AutoUpdater IPC handlers live in ipc/update.handlers.ts.

// Log streaming + log file IPC handlers live in ipc/log.handlers.ts.
