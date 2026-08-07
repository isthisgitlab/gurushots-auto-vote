/**
 * Process-exit safety net and window/quit lifecycle helpers. Electron
 * sometimes lingers after the last window closes — this gives the main
 * process a deterministic timeout-based exit path so a hung handle
 * doesn't keep the app alive.
 */

const logger = require('../logger');

// Long enough for Chromium to flush LevelDB storage (a 1s window could
// kill it mid-write and leave stale locks), short enough to stay a firm
// ceiling on "the app must die now".
const FORCE_EXIT_GRACE_MS = 3000;

let forceExitTimeout = null;

const ensureExit = (reason) => {
    // Clear any existing timeout to prevent multiple force exits.
    if (forceExitTimeout) {
        clearTimeout(forceExitTimeout);
    }

    logger.withCategory('ui').info(`Ensuring exit after ${reason}...`, null);

    forceExitTimeout = setTimeout(() => {
        logger.withCategory('ui').info(`Force exiting after ${reason}...`, null);
        try {
            // app.exit() tears down Electron's child processes (renderer,
            // GPU, storage service) in order; lazy require so this module
            // loads outside Electron (Jest) and the net still fires there.
            require('electron').app.exit(0);
        } catch {
            process.exit(0);
        }
    }, FORCE_EXIT_GRACE_MS);
    // The pending timer must not itself keep an otherwise-clean shutdown alive.
    forceExitTimeout.unref?.();
};

const focusExistingWindow = (win) => {
    // isDestroyed() must be checked first — any other method on a
    // destroyed BrowserWindow throws.
    if (!win || win.isDestroyed()) {
        return;
    }
    // Independent ifs: a window can be minimized and hidden at once.
    if (win.isMinimized()) {
        win.restore();
    }
    if (!win.isVisible()) {
        win.show();
    }
    win.focus();
};

// Quit-time token cleanup, gated on holding the single-instance lock: a
// losing second instance shares settings.json with the running primary
// and must not even read it, or it could wipe the primary's session.
const clearTokenOnQuit = (hasLock, settingsFacade) => {
    if (!hasLock) {
        return;
    }
    const userSettings = settingsFacade.loadSettings();
    if (!userSettings.stayLoggedIn && userSettings.token) {
        settingsFacade.setSetting('token', '');
    }
};

module.exports = { ensureExit, focusExistingWindow, clearTokenOnQuit, FORCE_EXIT_GRACE_MS };
