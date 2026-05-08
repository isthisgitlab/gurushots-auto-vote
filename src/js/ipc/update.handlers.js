/**
 * IPC handlers for the auto-updater. The AutoUpdater instance and the
 * main BrowserWindow reference still live in index.js; we receive
 * accessors so we can read/write them without owning the lifecycle.
 *
 * Lifecycle ownership stays in index.js because the AutoUpdater is
 * created lazily on the first manual `check-for-updates`, and the
 * main window's setup path needs to wire the same instance via
 * `autoUpdater.setMainWindow`.
 */

const logger = require('../logger');
const AutoUpdater = require('../services/AutoUpdater');

const RELEASES_FALLBACK_URL = 'https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest';

const register = (ipcMain, deps) => {
    const { getAutoUpdater, setAutoUpdater, getMainWindow } = deps;

    ipcMain.handle('check-for-updates', async () => {
        try {
            let autoUpdater = getAutoUpdater();
            if (!autoUpdater) {
                autoUpdater = new AutoUpdater(getMainWindow());
                setAutoUpdater(autoUpdater);
            }
            const updateInfo = await autoUpdater.checkForUpdates(true);
            return { success: true, updateInfo };
        } catch (error) {
            logger.withCategory('update').error('Error checking for updates:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('download-update', async () => {
        const autoUpdater = getAutoUpdater();
        try {
            if (!autoUpdater) {
                return { success: false, error: 'AutoUpdater not initialized' };
            }
            await autoUpdater.downloadUpdate();
            return { success: true };
        } catch (error) {
            logger.withCategory('update').error('Error downloading update:', error);
            return {
                success: false,
                error: error.message,
                fallbackUrl: autoUpdater ? autoUpdater.getReleasesUrl() : RELEASES_FALLBACK_URL,
            };
        }
    });

    ipcMain.handle('install-update', async () => {
        try {
            const autoUpdater = getAutoUpdater();
            if (!autoUpdater) {
                return { success: false, error: 'AutoUpdater not initialized' };
            }
            autoUpdater.quitAndInstall();
            return { success: true };
        } catch (error) {
            logger.withCategory('update').error('Error installing update:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('skip-update-version', async () => {
        try {
            const autoUpdater = getAutoUpdater();
            if (!autoUpdater) {
                return { success: false, error: 'AutoUpdater not initialized' };
            }
            const updateInfo = autoUpdater.getUpdateInfo();
            if (updateInfo) {
                autoUpdater.skipVersion(updateInfo.latestVersion);
                return { success: true };
            }
            return { success: false, error: 'No update info available' };
        } catch (error) {
            logger.withCategory('update').error('Error skipping update version:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('clear-skip-version', async () => {
        try {
            let autoUpdater = getAutoUpdater();
            if (!autoUpdater) {
                autoUpdater = new AutoUpdater(getMainWindow());
                setAutoUpdater(autoUpdater);
            }
            autoUpdater.clearSkipVersion();
            return { success: true };
        } catch (error) {
            logger.withCategory('update').error('Error clearing skip version:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-releases-url', () => {
        const autoUpdater = getAutoUpdater();
        if (autoUpdater) {
            return { success: true, url: autoUpdater.getReleasesUrl() };
        }
        return { success: true, url: RELEASES_FALLBACK_URL };
    });

    ipcMain.handle('can-auto-update', () => {
        const autoUpdater = getAutoUpdater();
        if (autoUpdater) {
            return { success: true, canAutoUpdate: autoUpdater.canAutoUpdate() };
        }
        return { success: false, canAutoUpdate: false };
    });
};

module.exports = { register };
