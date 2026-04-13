const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const logger = require('../logger');
const metadata = require('../metadata');

/**
 * AutoUpdater service wrapping electron-updater with platform detection,
 * skip-version integration, and rate limiting
 */
class AutoUpdater {
    constructor(mainWindow = null) {
        this.mainWindow = mainWindow;
        this.updateInfo = null;
        this.downloadProgress = null;
        this.isDownloading = false;
        this.isUpdateDownloaded = false;

        // Configure autoUpdater
        autoUpdater.autoDownload = false; // We control download manually
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.autoRunAppAfterInstall = true;

        // Set up event handlers
        this.setupEventHandlers();
    }

    /**
     * Set the main window reference (for sending IPC events)
     * @param {BrowserWindow} window
     */
    setMainWindow(window) {
        this.mainWindow = window;
    }

    /**
     * Send event to renderer process
     * @param {string} channel
     * @param {*} data
     */
    sendToRenderer(channel, data) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send(channel, data);
        }
    }

    /**
     * Set up autoUpdater event handlers
     */
    setupEventHandlers() {
        autoUpdater.on('checking-for-update', () => {
            logger.withCategory('update').info('Checking for updates...', null);
            this.sendToRenderer('update-checking', null);
        });

        autoUpdater.on('update-available', (info) => {
            logger.withCategory('update').info('Update available:', info.version);
            this.updateInfo = this.formatUpdateInfo(info);

            // Check if user has skipped this version
            const updateCheckData = metadata.getUpdateCheckData();
            if (updateCheckData.skipVersion === info.version) {
                logger.withCategory('update').info('Update skipped by user:', info.version);
                return;
            }

            this.sendToRenderer('update-available', this.updateInfo);
        });

        autoUpdater.on('update-not-available', (info) => {
            logger.withCategory('update').info('No update available. Current version is latest:', info.version);
            this.sendToRenderer('update-not-available', { version: info.version });
        });

        autoUpdater.on('error', (err) => {
            logger.withCategory('update').error('Update error:', err.message);
            this.isDownloading = false;
            this.sendToRenderer('update-error', {
                message: err.message,
                canFallbackToBrowser: true,
            });
        });

        autoUpdater.on('download-progress', (progressObj) => {
            this.downloadProgress = {
                percent: Math.round(progressObj.percent),
                bytesPerSecond: progressObj.bytesPerSecond,
                transferred: progressObj.transferred,
                total: progressObj.total,
            };

            logger.withCategory('update').debug(`Download progress: ${this.downloadProgress.percent}%`, null);
            this.sendToRenderer('update-download-progress', this.downloadProgress);
        });

        autoUpdater.on('update-downloaded', (info) => {
            logger.withCategory('update').info('Update downloaded:', info.version);
            this.isDownloading = false;
            this.isUpdateDownloaded = true;
            this.sendToRenderer('update-downloaded', this.formatUpdateInfo(info));
        });
    }

    /**
     * Format update info for renderer
     * @param {Object} info - Update info from electron-updater
     * @returns {Object} - Formatted update info
     */
    formatUpdateInfo(info) {
        return {
            currentVersion: app.getVersion(),
            latestVersion: info.version,
            releaseNotes: this.parseReleaseNotes(info.releaseNotes),
            releaseDate: info.releaseDate,
            isPrerelease: info.version.includes('-'),
            files: info.files?.map(f => ({
                url: f.url,
                size: f.size,
            })) || [],
        };
    }

    /**
     * Parse release notes (can be string or array of objects)
     * @param {string|Array} releaseNotes
     * @returns {string}
     */
    parseReleaseNotes(releaseNotes) {
        if (!releaseNotes) return 'No release notes available';
        if (typeof releaseNotes === 'string') return releaseNotes;
        if (Array.isArray(releaseNotes)) {
            return releaseNotes.map(note => note.note || note).join('\n');
        }
        return 'No release notes available';
    }

    /**
     * Check if auto-update is supported on this platform/build
     * @returns {boolean}
     */
    canAutoUpdate() {
        // Not packaged = development mode, can't auto-update
        if (!app.isPackaged) {
            logger.withCategory('update').debug('Auto-update not available in development mode', null);
            return false;
        }

        // macOS: Without code signing, auto-update won't work
        if (process.platform === 'darwin') {
            // electron-updater will fail on unsigned macOS apps
            // We detect this by checking if the app is signed
            // For now, assume unsigned and fall back to browser
            logger.withCategory('update').info('macOS detected - auto-download may not work without code signing', null);
            // Still return true to attempt, but error handler will catch failures
            return true;
        }

        // Windows: Portable format may have limitations
        if (process.platform === 'win32') {
            // Portable can work but with limitations
            logger.withCategory('update').debug('Windows portable format detected', null);
            return true;
        }

        // Linux: AppImage should work
        if (process.platform === 'linux') {
            return true;
        }

        return true;
    }

    /**
     * Check for updates with rate limiting
     * @param {boolean} force - Bypass rate limiting
     * @returns {Promise<Object|null>} - Update info or null
     */
    async checkForUpdates(force = false) {
        try {
            // Rate limiting: check once per 24 hours unless forced
            if (!force) {
                const updateCheckData = metadata.getUpdateCheckData();
                const lastCheck = updateCheckData.lastCheck;
                const now = Date.now();
                const oneDay = 24 * 60 * 60 * 1000;

                if (lastCheck && (now - lastCheck) < oneDay) {
                    logger.withCategory('update').info('Update check skipped - checked recently', null);
                    return null;
                }
            }

            logger.withCategory('update').info('Starting update check...', null);

            // Save check time
            metadata.setLastUpdateCheck(Date.now());

            // Check for updates
            const result = await autoUpdater.checkForUpdates();

            if (result && result.updateInfo) {
                this.updateInfo = this.formatUpdateInfo(result.updateInfo);
                return this.updateInfo;
            }

            return null;
        } catch (error) {
            logger.withCategory('update').error('Error checking for updates:', error.message);
            // Don't throw - return null to indicate no update found
            return null;
        }
    }

    /**
     * Download the available update
     * @returns {Promise<boolean>} - True if download started
     */
    async downloadUpdate() {
        if (!this.updateInfo) {
            logger.withCategory('update').error('No update available to download', null);
            return false;
        }

        if (this.isDownloading) {
            logger.withCategory('update').warning('Download already in progress', null);
            return false;
        }

        if (!this.canAutoUpdate()) {
            logger.withCategory('update').warning('Auto-update not supported - use browser download', null);
            return false;
        }

        try {
            this.isDownloading = true;
            logger.withCategory('update').info('Starting download...', null);
            await autoUpdater.downloadUpdate();
            return true;
        } catch (error) {
            this.isDownloading = false;
            logger.withCategory('update').error('Download failed:', error.message);
            throw error;
        }
    }

    /**
     * Cancel ongoing download
     */
    cancelDownload() {
        if (this.isDownloading) {
            // electron-updater doesn't have a cancel method
            // but we can prevent install
            this.isDownloading = false;
            logger.withCategory('update').info('Download cancelled', null);
        }
    }

    /**
     * Install downloaded update and restart
     */
    quitAndInstall() {
        if (!this.isUpdateDownloaded) {
            logger.withCategory('update').error('No update downloaded to install', null);
            return;
        }

        logger.withCategory('update').info('Quitting and installing update...', null);
        autoUpdater.quitAndInstall(false, true);
    }

    /**
     * Skip the current version
     * @param {string} version - Version to skip (optional, uses current update)
     */
    skipVersion(version = null) {
        const versionToSkip = version || this.updateInfo?.latestVersion;

        if (!versionToSkip) {
            logger.withCategory('update').error('No version to skip', null);
            return false;
        }

        metadata.setSkipUpdateVersion(versionToSkip);
        logger.withCategory('update').info('Marked version to skip:', versionToSkip);
        return true;
    }

    /**
     * Clear skip version setting
     */
    clearSkipVersion() {
        metadata.clearSkipUpdateVersion();
        logger.withCategory('update').info('Cleared skip version setting', null);
    }

    /**
     * Get current update info
     * @returns {Object|null}
     */
    getUpdateInfo() {
        return this.updateInfo;
    }

    /**
     * Get download progress
     * @returns {Object|null}
     */
    getDownloadProgress() {
        return this.downloadProgress;
    }

    /**
     * Check if update is downloaded and ready
     * @returns {boolean}
     */
    isReady() {
        return this.isUpdateDownloaded;
    }

    /**
     * Get GitHub releases URL for manual download fallback
     * @returns {string}
     */
    getReleasesUrl() {
        return 'https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest';
    }
}

module.exports = AutoUpdater;
