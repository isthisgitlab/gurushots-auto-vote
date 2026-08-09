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

    // Lazily construct the shared instance on first use (windowed — unlike
    // index.js's deliberate pre-window startup construction) and register it
    // back through the accessor so index.js keeps lifecycle ownership.
    const ensureUpdater = () => {
        let autoUpdater = getAutoUpdater();
        if (!autoUpdater) {
            autoUpdater = new AutoUpdater(getMainWindow());
            setAutoUpdater(autoUpdater);
        }
        return autoUpdater;
    };

    // Guard for handlers that must NOT lazily construct: yields either the
    // existing instance or the standard "not initialized" failure result.
    const requireUpdater = () => {
        const autoUpdater = getAutoUpdater();
        return {
            autoUpdater,
            failure: autoUpdater ? null : { success: false, error: 'AutoUpdater not initialized' },
        };
    };

    return {
        'check-for-updates': async () => {
            try {
                const updateInfo = await ensureUpdater().checkForUpdates(true);
                return { success: true, updateInfo };
            } catch (error) {
                logger.withCategory('update').error('Error checking for updates:', error);
                return { success: false, error: error.message };
            }
        },

        'download-update': async () => {
            const { autoUpdater, failure } = requireUpdater();
            try {
                if (failure) {
                    return failure;
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
                const { autoUpdater, failure } = requireUpdater();
                if (failure) {
                    return failure;
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
                const { autoUpdater, failure } = requireUpdater();
                if (failure) {
                    return failure;
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
                ensureUpdater().clearSkipVersion();
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
