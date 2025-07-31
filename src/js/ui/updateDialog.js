// Update dialog functionality
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
    const updateDialog = document.getElementById('updateDialog');
    const currentVersion = document.getElementById('currentVersion');
    const latestVersion = document.getElementById('latestVersion');
    const releaseNotes = document.getElementById('releaseNotes');
    const prereleaseBadge = document.getElementById('prereleaseBadge');
    const skipButton = document.getElementById('skipButton');
    const remindLaterButton = document.getElementById('remindLaterButton');
    const downloadButton = document.getElementById('downloadButton');

    // Check if all elements exist
    if (!updateDialog || !currentVersion || !latestVersion || !releaseNotes || 
        !prereleaseBadge || !skipButton || !remindLaterButton || !downloadButton) {
        window.api.logWarning('Update dialog elements not found, skipping initialization');
        return;
    }

    // Show update dialog
    window.showUpdateDialog = (updateInfo) => {
        currentVersion.textContent = updateInfo.currentVersion;
        latestVersion.textContent = updateInfo.latestVersion;
        releaseNotes.textContent = updateInfo.releaseNotes;
        
        // Show prerelease badge if it's a prerelease
        if (updateInfo.isPrerelease) {
            prereleaseBadge.classList.remove('hidden');
        } else {
            prereleaseBadge.classList.add('hidden');
        }
        
        updateDialog.classList.remove('hidden');
        updateDialog.classList.add('flex');
    };

    // Hide update dialog
    window.hideUpdateDialog = () => {
        updateDialog.classList.add('hidden');
        updateDialog.classList.remove('flex');
    };

    // Event listeners
    downloadButton.addEventListener('click', async () => {
        try {
            await window.api.openExternalUrl('https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest');
            window.hideUpdateDialog();
        } catch (error) {
            await window.api.logError('Error opening download URL:', error);
        }
    });

    remindLaterButton.addEventListener('click', () => {
        window.hideUpdateDialog();
    });

    skipButton.addEventListener('click', async () => {
        try {
            await window.api.skipUpdateVersion();
            window.hideUpdateDialog();
        } catch (error) {
            await window.api.logError('Error skipping update version:', error);
        }
    });

    // Close dialog when clicking outside
    updateDialog.addEventListener('click', (e) => {
        if (e.target.id === 'updateDialog') {
            window.hideUpdateDialog();
        }
    });

    // Listen for update notifications from main process
    window.api.onShowUpdateDialog((updateInfo) => {
        window.showUpdateDialog(updateInfo);
    });
} 