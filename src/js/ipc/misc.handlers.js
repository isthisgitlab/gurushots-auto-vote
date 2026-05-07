/**
 * Small one-off IPC handlers: open-external-url, reload-window,
 * refresh-menu. They don't share much beyond living in the same
 * "miscellaneous UI plumbing" bucket.
 */

const {shell} = require('electron');
const logger = require('../logger');
const {updateMenuTranslations} = require('../ui/applicationMenu');

const register = (ipcMain, deps) => {
    const {getMainWindow, getLoginWindow} = deps;

    ipcMain.handle('open-external-url', async (event, url) => {
        try {
            await shell.openExternal(url);
            return {success: true};
        } catch (error) {
            logger.withCategory('ui').error('Error opening external URL:', error);
            return {success: false, error: error.message};
        }
    });

    ipcMain.handle('reload-window', async () => {
        try {
            const mainWindow = getMainWindow();
            const loginWindow = getLoginWindow();
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.reload();
                return {success: true};
            }
            if (loginWindow && !loginWindow.isDestroyed()) {
                loginWindow.reload();
                return {success: true};
            }
            return {success: false, error: 'No active window to reload'};
        } catch (error) {
            logger.withCategory('ui').error('Error reloading window:', error);
            return {success: false, error: error.message};
        }
    });

    ipcMain.handle('refresh-menu', async () => {
        try {
            // Update global translation manager language from settings,
            // then refresh menu so any user-visible labels reflect it.
            await global.translationManager.loadLanguageFromSettings();
            updateMenuTranslations();
            return {success: true};
        } catch (error) {
            logger.withCategory('ui').error('Error refreshing menu:', error);
            return {success: false, error: error.message};
        }
    });
};

module.exports = {register};
