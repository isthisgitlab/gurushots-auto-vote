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
const { registerHandlers } = require('./registerHandlers');
const AutoUpdater = require('../services/AutoUpdater');
const { getReleasesUrl } = require('../services/UpdateChecker');

const buildHandlers = (deps) => {
    const { getAutoUpdater, setAutoUpdater, getMainWindow } = deps;

    return {
        'check-for-updates': async () => {
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
        },

        'download-update': async () => {
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
                    fallbackUrl: getReleasesUrl(),
                };
            }
        },

        'install-update': async () => {
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
        },

        'skip-update-version': async () => {
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
        },

        'clear-skip-version': async () => {
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
        },

        'get-releases-url': () => {
            return { success: true, url: getReleasesUrl() };
        },

        'can-auto-update': () => {
            const autoUpdater = getAutoUpdater();
            if (autoUpdater) {
                return { success: true, canAutoUpdate: autoUpdater.canAutoUpdate() };
            }
            return { success: false, canAutoUpdate: false };
        },
    };
};

const register = (ipcMain, deps) => {
    registerHandlers(ipcMain, buildHandlers(deps));
};

module.exports = { register, buildHandlers };
