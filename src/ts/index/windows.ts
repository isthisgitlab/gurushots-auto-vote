import { BrowserWindow, dialog } from 'electron';
import { appPath } from '../appPaths';
import * as settings from '../settings';
import * as logger from '../logger';
import { watchSettingsFile } from '../windows/settingsWatcher';
import { syncBackgroundActivity } from '../windows/backgroundActivity';
import { holdQuitForOpenBoosts, bypassQuitGuard, resetQuitGuard } from '../windows/quitGuard';
import { translationManager } from '../translations/index';
import { appState } from './state';

import type { WebPreferences } from 'electron';

// Hold a quit or main-window close that would forfeit an open boost window
// and ask first; `proceed` re-issues it once confirmed. See windows/quitGuard.ts.
function holdForOpenBoosts(event: { preventDefault: () => void }, proceed: () => void) {
    return holdQuitForOpenBoosts(event, {
        autovoteRunning: settings.getSetting('autovoteRunning') === true,
        dialog,
        parent: appState.mainWindow,
        t: (key) => translationManager.t(key),
        proceed,
    });
}

/**
 * Creates a window with the shared web preferences and window-bounds
 * persistence. `extraWebPreferences` carries what only one window needs.
 */
function createAppWindow(kind: 'login' | 'main', htmlFile: string, extraWebPreferences: WebPreferences = {}) {
    const bounds = settings.getWindowBounds(kind);

    const win = new BrowserWindow({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        icon: appPath('src', 'assets', 'logo.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            // Bundled by scripts/build-react.ts — the sandboxed preload cannot
            // require() the relative channel manifest, so it ships pre-bundled.
            preload: appPath('dist', 'preload-bundle.js'),
            webSecurity: true,
            ...extraWebPreferences,
            // Use a custom session partition to isolate storage
            partition: 'persist:gurushots',
        },
    });

    win.loadFile(appPath('src', 'html', htmlFile)).catch((error) => {
        logger.withCategory('ui').error(`Failed to load ${kind} window content:`, error);
    });

    // Ensure window is visible on screen
    win.once('ready-to-show', () => {
        if (!win.isVisible()) {
            win.center();
        }
    });

    // Save window bounds when window is moved or resized
    win.on('resize', () => {
        settings.saveWindowBounds(kind, win.getBounds());
    });

    win.on('move', () => {
        settings.saveWindowBounds(kind, win.getBounds());
    });

    return win;
}

function createLoginWindow() {
    appState.loginWindow = createAppWindow('login', 'login.html');

    // Open DevTools in development mode (optional)
    // appState.loginWindow.webContents.openDevTools();

    appState.loginWindow.on('closed', () => {
        appState.loginWindow = null;
    });
}

function createMainWindow() {
    // Track when main window is created to prevent reload during login
    appState.mainWindowCreatedTime = Date.now();

    appState.mainWindow = createAppWindow('main', 'app.html', {
        // The auto-vote cadence chain is a recursive setTimeout living in
        // THIS renderer, and Chromium throttles then freezes timers on a
        // hidden page — which silently stalls the voting loop. Rationale,
        // measurements and the App Nap counterpart: see
        // docs/scheduling.md "Staying schedulable" and
        // windows/backgroundActivity.ts. Do not re-enable.
        backgroundThrottling: false,
    });

    // Set main window reference for AutoUpdater IPC events
    if (appState.autoUpdater) {
        appState.autoUpdater.setMainWindow(appState.mainWindow);
    }

    // Closing the main window stops the cadence chain on every platform (on
    // macOS without quitting), so it forfeits a pending boost just like a quit.
    const win = appState.mainWindow;
    win.on('close', (event) => {
        holdForOpenBoosts(event, () => {
            if (!win.isDestroyed()) win.close();
        });
    });
    // Windows log-off / shutdown: the OS is ending the session, not the user.
    win.on('query-session-end', bypassQuitGuard);

    appState.mainWindow.on('closed', () => {
        appState.mainWindow = null;
        resetQuitGuard();
        // Stop watching settings file when window closes
        if (appState.settingsWatcher) {
            appState.settingsWatcher.close();
            appState.settingsWatcher = null;
        }
        // No renderer, no cadence chain — release the assertion. A relaunch or
        // a re-created window re-adopts it from the persisted flag above.
        syncBackgroundActivity(false);
    });

    // Watch settings file for changes and auto-reload with debouncing.
    // The watcher lives in windows/settingsWatcher.ts; accessors keep it
    // reading the current window state this module owns.
    appState.settingsWatcher = watchSettingsFile({
        getMainWindow: () => appState.mainWindow,
        getMainWindowCreatedTime: () => appState.mainWindowCreatedTime,
        // The renderer persists `autovoteRunning` on every start/stop, so the
        // settings file IS the signal — no extra IPC channel is needed to keep
        // the power-save blocker in step with the running session.
        onSettingsChanged: (newSettings) => {
            // Liveness check, matching what the watcher's own reload and
            // broadcast paths do. Its debounce handle is module-level and
            // survives `close()`, so a callback armed by a routine write (a
            // window move alone triggers one) can land AFTER 'closed' already
            // released the blocker — re-arming an assertion for a session with
            // no window and no cadence chain, which nothing would then release.
            if (!appState.mainWindow || appState.mainWindow.isDestroyed()) return;
            syncBackgroundActivity(newSettings.autovoteRunning === true);
        },
    });

    // Adopt whatever the persisted flag already says: AutovoteContext
    // auto-resumes a session that was running when the app last closed, and
    // that resume does not re-write the flag (it is already true), so the
    // watcher above would never fire for it.
    //
    // This is also the ONLY sync if watchSettingsFile returned null (no
    // settings.json yet), so say so rather than leaving a silent pin — the
    // login flow writes settings before this window exists, which is why that
    // path is not expected in practice.
    syncBackgroundActivity(settings.getSetting('autovoteRunning') === true);
    if (!appState.settingsWatcher) {
        logger
            .withCategory('settings')
            .warning(
                'No settings watcher (settings file missing at window creation) — auto-vote power management will not follow later start/stop changes until the app is restarted',
            );
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

export { holdForOpenBoosts, createLoginWindow, createMainWindow, checkAutoLogin };
