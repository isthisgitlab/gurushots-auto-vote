import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as logger from '../logger';
import * as metadata from '../metadata';
import * as settings from '../settings';
import { getReleasesUrl as releasesPageUrl } from './UpdateChecker';
import { hasBundledModel } from './visionVerifier';
import { bypassQuitGuard } from '../windows/quitGuard';

import type { BrowserWindow } from 'electron';
import type { UpdateInfo } from 'electron-updater';

/**
 * The update info shape sent to the renderer (and returned by the
 * check-for-updates IPC channel).
 */
/**
 * The update details every shell hands the renderer — Electron's AutoUpdater
 * and the Android bridge alike: what the update dialog reads.
 */
export type UpdateSummary = {
    currentVersion: string;
    latestVersion: string;
    releaseNotes: string;
    releaseDate: string | null;
    isPrerelease: boolean;
};

type FormattedUpdateInfo = {
    currentVersion: string;
    latestVersion: string;
    releaseNotes: string;
    releaseDate: string;
    isPrerelease: boolean;
    files: Array<{ url: string; size: number | undefined }>;
};

type DownloadProgress = { percent: number; bytesPerSecond: number; transferred: number; total: number };

/**
 * One-shot skip-version migration: the canonical store is the settings blob
 * (skipUpdateVersion — schema-validated, platform-aware, already what the
 * Capacitor bridge uses); older Electron/CLI builds wrote it into
 * metadata.json. Ordering is write-new -> verify-persisted -> clear-old so a
 * crash mid-migration can never lose the user's "skip this version" choice.
 * Settings wins on conflict (a value already in settings is kept and the
 * stale metadata copy just cleared). Idempotent: once the legacy field is
 * null this is a no-op.
 */
const migrateLegacySkipVersion = () => {
    try {
        const legacy = metadata.getLegacySkipVersion();
        if (!legacy) return;
        if (!settings.getSetting('skipUpdateVersion')) {
            settings.setSetting('skipUpdateVersion', legacy);
            if (settings.getSetting('skipUpdateVersion') !== legacy) {
                // Write did not stick (validation/persistence failure) —
                // keep the legacy copy so the preference is not lost.
                logger
                    .withCategory('update')
                    .warning('skip-version migration could not persist; keeping legacy value', null);
                return;
            }
        }
        metadata.clearLegacySkipVersion();
        logger.withCategory('update').info(`Migrated skip-version preference to settings: ${legacy}`, null);
    } catch (error) {
        logger.withCategory('update').error('skip-version migration failed:', error);
    }
};

/**
 * AutoUpdater service wrapping electron-updater with platform detection,
 * skip-version integration, and rate limiting
 */
class AutoUpdater {
    mainWindow: BrowserWindow | null;
    updateInfo: FormattedUpdateInfo | null;
    downloadProgress: DownloadProgress | null;
    isDownloading: boolean;
    isUpdateDownloaded: boolean;

    constructor(mainWindow: BrowserWindow | null = null) {
        this.mainWindow = mainWindow;
        this.updateInfo = null;
        this.downloadProgress = null;
        this.isDownloading = false;
        this.isUpdateDownloaded = false;

        // Land any metadata-resident skip preference in settings before the
        // first update-available event can read either store (no dialog
        // flash for an already-skipped version).
        migrateLegacySkipVersion();

        // Configure autoUpdater
        autoUpdater.autoDownload = false; // We control download manually
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.autoRunAppAfterInstall = true;

        // Set up event handlers
        this.setupEventHandlers();
    }

    /**
     * Set the main window reference (for sending IPC events)
     */
    setMainWindow(window: BrowserWindow | null) {
        this.mainWindow = window;
    }

