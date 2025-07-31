const axios = require('axios');
const logger = require('../logger');

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
        this.lastCheckKey = 'lastUpdateCheck';
        this.skipVersionKey = 'skipUpdateVersion';
    }

    /**
     * Check for updates and return update info if available
     * @param {boolean} saveCheckTime - Whether to save the check time to settings (default: true)
     * @returns {Promise<Object|null>} Update info or null if no update available
     */
    async checkForUpdates(saveCheckTime = true) {
        try {
            // Check if we should skip this version
            const settings = require('../settings');
            const skipVersion = settings.getSetting(this.skipVersionKey);
            
            // Get last check time to avoid too frequent checks
            const lastCheck = settings.getSetting(this.lastCheckKey);
            const now = Date.now();
            const oneDay = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
            
            // If we checked less than 24 hours ago, skip
            if (lastCheck && (now - lastCheck) < oneDay) {
                logger.info('🔄 Update check skipped - checked recently');
                return null;
            }

            logger.info('🔍 Checking for updates...');
            logger.info('📦 Current version:', this.currentVersion);

            const response = await axios.get(this.repositoryUrl, {
                timeout: 10000, // 10 second timeout
                headers: {
                    'User-Agent': 'GuruShotsAutoVote-UpdateChecker',
                },
            });

            const latestRelease = response.data;
            const latestVersion = latestRelease.tag_name.replace('v', '');

            logger.info('📦 Latest version:', latestVersion);

            // Compare versions
            if (this.isNewerVersion(latestVersion, this.currentVersion)) {
                // Don't show update if user chose to skip this version
                if (skipVersion === latestVersion) {
                    logger.info('⏭️ Update skipped by user for version:', latestVersion);
                    return null;
                }

                logger.info('🎉 New version available:', latestVersion);
                
                // Save the check time only if requested
                if (saveCheckTime) {
                    settings.setSetting(this.lastCheckKey, now);
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
                logger.info('✅ App is up to date');
                // Save the check time only if requested
                if (saveCheckTime) {
                    settings.setSetting(this.lastCheckKey, now);
                }
                return null;
            }
        } catch (error) {
            logger.error('❌ Error checking for updates:', error.message);
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
        const settings = require('../settings');
        settings.setSetting(this.skipVersionKey, version);
        logger.info('⏭️ Marked version to skip:', version);
    }

    /**
     * Clear skip version setting
     */
    clearSkipVersion() {
        const settings = require('../settings');
        settings.setSetting(this.skipVersionKey, '');
        logger.info('🔄 Cleared skip version setting');
    }

    /**
     * Force check for updates (ignores time restrictions)
     * @returns {Promise<Object|null>} Update info or null if no update available
     */
    async forceCheckForUpdates() {
        const settings = require('../settings');
        const originalLastCheck = settings.getSetting(this.lastCheckKey);
        
        // Temporarily clear last check to force update
        settings.setSetting(this.lastCheckKey, '');
        
        let result = null;
        try {
            // Don't save check time during manual checks to avoid triggering settings reload
            result = await this.checkForUpdates(false);
            return result;
        } finally {
            // Restore original last check if no update was found
            if (!result) {
                settings.setSetting(this.lastCheckKey, originalLastCheck);
            }
        }
    }
}

module.exports = UpdateChecker; 