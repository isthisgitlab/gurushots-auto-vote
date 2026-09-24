// Mock electron modules
jest.mock('electron', () => ({
    app: {
        getVersion: jest.fn(() => '0.6.1'),
        isPackaged: false,
    },
}));

// Mock electron-updater
const mockAutoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    autoRunAppAfterInstall: false,
    on: jest.fn(),
    checkForUpdates: jest.fn(),
    downloadUpdate: jest.fn(),
    quitAndInstall: jest.fn(),
};

jest.mock('electron-updater', () => ({
    autoUpdater: mockAutoUpdater,
}));

// Mock logger
jest.mock('../../src/js/logger', () => ({
    withCategory: jest.fn(() => ({
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    })),
}));

// Mock metadata
const mockMetadata = {
    getUpdateCheckData: jest.fn(() => ({ lastCheck: null, skipVersion: null })),
    setLastUpdateCheck: jest.fn(),
    getLegacySkipVersion: jest.fn(() => null),
    clearLegacySkipVersion: jest.fn(() => true),
};

jest.mock('../../src/js/metadata', () => mockMetadata);

// Mock settings — the canonical skip-version store. A tiny in-memory map so
// the write->verify->clear migration ordering is observable.
const settingsState = { skipUpdateVersion: '' };
const mockSettings = {
    getSetting: jest.fn((key) => settingsState[key]),
    setSetting: jest.fn((key, value) => {
        settingsState[key] = value;
        return true;
    }),
};

jest.mock('../../src/js/settings', () => mockSettings);

const mockQuitGuard = { bypassQuitGuard: jest.fn() };
jest.mock('../../src/js/windows/quitGuard', () => mockQuitGuard);