    /**
     * Send event to renderer process
     */
    sendToRenderer(channel: string, data: unknown) {
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

            // Check if user has skipped this version (canonical store:
            // settings.skipUpdateVersion; '' means no skip)
            if (settings.getSetting('skipUpdateVersion') === info.version) {
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
     * @param info - Update info from electron-updater
     * @returns Formatted update info
     */
    formatUpdateInfo(info: UpdateInfo): FormattedUpdateInfo {
        return {
            currentVersion: app.getVersion(),
            latestVersion: info.version,
            releaseNotes: this.parseReleaseNotes(info.releaseNotes),
            releaseDate: info.releaseDate,
            isPrerelease: info.version.includes('-'),
            files:
                info.files?.map((f) => ({
                    url: f.url,
                    size: f.size,
                })) || [],
        };
    }

    /**
     * Parse release notes (can be string or array of objects)
     */
    parseReleaseNotes(releaseNotes: UpdateInfo['releaseNotes']): string {
        if (!releaseNotes) return 'No release notes available';
        if (typeof releaseNotes === 'string') return releaseNotes;
        if (Array.isArray(releaseNotes)) {
            return releaseNotes.map((note) => note.note || note).join('\n');
        }
        return 'No release notes available';
    }

    /**
     * Check if auto-update is supported on this platform/build
     */
    canAutoUpdate(): boolean {
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
            logger
                .withCategory('update')
                .info('macOS detected - auto-download may not work without code signing', null);
            // Still return true to attempt, but error handler will catch failures
            return true;
        }

        // Windows: Portable format may have limitations
        if (process.platform === 'win32') {
            // Portable can work but with limitations
            logger.withCategory('update').debug('Windows portable format detected', null);
            return true;
        }

        // Linux (AppImage) and anything else: attempt it.
        return true;
    }

    /**
     * Check for updates with rate limiting
     * @param force - Bypass rate limiting
     * @returns Update info or null
     */
    async checkForUpdates(force: boolean = false): Promise<FormattedUpdateInfo | null> {
        try {
            // Rate limiting: check once per 24 hours unless forced
            if (!force) {
                const updateCheckData = metadata.getUpdateCheckData();
                const lastCheck = updateCheckData.lastCheck;
                const now = Date.now();
                const oneDay = 24 * 60 * 60 * 1000;

                if (lastCheck && now - lastCheck < oneDay) {
                    logger.withCategory('update').info('Update check skipped - checked recently', null);
                    return null;
                }
            }

            logger.withCategory('update').info('Starting update check...', null);

            // Save check time
            metadata.setLastUpdateCheck(Date.now());

            // A lite build reads lite*.yml (the `channel` in its app-update.yml,
            // see scripts/electron-builder-lite.ts). On a prerelease the GitHub
            // provider swaps that channel for the prerelease one and then falls
            // back to latest*.yml, the full build, so lite stays on stable.
            if (!(await hasBundledModel())) autoUpdater.allowPrerelease = false;

            // Check for updates
            const result = await autoUpdater.checkForUpdates();

            if (result && result.updateInfo) {
                this.updateInfo = this.formatUpdateInfo(result.updateInfo);
                return this.updateInfo;
            }

            return null;
        } catch (error) {
            logger
                .withCategory('update')
                .error('Error checking for updates:', (error as { message?: string } | null)?.message);
            // Don't throw - return null to indicate no update found
            return null;
        }
    }

    /**
     * Download the available update
     * @returns True if download started
     */
    async downloadUpdate(): Promise<boolean> {
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
            logger.withCategory('update').error('Download failed:', (error as { message?: string } | null)?.message);
            throw error;
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
        // Choosing to install is the confirmation; don't ask again mid-install.
        bypassQuitGuard();
        autoUpdater.quitAndInstall(false, true);
    }

    /**
     * Skip the current version
     * @param version - Version to skip (optional, uses current update)
     */
    skipVersion(version: string | null = null) {
        const versionToSkip = version || this.updateInfo?.latestVersion;

        if (!versionToSkip) {
            logger.withCategory('update').error('No version to skip', null);
            return false;
        }

        settings.setSetting('skipUpdateVersion', versionToSkip);
        logger.withCategory('update').info('Marked version to skip:', versionToSkip);
        return true;
    }

    /**
     * Clear skip version setting
     */
    clearSkipVersion() {
        settings.setSetting('skipUpdateVersion', '');
        logger.withCategory('update').info('Cleared skip version setting', null);
    }

    /**
     * Get current update info
     */
    getUpdateInfo(): FormattedUpdateInfo | null {
        return this.updateInfo;
    }

    /**
     * Get download progress
     */
    getDownloadProgress(): DownloadProgress | null {
        return this.downloadProgress;
    }

    /**
     * Check if update is downloaded and ready
     */
    isReady(): boolean {
        return this.isUpdateDownloaded;
    }

    /**
     * Get GitHub releases URL for manual download fallback
     */
    getReleasesUrl(): string {
        return releasesPageUrl();
    }
}

export { AutoUpdater };
