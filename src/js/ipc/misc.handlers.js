/**
 * Small one-off IPC handlers: open-external-url, reload-window,
 * refresh-menu. They don't share much beyond living in the same
 * "miscellaneous UI plumbing" bucket.
 */

const { shell } = require('electron');
const { registerHandlers } = require('./registerHandlers');
const { errorResult } = require('./errorResult');
const logger = require('../logger');
const { updateMenuTranslations } = require('../ui/applicationMenu');
const { isSafeExternalUrl } = require('../format/urlSafe');

const buildHandlers = (deps) => {
    const { getMainWindow, getLoginWindow } = deps;

    return {
        'open-external-url': async (event, url) => {
            try {
                // Scheme allow-list (shared with the Capacitor bridge via
                // format/urlSafe): every legitimate call site opens an https
                // page (gurushots.com, GitHub releases). Refusing anything else
                // keeps this from ever becoming an open-any-scheme primitive
                // (file:, shell handlers, ...).
                if (!isSafeExternalUrl(url)) {
                    logger.withCategory('api').warning(`Refused open-external-url for non-https URL: ${url}`, null);
                    return { success: false, error: 'Only https:// URLs can be opened' };
                }
                await shell.openExternal(url);
                return { success: true };
            } catch (error) {
                logger.withCategory('ui').error('Error opening external URL:', error);
                return errorResult(error, 'Failed to open external URL');
            }
        },

        'reload-window': async () => {
            try {
                const mainWindow = getMainWindow();
                const loginWindow = getLoginWindow();
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.reload();
                    return { success: true };
                }
                if (loginWindow && !loginWindow.isDestroyed()) {
                    loginWindow.reload();
                    return { success: true };
                }
                return { success: false, error: 'No active window to reload' };
            } catch (error) {
                logger.withCategory('ui').error('Error reloading window:', error);
                return errorResult(error, 'Failed to reload window');
            }
        },

        'refresh-menu': async () => {
            try {
                // Update global translation manager language from settings,
                // then refresh menu so any user-visible labels reflect it.
                await global.translationManager.loadLanguageFromSettings();
                updateMenuTranslations();
                return { success: true };
            } catch (error) {
                logger.withCategory('ui').error('Error refreshing menu:', error);
                return errorResult(error, 'Failed to refresh menu');
            }
        },
    };
};

const register = (ipcMain, deps) => {
    registerHandlers(ipcMain, buildHandlers(deps));
};

module.exports = { register, buildHandlers };