describe('AutoUpdater', () => {
    let AutoUpdater;
    let autoUpdater;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.resetModules();

        // Reset mock implementations
        mockMetadata.getUpdateCheckData.mockReturnValue({ lastCheck: null, skipVersion: null });
        mockMetadata.getLegacySkipVersion.mockReturnValue(null);
        mockMetadata.clearLegacySkipVersion.mockReturnValue(true);
        settingsState.skipUpdateVersion = '';
        mockSettings.getSetting.mockImplementation((key) => settingsState[key]);
        mockSettings.setSetting.mockImplementation((key, value) => {
            settingsState[key] = value;
            return true;
        });
        mockAutoUpdater.checkForUpdates.mockResolvedValue({
            updateInfo: {
                version: '0.7.0',
                releaseNotes: 'New features',
                releaseDate: '2024-01-01',
                files: [],
            },
        });

        // Re-require AutoUpdater after mocks are set up
        AutoUpdater = require('../../src/js/services/AutoUpdater');
        autoUpdater = new AutoUpdater();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('constructor', () => {
        it('should configure autoUpdater with correct settings', () => {
            expect(mockAutoUpdater.autoDownload).toBe(false);
            expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(true);
            expect(mockAutoUpdater.autoRunAppAfterInstall).toBe(true);
        });

        it('should set up event handlers', () => {
            expect(mockAutoUpdater.on).toHaveBeenCalledWith('checking-for-update', expect.any(Function));
            expect(mockAutoUpdater.on).toHaveBeenCalledWith('update-available', expect.any(Function));
            expect(mockAutoUpdater.on).toHaveBeenCalledWith('update-not-available', expect.any(Function));
            expect(mockAutoUpdater.on).toHaveBeenCalledWith('error', expect.any(Function));
            expect(mockAutoUpdater.on).toHaveBeenCalledWith('download-progress', expect.any(Function));
            expect(mockAutoUpdater.on).toHaveBeenCalledWith('update-downloaded', expect.any(Function));
        });
    });

    describe('checkForUpdates', () => {
        it('should check for updates when no recent check exists', async () => {
            const result = await autoUpdater.checkForUpdates();

            expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled();
            expect(result).toBeDefined();
            expect(result.latestVersion).toBe('0.7.0');
        });

        it('should skip check if checked within 24 hours', async () => {
            const recentCheck = Date.now() - 12 * 60 * 60 * 1000; // 12 hours ago
            mockMetadata.getUpdateCheckData.mockReturnValue({
                lastCheck: recentCheck,
                skipVersion: null,
            });

            const result = await autoUpdater.checkForUpdates(false);

            expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
            expect(result).toBeNull();
        });

        it('should force check when force=true', async () => {
            const recentCheck = Date.now() - 12 * 60 * 60 * 1000; // 12 hours ago
            mockMetadata.getUpdateCheckData.mockReturnValue({
                lastCheck: recentCheck,
                skipVersion: null,
            });

            const result = await autoUpdater.checkForUpdates(true);

            expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled();
            expect(result).toBeDefined();
        });

        it('should save last check time after successful check', async () => {
            await autoUpdater.checkForUpdates();

            expect(mockMetadata.setLastUpdateCheck).toHaveBeenCalled();
            const timestamp = mockMetadata.setLastUpdateCheck.mock.calls[0][0];
            expect(typeof timestamp).toBe('number');
            expect(timestamp).toBeGreaterThan(0);
        });

        it('should return null on error', async () => {
            mockAutoUpdater.checkForUpdates.mockRejectedValue(new Error('Network error'));

            const result = await autoUpdater.checkForUpdates();

            expect(result).toBeNull();
        });
    });

    describe('downloadUpdate', () => {
        it('should return false if no update info available', async () => {
            autoUpdater.updateInfo = null;

            const result = await autoUpdater.downloadUpdate();

            expect(result).toBe(false);
            expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
        });

        it('should return false if already downloading', async () => {
            autoUpdater.updateInfo = { latestVersion: '0.7.0' };
            autoUpdater.isDownloading = true;

            const result = await autoUpdater.downloadUpdate();

            expect(result).toBe(false);
        });

        it('should start download when update is available', async () => {
            autoUpdater.updateInfo = { latestVersion: '0.7.0' };
            autoUpdater.isDownloading = false;
            mockAutoUpdater.downloadUpdate.mockResolvedValue();

            // Mock canAutoUpdate to return true
            const originalCanAutoUpdate = autoUpdater.canAutoUpdate;
            autoUpdater.canAutoUpdate = () => true;

            const result = await autoUpdater.downloadUpdate();

            expect(result).toBe(true);
            expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalled();

            // Restore original method
            autoUpdater.canAutoUpdate = originalCanAutoUpdate;
        });
    });

    describe('quitAndInstall', () => {
        it('should not install if update not downloaded', () => {
            autoUpdater.isUpdateDownloaded = false;

            autoUpdater.quitAndInstall();

            expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
            expect(mockQuitGuard.bypassQuitGuard).not.toHaveBeenCalled();
        });

        it('should install if update is downloaded', () => {
            autoUpdater.isUpdateDownloaded = true;

            autoUpdater.quitAndInstall();

            expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
            // Choosing to install is the confirmation — the boost prompt must not block it.
            expect(mockQuitGuard.bypassQuitGuard.mock.invocationCallOrder[0]).toBeLessThan(
                mockAutoUpdater.quitAndInstall.mock.invocationCallOrder[0],
            );
        });
    });

    describe('skipVersion', () => {
        it('should skip specified version (canonical store: settings)', () => {
            autoUpdater.skipVersion('0.7.0');

            expect(mockSettings.setSetting).toHaveBeenCalledWith('skipUpdateVersion', '0.7.0');
        });

        it('should skip current update version if none specified', () => {
            autoUpdater.updateInfo = { latestVersion: '0.8.0' };

            autoUpdater.skipVersion();

            expect(mockSettings.setSetting).toHaveBeenCalledWith('skipUpdateVersion', '0.8.0');
        });

        it('should return false if no version to skip', () => {
            autoUpdater.updateInfo = null;

            const result = autoUpdater.skipVersion();

            expect(result).toBe(false);
            expect(mockSettings.setSetting).not.toHaveBeenCalled();
        });
    });

    describe('clearSkipVersion', () => {
        it('should clear skip version via the settings sentinel', () => {
            autoUpdater.clearSkipVersion();

            expect(mockSettings.setSetting).toHaveBeenCalledWith('skipUpdateVersion', '');
        });
    });

    describe('legacy skip-version migration (constructor one-shot)', () => {
        // On Android the AutoUpdater is never constructed (the Capacitor
        // bridge writes settings.skipUpdateVersion directly) and no
        // metadata.json ever existed, so the migration is structurally a
        // no-op there; these cases cover the Electron/CLI paths.

        it('moves a metadata-resident value into settings and clears the legacy copy', () => {
            mockMetadata.getLegacySkipVersion.mockReturnValue('1.2.3');

            new AutoUpdater();

            expect(settingsState.skipUpdateVersion).toBe('1.2.3');
            expect(mockMetadata.clearLegacySkipVersion).toHaveBeenCalled();
        });

        it('settings wins on conflict: existing settings value is kept, legacy copy cleared', () => {
            settingsState.skipUpdateVersion = '2.0.0';
            mockMetadata.getLegacySkipVersion.mockReturnValue('1.2.3');

            new AutoUpdater();

            expect(settingsState.skipUpdateVersion).toBe('2.0.0');
            expect(mockSettings.setSetting).not.toHaveBeenCalledWith('skipUpdateVersion', '1.2.3');
            expect(mockMetadata.clearLegacySkipVersion).toHaveBeenCalled();
        });

        it('is idempotent: once the legacy field is null, nothing is touched', () => {
            settingsState.skipUpdateVersion = '3.0.0'; // user set later
            mockMetadata.getLegacySkipVersion.mockReturnValue(null);

            new AutoUpdater();

            expect(settingsState.skipUpdateVersion).toBe('3.0.0');
            expect(mockSettings.setSetting).not.toHaveBeenCalled();
            expect(mockMetadata.clearLegacySkipVersion).not.toHaveBeenCalled();
        });

        it('keeps the legacy copy when the settings write does not persist (write-new-verify-clear-old)', () => {
            mockMetadata.getLegacySkipVersion.mockReturnValue('1.2.3');
            mockSettings.setSetting.mockImplementation(() => false); // write rejected, state unchanged

            new AutoUpdater();

            expect(mockMetadata.clearLegacySkipVersion).not.toHaveBeenCalled();
        });
    });

    describe('canAutoUpdate', () => {
        it('should return false when not packaged (development mode)', () => {
            const { app } = require('electron');
            app.isPackaged = false;

            const result = autoUpdater.canAutoUpdate();

            expect(result).toBe(false);
        });
    });

    describe('formatUpdateInfo', () => {
        it('should format update info correctly', () => {
            const rawInfo = {
                version: '1.0.0',
                releaseNotes: 'Test notes',
                releaseDate: '2024-01-01',
                files: [{ url: 'http://test.com/file.zip', size: 1024 }],
            };

            const formatted = autoUpdater.formatUpdateInfo(rawInfo);

            expect(formatted.currentVersion).toBe('0.6.1');
            expect(formatted.latestVersion).toBe('1.0.0');
            expect(formatted.releaseNotes).toBe('Test notes');
            expect(formatted.isPrerelease).toBe(false);
        });

        it('should detect prerelease versions', () => {
            const rawInfo = {
                version: '1.0.0-beta.1',
                releaseNotes: 'Beta release',
                releaseDate: '2024-01-01',
            };

            const formatted = autoUpdater.formatUpdateInfo(rawInfo);

            expect(formatted.isPrerelease).toBe(true);
        });
    });

    describe('parseReleaseNotes', () => {
        it('should return string release notes as-is', () => {
            const result = autoUpdater.parseReleaseNotes('Simple release notes');

            expect(result).toBe('Simple release notes');
        });

        it('should join array release notes', () => {
            const notes = [{ note: 'Feature 1' }, { note: 'Feature 2' }];

            const result = autoUpdater.parseReleaseNotes(notes);

            expect(result).toBe('Feature 1\nFeature 2');
        });

        it('should return default message for undefined notes', () => {
            const result = autoUpdater.parseReleaseNotes(undefined);

            expect(result).toBe('No release notes available');
        });
    });

    describe('getReleasesUrl', () => {
        it('should return correct GitHub releases URL', () => {
            const url = autoUpdater.getReleasesUrl();

            expect(url).toBe('https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest');
        });
    });

    describe('getters', () => {
        it('getUpdateInfo should return current update info', () => {
            autoUpdater.updateInfo = { latestVersion: '0.7.0' };

            expect(autoUpdater.getUpdateInfo()).toEqual({ latestVersion: '0.7.0' });
        });

        it('getDownloadProgress should return current progress', () => {
            autoUpdater.downloadProgress = { percent: 50 };

            expect(autoUpdater.getDownloadProgress()).toEqual({ percent: 50 });
        });

        it('isReady should return download status', () => {
            autoUpdater.isUpdateDownloaded = true;

            expect(autoUpdater.isReady()).toBe(true);
        });
    });

    describe('setMainWindow', () => {
        it('should set main window reference', () => {
            const mockWindow = { webContents: { send: jest.fn() }, isDestroyed: () => false };

            autoUpdater.setMainWindow(mockWindow);

            expect(autoUpdater.mainWindow).toBe(mockWindow);
        });
    });

    describe('sendToRenderer', () => {
        it('should send event to renderer when window exists', () => {
            const mockSend = jest.fn();
            const mockWindow = {
                webContents: { send: mockSend },
                isDestroyed: () => false,
            };
            autoUpdater.setMainWindow(mockWindow);

            autoUpdater.sendToRenderer('test-channel', { data: 'test' });

            expect(mockSend).toHaveBeenCalledWith('test-channel', { data: 'test' });
        });

        it('should not throw when window is null', () => {
            autoUpdater.mainWindow = null;

            expect(() => {
                autoUpdater.sendToRenderer('test-channel', { data: 'test' });
            }).not.toThrow();
        });

        it('should not send when window is destroyed', () => {
            const mockSend = jest.fn();
            const mockWindow = {
                webContents: { send: mockSend },
                isDestroyed: () => true,
            };
            autoUpdater.setMainWindow(mockWindow);

            autoUpdater.sendToRenderer('test-channel', { data: 'test' });

            expect(mockSend).not.toHaveBeenCalled();
        });
    });

    describe('electron-updater events', () => {
        let handlers;
        let send;
        let log;

        beforeEach(() => {
            handlers = Object.fromEntries(mockAutoUpdater.on.mock.calls.map(([event, fn]) => [event, fn]));
            send = jest.fn();
            autoUpdater.setMainWindow({ isDestroyed: () => false, webContents: { send } });
            log = { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), error: jest.fn() };
            require('../../src/js/logger').withCategory.mockReturnValue(log);
        });

        it('checking-for-update notifies the renderer', () => {
            handlers['checking-for-update']();
            expect(send).toHaveBeenCalledWith('update-checking', null);
            expect(log.info).toHaveBeenCalledWith('Checking for updates...', null);
        });

        it('update-available stores the formatted info and forwards it', () => {
            handlers['update-available']({
                version: '0.8.0',
                releaseNotes: 'n',
                files: [{ url: 'u', size: 1, sha: 'x' }],
            });

            expect(autoUpdater.getUpdateInfo()).toMatchObject({
                latestVersion: '0.8.0',
                files: [{ url: 'u', size: 1 }],
            });
            expect(send).toHaveBeenCalledWith('update-available', autoUpdater.getUpdateInfo());
        });

        it('update-available is not forwarded for a version the user skipped', () => {
            settingsState.skipUpdateVersion = '0.8.0';

            handlers['update-available']({ version: '0.8.0' });

            expect(autoUpdater.getUpdateInfo().latestVersion).toBe('0.8.0');
            expect(send).not.toHaveBeenCalled();
            expect(log.info).toHaveBeenCalledWith('Update skipped by user:', '0.8.0');
        });

        it('update-not-available reports the current version', () => {
            handlers['update-not-available']({ version: '0.6.1' });
            expect(send).toHaveBeenCalledWith('update-not-available', { version: '0.6.1' });
        });

        it('error resets the downloading flag and offers the browser fallback', () => {
            autoUpdater.isDownloading = true;

            handlers.error(new Error('signature mismatch'));

            expect(autoUpdater.isDownloading).toBe(false);
            expect(send).toHaveBeenCalledWith('update-error', {
                message: 'signature mismatch',
                canFallbackToBrowser: true,
            });
        });

        it('download-progress rounds the percentage and forwards the progress', () => {
            handlers['download-progress']({ percent: 41.6, bytesPerSecond: 10, transferred: 416, total: 1000 });

            const expected = { percent: 42, bytesPerSecond: 10, transferred: 416, total: 1000 };
            expect(autoUpdater.getDownloadProgress()).toEqual(expected);
            expect(send).toHaveBeenCalledWith('update-download-progress', expected);
            expect(log.debug).toHaveBeenCalledWith('Download progress: 42%', null);
        });

        it('update-downloaded marks the update ready and forwards the formatted info', () => {
            autoUpdater.isDownloading = true;

            handlers['update-downloaded']({ version: '0.8.0', releaseNotes: 'n' });

            expect(autoUpdater.isDownloading).toBe(false);
            expect(autoUpdater.isReady()).toBe(true);
            expect(send).toHaveBeenCalledWith('update-downloaded', expect.objectContaining({ latestVersion: '0.8.0' }));
        });
    });

    describe('platform support and failure paths', () => {
        const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        const setPlatform = (value) => Object.defineProperty(process, 'platform', { value, configurable: true });

        afterEach(() => {
            require('electron').app.isPackaged = false;
            Object.defineProperty(process, 'platform', originalPlatform);
        });

        it.each(['darwin', 'win32', 'linux', 'freebsd'])('a packaged build on %s attempts auto-update', (platform) => {
            require('electron').app.isPackaged = true;
            setPlatform(platform);
            expect(autoUpdater.canAutoUpdate()).toBe(true);
        });

        it('downloadUpdate refuses in an unpackaged build', async () => {
            autoUpdater.updateInfo = { latestVersion: '0.8.0' };
            await expect(autoUpdater.downloadUpdate()).resolves.toBe(false);
            expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
        });

        it('downloadUpdate rethrows a failed download and clears the downloading flag', async () => {
            require('electron').app.isPackaged = true;
            setPlatform('linux');
            autoUpdater.updateInfo = { latestVersion: '0.8.0' };
            mockAutoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('ENOSPC'));

            await expect(autoUpdater.downloadUpdate()).rejects.toThrow('ENOSPC');
            expect(autoUpdater.isDownloading).toBe(false);
        });

        it('checkForUpdates returns null when electron-updater reports no update info', async () => {
            mockAutoUpdater.checkForUpdates.mockResolvedValueOnce(null);
            await expect(autoUpdater.checkForUpdates(true)).resolves.toBeNull();
            expect(autoUpdater.getUpdateInfo()).toBeNull();
        });

        it('parseReleaseNotes handles note objects without a note field and unknown shapes', () => {
            expect(autoUpdater.parseReleaseNotes([{ note: 'a' }, 'plain'])).toBe('a\nplain');
            expect(autoUpdater.parseReleaseNotes({ unexpected: true })).toBe('No release notes available');
        });

        it('a throwing legacy store never breaks construction', () => {
            const error = jest.fn();
            require('../../src/js/logger').withCategory.mockReturnValueOnce({ error });
            mockMetadata.getLegacySkipVersion.mockImplementationOnce(() => {
                throw new Error('metadata.json corrupt');
            });

            expect(() => new AutoUpdater()).not.toThrow();
            expect(error).toHaveBeenCalledWith('skip-version migration failed:', expect.any(Error));
        });
    });
});
