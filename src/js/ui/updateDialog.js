// Update dialog functionality with download progress support

// Dialog states
const UPDATE_STATES = {
    AVAILABLE: 'available',
    DOWNLOADING: 'downloading',
    READY: 'ready',
    ERROR: 'error',
};

let currentState = UPDATE_STATES.AVAILABLE;
let __currentUpdateInfo = null; // eslint-disable-line no-unused-vars

export const initializeUpdateDialog = () => {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initializeUpdateDialogElements();
        });
    } else {
        initializeUpdateDialogElements();
    }
};

function initializeUpdateDialogElements() {
    // Get all dialog elements
    const elements = {
        dialog: document.getElementById('updateDialog'),
        title: document.getElementById('updateDialogTitle'),
        currentVersion: document.getElementById('currentVersion'),
        latestVersion: document.getElementById('latestVersion'),
        releaseNotes: document.getElementById('releaseNotes'),
        prereleaseBadge: document.getElementById('prereleaseBadge'),

        // Sections
        releaseNotesSection: document.getElementById('releaseNotesSection'),
        downloadProgressSection: document.getElementById('downloadProgressSection'),
        updateReadySection: document.getElementById('updateReadySection'),
        updateErrorSection: document.getElementById('updateErrorSection'),

        // Progress elements
        downloadProgress: document.getElementById('downloadProgress'),
        downloadPercent: document.getElementById('downloadPercent'),
        downloadSpeed: document.getElementById('downloadSpeed'),

        // Error elements
        updateErrorMessage: document.getElementById('updateErrorMessage'),

        // Button groups
        availableButtons: document.getElementById('availableButtons'),
        downloadingButtons: document.getElementById('downloadingButtons'),
        readyButtons: document.getElementById('readyButtons'),
        errorButtons: document.getElementById('errorButtons'),

        // Individual buttons
        skipButton: document.getElementById('skipButton'),
        remindLaterButton: document.getElementById('remindLaterButton'),
        downloadButton: document.getElementById('downloadButton'),
        cancelDownloadButton: document.getElementById('cancelDownloadButton'),
        restartLaterButton: document.getElementById('restartLaterButton'),
        restartNowButton: document.getElementById('restartNowButton'),
        closeErrorButton: document.getElementById('closeErrorButton'),
        browserDownloadButton: document.getElementById('browserDownloadButton'),
    };

    // Check if essential elements exist
    if (!elements.dialog) {
        window.api.logWarning('Update dialog not found, skipping initialization');
        return;
    }

    // Set dialog state and update visibility
    function setDialogState(state) {
        currentState = state;

        // Hide all sections
        elements.releaseNotesSection?.classList.add('hidden');
        elements.downloadProgressSection?.classList.add('hidden');
        elements.updateReadySection?.classList.add('hidden');
        elements.updateErrorSection?.classList.add('hidden');

        // Hide all button groups
        elements.availableButtons?.classList.add('hidden');
        elements.downloadingButtons?.classList.add('hidden');
        elements.readyButtons?.classList.add('hidden');
        elements.errorButtons?.classList.add('hidden');

        // Show appropriate sections and buttons based on state
        switch (state) {
        case UPDATE_STATES.AVAILABLE:
            elements.title.textContent = 'Update Available';
            elements.releaseNotesSection?.classList.remove('hidden');
            elements.availableButtons?.classList.remove('hidden');
            break;

        case UPDATE_STATES.DOWNLOADING:
            elements.title.textContent = 'Downloading Update';
            elements.downloadProgressSection?.classList.remove('hidden');
            elements.downloadingButtons?.classList.remove('hidden');
            break;

        case UPDATE_STATES.READY:
            elements.title.textContent = 'Update Ready';
            elements.updateReadySection?.classList.remove('hidden');
            elements.readyButtons?.classList.remove('hidden');
            break;

        case UPDATE_STATES.ERROR:
            elements.title.textContent = 'Update Error';
            elements.updateErrorSection?.classList.remove('hidden');
            elements.errorButtons?.classList.remove('hidden');
            break;
        }
    }

    // Format bytes to human readable
    function formatBytes(bytes, decimals = 1) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
    }

    // Update download progress
    function updateProgress(progress) {
        if (elements.downloadProgress) {
            elements.downloadProgress.value = progress.percent;
        }
        if (elements.downloadPercent) {
            elements.downloadPercent.textContent = `${progress.percent}%`;
        }
        if (elements.downloadSpeed && progress.bytesPerSecond) {
            const speed = formatBytes(progress.bytesPerSecond) + '/s';
            const transferred = formatBytes(progress.transferred);
            const total = formatBytes(progress.total);
            elements.downloadSpeed.textContent = `${transferred} / ${total} (${speed})`;
        }
    }

    // Show update dialog
    window.showUpdateDialog = (updateInfo) => {
        _currentUpdateInfo = updateInfo;

        if (elements.currentVersion) {
            elements.currentVersion.textContent = updateInfo.currentVersion;
        }
        if (elements.latestVersion) {
            elements.latestVersion.textContent = updateInfo.latestVersion;
        }
        if (elements.releaseNotes) {
            elements.releaseNotes.textContent = updateInfo.releaseNotes;
        }

        // Show prerelease badge if applicable
        if (elements.prereleaseBadge) {
            if (updateInfo.isPrerelease) {
                elements.prereleaseBadge.classList.remove('hidden');
            } else {
                elements.prereleaseBadge.classList.add('hidden');
            }
        }

        setDialogState(UPDATE_STATES.AVAILABLE);
        elements.dialog.classList.remove('hidden');
        elements.dialog.classList.add('flex');
    };

    // Hide update dialog
    window.hideUpdateDialog = () => {
        elements.dialog.classList.add('hidden');
        elements.dialog.classList.remove('flex');
        // Reset state for next time
        setDialogState(UPDATE_STATES.AVAILABLE);
        _currentUpdateInfo = null;
    };

    // Show download error
    function showError(message, showBrowserOption = true) {
        if (elements.updateErrorMessage) {
            elements.updateErrorMessage.textContent = message || 'Download failed';
        }
        setDialogState(UPDATE_STATES.ERROR);

        // Show/hide browser download button based on whether fallback is available
        if (elements.browserDownloadButton) {
            if (showBrowserOption) {
                elements.browserDownloadButton.classList.remove('hidden');
            } else {
                elements.browserDownloadButton.classList.add('hidden');
            }
        }
    }

    // Event listeners for available state
    elements.downloadButton?.addEventListener('click', async () => {
        try {
            // Check if auto-update is supported
            const canAutoUpdateResult = await window.api.canAutoUpdate();

            if (!canAutoUpdateResult.canAutoUpdate) {
                // Fall back to browser download
                const urlResult = await window.api.getReleasesUrl();
                await window.api.openExternalUrl(urlResult.url);
                window.hideUpdateDialog();
                return;
            }

            // Start download
            setDialogState(UPDATE_STATES.DOWNLOADING);
            const result = await window.api.downloadUpdate();

            if (!result.success) {
                showError(result.error, true);
            }
        } catch (error) {
            await window.api.logError(`Error downloading update: ${error.message || error}`);
            showError(error.message || 'Download failed');
        }
    });

    elements.remindLaterButton?.addEventListener('click', () => {
        window.hideUpdateDialog();
    });

    elements.skipButton?.addEventListener('click', async () => {
        try {
            await window.api.skipUpdateVersion();
            window.hideUpdateDialog();
        } catch (error) {
            await window.api.logError(`Error skipping update version: ${error.message || error}`);
        }
    });

    // Event listeners for downloading state
    elements.cancelDownloadButton?.addEventListener('click', () => {
        // Just close the dialog - download will continue in background
        // but user can check again later
        window.hideUpdateDialog();
    });

    // Event listeners for ready state
    elements.restartNowButton?.addEventListener('click', async () => {
        try {
            await window.api.installUpdate();
        } catch (error) {
            await window.api.logError(`Error installing update: ${error.message || error}`);
            showError(error.message || 'Installation failed');
        }
    });

    elements.restartLaterButton?.addEventListener('click', () => {
        window.hideUpdateDialog();
    });

    // Event listeners for error state
    elements.closeErrorButton?.addEventListener('click', () => {
        window.hideUpdateDialog();
    });

    elements.browserDownloadButton?.addEventListener('click', async () => {
        try {
            const urlResult = await window.api.getReleasesUrl();
            await window.api.openExternalUrl(urlResult.url);
            window.hideUpdateDialog();
        } catch (error) {
            await window.api.logError(`Error opening download URL: ${error.message || error}`);
        }
    });

    // Close dialog when clicking outside (only in available or error state)
    elements.dialog?.addEventListener('click', (e) => {
        if (e.target.id === 'updateDialog') {
            if (currentState === UPDATE_STATES.AVAILABLE ||
                currentState === UPDATE_STATES.ERROR) {
                window.hideUpdateDialog();
            }
        }
    });

    // Listen for update events from main process
    window.api.onUpdateAvailable((updateInfo) => {
        window.showUpdateDialog(updateInfo);
    });

    window.api.onDownloadProgress((progress) => {
        updateProgress(progress);
    });

    window.api.onUpdateDownloaded(() => {
        setDialogState(UPDATE_STATES.READY);
    });

    window.api.onUpdateError((error) => {
        showError(error.message, error.canFallbackToBrowser !== false);
    });

    // Legacy listener for backward compatibility
    window.api.onShowUpdateDialog?.((updateInfo) => {
        window.showUpdateDialog(updateInfo);
    });
}
