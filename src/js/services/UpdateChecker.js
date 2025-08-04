const axios = require('axios');
const logger = require('../logger');
const metadata = require('../metadata');

class UpdateChecker {
    constructor() {
        // Get version from package.json when not in Electron
        try {
            const { app } = require('electron');
            this.currentVersion = app.getVersion();
        } catch {
            // Fallback to package.json when not in Electron
            const path = require('path');
            const packageJson = require(path.join(__dirname, '../../../package.json'));
            this.currentVersion = packageJson.version;
        }
        
        this.repositoryUrl = 'https://api.github.com/repos/isthisgitlab/gurushots-auto-vote/releases/latest';
    }

    /**
     * Check for updates and return update info if available
     * @param {boolean} saveCheckTime - Whether to save the check time to settings (default: true)
     * @returns {Promise<Object|null>} Update info or null if no update available
     */
    async checkForUpdates(saveCheckTime = true) {
        try {
            // Get update check data from metadata
            const updateCheckData = metadata.getUpdateCheckData();
            const skipVersion = updateCheckData.skipVersion;
            
            // Get last check time to avoid too frequent checks
            const lastCheck = updateCheckData.lastCheck;
            const now = Date.now();
            const oneDay = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
            
            // If we checked less than 24 hours ago, skip
            if (lastCheck && (now - lastCheck) < oneDay) {
                logger.withCategory('update').info('🔄 Update check skipped - checked recently', null);
                return null;
            }

            logger.withCategory('update').info('🔍 Checking for updates...', null);
            logger.withCategory('update').info('📦 Current version:', this.currentVersion);

            const response = await axios.get(this.repositoryUrl, {
                timeout: 10000, // 10 second timeout
                headers: {
                    'User-Agent': 'GuruShotsAutoVote-UpdateChecker',
                },
            });

            const latestRelease = response.data;
            const latestVersion = latestRelease.tag_name.replace('v', '');

            logger.withCategory('update').info('📦 Latest version:', latestVersion);

            // Compare versions
            if (this.isNewerVersion(latestVersion, this.currentVersion)) {
                // Don't show update if user chose to skip this version
                if (skipVersion === latestVersion) {
                    logger.withCategory('update').info('⏭️ Update skipped by user for version:', latestVersion);
                    return null;
                }

                logger.withCategory('update').info('🎉 New version available:', latestVersion);
                
                // Save the check time only if requested
                if (saveCheckTime) {
                    metadata.setLastUpdateCheck(now);
                }

                return {
                    currentVersion: this.currentVersion,
                    latestVersion: latestVersion,
                    releaseNotes: latestRelease.body || 'No release notes available',
                    downloadUrl: latestRelease.html_url,
                    publishedAt: latestRelease.published_at,
                    isPrerelease: latestRelease.prerelease,
                };
            } else {
                logger.withCategory('update').info('✅ App is up to date', null);
                // Save the check time only if requested
                if (saveCheckTime) {
                    metadata.setLastUpdateCheck(now);
                }
                return null;
            }
        } catch (error) {
            logger.withCategory('update').error('❌ Error checking for updates:', error.message);
            return null;
        }
    }

    /**
     * Compare two version strings
     * @param {string} version1 
     * @param {string} version2 
     * @returns {boolean} True if version1 is newer than version2
     */
    isNewerVersion(version1, version2) {
        const v1Parts = version1.split('.').map(Number);
        const v2Parts = version2.split('.').map(Number);
        
        // Pad with zeros if needed
        const maxLength = Math.max(v1Parts.length, v2Parts.length);
        while (v1Parts.length < maxLength) v1Parts.push(0);
        while (v2Parts.length < maxLength) v2Parts.push(0);
        
        for (let i = 0; i < maxLength; i++) {
            if (v1Parts[i] > v2Parts[i]) return true;
            if (v1Parts[i] < v2Parts[i]) return false;
        }
        
        return false; // Versions are equal
    }

    /**
     * Mark a version to be skipped
     * @param {string} version 
     */
    skipVersion(version) {
        metadata.setSkipUpdateVersion(version);
        logger.withCategory('update').info('⏭️ Marked version to skip:', version);
    }

    /**
     * Clear skip version setting
     */
    clearSkipVersion() {
        metadata.clearSkipUpdateVersion();
        logger.withCategory('update').info('🔄 Cleared skip version setting', null);
    }

    /**
     * Force check for updates (ignores time restrictions)
     * @returns {Promise<Object|null>} Update info or null if no update available
     */
    async forceCheckForUpdates() {
        const updateCheckData = metadata.getUpdateCheckData();
        const originalLastCheck = updateCheckData.lastCheck;
        
        // Temporarily clear last check to force update
        metadata.setLastUpdateCheck(0);
        
        let result = null;
        try {
            // Don't save check time during manual checks
            result = await this.checkForUpdates(false);
            return result;
        } finally {
            // Restore original last check if no update was found
            if (!result && originalLastCheck) {
                metadata.setLastUpdateCheck(originalLastCheck);
            }
        }
    }
}

module.exports = UpdateChecker; 