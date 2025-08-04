const fs = require('fs');
const path = require('path');

// Import path utilities from settings to maintain consistency
const { getUserDataPath } = require('./settings');
const logger = require('./logger');

/**
 * Get the metadata file path
 * @returns {string} - Path to metadata.json file
 */
const getMetadataPath = () => {
    return path.join(getUserDataPath(), 'metadata.json');
};

/**
 * Default metadata structure
 * @returns {Object} - Empty metadata object
 */
const getDefaultMetadata = () => {
    return {
        updateCheck: {
            lastCheck: null,
            skipVersion: null,
        },
    };
};

/**
 * Validate metadata entry
 * @param {Object} entry - Metadata entry to validate
 * @returns {Object} - {isValid, reason} where reason describes validation failure
 */
const validateMetadataEntry = (entry) => {
    if (typeof entry !== 'object' || entry === null) {
        return { isValid: false, reason: 'Entry is not an object or is null' };
    }
    
    // Check lastVoteTime
    if (entry.lastVoteTime && typeof entry.lastVoteTime !== 'string') {
        return { isValid: false, reason: `lastVoteTime is not a string (type: ${typeof entry.lastVoteTime})` };
    }
    if (entry.lastVoteTime) {
        const date = new Date(entry.lastVoteTime);
        if (isNaN(date.getTime())) {
            return { isValid: false, reason: `lastVoteTime "${entry.lastVoteTime}" is not a valid date format` };
        }
    }
    
    // Check exposureBump (allow values > 100% as this can happen when insufficient images are available)
    if (entry.exposureBump !== undefined) {
        if (typeof entry.exposureBump !== 'number') {
            return { isValid: false, reason: `exposureBump is not a number (type: ${typeof entry.exposureBump}, value: ${entry.exposureBump})` };
        }
        if (entry.exposureBump < 0) {
            return { isValid: false, reason: `exposureBump is negative (${entry.exposureBump})` };
        }
    }
    
    return { isValid: true, reason: null };
};

/**
 * Validate entire metadata object
 * @param {Object} metadata - Metadata object to validate
 * @returns {Object} - {validatedMetadata, hasChanges}
 */
const validateMetadata = (metadata) => {
    const validatedMetadata = {};
    let hasChanges = false;

    // Validate update check data first
    if (metadata.updateCheck) {
        const updateCheck = metadata.updateCheck;
        const validUpdateCheck = {};
        
        // Validate lastCheck timestamp
        if (updateCheck.lastCheck !== null && updateCheck.lastCheck !== undefined) {
            if (typeof updateCheck.lastCheck === 'number' && updateCheck.lastCheck > 0) {
                validUpdateCheck.lastCheck = updateCheck.lastCheck;
            } else {
                const valueType = typeof updateCheck.lastCheck;
                const valueDesc = valueType === 'number' ? `${updateCheck.lastCheck} (must be > 0)` : `${updateCheck.lastCheck} (type: ${valueType}, expected: number)`;
                logger.withCategory('general').warning(`Invalid lastCheck timestamp in metadata: ${valueDesc}, removing`, null, logger.CATEGORIES.UPDATE);
                validUpdateCheck.lastCheck = null;
                hasChanges = true;
            }
        } else {
            validUpdateCheck.lastCheck = null;
        }
        
        // Validate skipVersion
        if (updateCheck.skipVersion !== null && updateCheck.skipVersion !== undefined) {
            if (typeof updateCheck.skipVersion === 'string' && updateCheck.skipVersion.length > 0) {
                validUpdateCheck.skipVersion = updateCheck.skipVersion;
            } else {
                const valueType = typeof updateCheck.skipVersion;
                const valueDesc = valueType === 'string' ? `"${updateCheck.skipVersion}" (empty string)` : `${updateCheck.skipVersion} (type: ${valueType}, expected: non-empty string)`;
                logger.withCategory('general').warning(`Invalid skipVersion in metadata: ${valueDesc}, removing`, null, logger.CATEGORIES.UPDATE);
                validUpdateCheck.skipVersion = null;
                hasChanges = true;
            }
        } else {
            validUpdateCheck.skipVersion = null;
        }
        
        validatedMetadata.updateCheck = validUpdateCheck;
    } else {
        // Add missing updateCheck structure
        validatedMetadata.updateCheck = {
            lastCheck: null,
            skipVersion: null,
        };
        hasChanges = true;
    }

    // Validate challenge entries
    const removedEntries = [];
    for (const [challengeId, entry] of Object.entries(metadata)) {
        // Skip updateCheck as we handled it above
        if (challengeId === 'updateCheck') continue;
        
        const validation = validateMetadataEntry(entry);
        if (validation.isValid) {
            validatedMetadata[challengeId] = entry;
        } else {
            logger.withCategory('challenges').warning(`Removing invalid metadata entry for challenge ${challengeId}: ${validation.reason}`);
            removedEntries.push({ challengeId, reason: validation.reason });
            hasChanges = true;
        }
    }
    
    // Log summary if multiple entries were removed
    if (removedEntries.length > 1) {
        logger.withCategory('api').warning(`Cleaned up ${removedEntries.length} invalid metadata entries total`, null);
    }

    return { validatedMetadata, hasChanges };
};

/**
 * Load metadata from file
 * @returns {Object} - Metadata object
 */
const loadMetadata = () => {
    try {
        const metadataPath = getMetadataPath();

        if (fs.existsSync(metadataPath)) {
            const metadataData = fs.readFileSync(metadataPath, 'utf8');
            const metadata = JSON.parse(metadataData);

            // Validate metadata
            const { validatedMetadata, hasChanges } = validateMetadata(metadata);

            // If validation changed anything, save the corrected metadata
            if (hasChanges) {
                fs.writeFileSync(metadataPath, JSON.stringify(validatedMetadata, null, 2), 'utf8');
            }

            return validatedMetadata;
        }

        // Return empty metadata if file doesn't exist
        return getDefaultMetadata();
    } catch (error) {
        logger.withCategory('api').error('Error loading metadata:', error);
        return getDefaultMetadata();
    }
};

/**
 * Save metadata to file
 * @param {Object} metadata - Metadata object to save
 * @returns {boolean} - True if successful, false otherwise
 */
const saveMetadata = (metadata) => {
    try {
        const metadataPath = getMetadataPath();

        // Ensure directory exists
        const metadataDir = path.dirname(metadataPath);
        if (!fs.existsSync(metadataDir)) {
            fs.mkdirSync(metadataDir, { recursive: true });
        }

        // Validate metadata before saving
        const { validatedMetadata } = validateMetadata(metadata);

        // Write validated metadata to file
        fs.writeFileSync(metadataPath, JSON.stringify(validatedMetadata, null, 2), 'utf8');
        return true;
    } catch (error) {
        logger.withCategory('api').error('Error saving metadata:', error);
        return false;
    }
};

/**
 * Get metadata for a specific challenge
 * @param {string} challengeId - Challenge ID
 * @returns {Object|null} - Metadata entry or null if not found
 */
const getChallengeMetadata = (challengeId) => {
    const metadata = loadMetadata();
    return metadata[challengeId] || null;
};

/**
 * Set metadata for a specific challenge
 * @param {string} challengeId - Challenge ID
 * @param {string} lastVoteTime - ISO timestamp of last vote
 * @param {number} exposureBump - Exposure level when vote occurred
 * @returns {boolean} - True if successful, false otherwise
 */
const setChallengeMetadata = (challengeId, lastVoteTime, exposureBump) => {
    if (!challengeId) {
        logger.withCategory('challenges').error('Challenge ID is required', null);
        return false;
    }

    const entry = {};
    
    if (lastVoteTime) {
        // Validate timestamp
        const date = new Date(lastVoteTime);
        if (isNaN(date.getTime())) {
            logger.withCategory('voting').error('Invalid timestamp provided', null);
            return false;
        }
        entry.lastVoteTime = lastVoteTime;
    }

    if (exposureBump !== undefined) {
        // Validate exposure value (allow values > 100% as this can happen when insufficient images are available)
        if (typeof exposureBump !== 'number' || exposureBump < 0) {
            logger.withCategory('voting').error('Invalid exposure value provided', null);
            return false;
        }
        entry.exposureBump = exposureBump;
    }

    const metadata = loadMetadata();
    
    // Merge with existing entry or create new one
    if (metadata[challengeId]) {
        metadata[challengeId] = { ...metadata[challengeId], ...entry };
    } else {
        metadata[challengeId] = entry;
    }

    return saveMetadata(metadata);
};

/**
 * Update last vote time for a challenge
 * @param {string} challengeId - Challenge ID
 * @param {string} timestamp - ISO timestamp (optional, defaults to now)
 * @returns {boolean} - True if successful, false otherwise
 */
const updateLastVoteTime = (challengeId, timestamp = null) => {
    const voteTime = timestamp || new Date().toISOString();
    const existing = getChallengeMetadata(challengeId);
    const exposureBump = existing?.exposureBump;
    
    return setChallengeMetadata(challengeId, voteTime, exposureBump);
};

/**
 * Update exposure bump for a challenge
 * @param {string} challengeId - Challenge ID
 * @param {number} exposure - Exposure level
 * @returns {boolean} - True if successful, false otherwise
 */
const updateExposureBump = (challengeId, exposure) => {
    const existing = getChallengeMetadata(challengeId);
    const lastVoteTime = existing?.lastVoteTime;
    
    return setChallengeMetadata(challengeId, lastVoteTime, exposure);
};

/**
 * Update both last vote time and exposure bump for a challenge
 * @param {string} challengeId - Challenge ID
 * @param {number} exposure - Exposure level
 * @param {string} timestamp - ISO timestamp (optional, defaults to now)
 * @returns {boolean} - True if successful, false otherwise
 */
const updateChallengeVoteMetadata = (challengeId, exposure, timestamp = null) => {
    const voteTime = timestamp || new Date().toISOString();
    return setChallengeMetadata(challengeId, voteTime, exposure);
};

/**
 * Remove metadata for a specific challenge
 * @param {string} challengeId - Challenge ID
 * @returns {boolean} - True if successful, false otherwise
 */
const removeChallengeMetadata = (challengeId) => {
    const metadata = loadMetadata();
    
    if (metadata[challengeId]) {
        delete metadata[challengeId];
        return saveMetadata(metadata);
    }
    
    return true; // Nothing to remove
};

/**
 * Clean up metadata for challenges that no longer exist
 * @param {string[]} activeChallengeIds - Array of currently active challenge IDs
 * @returns {boolean} - True if cleanup was successful, false otherwise
 */
const cleanupStaleMetadata = (activeChallengeIds) => {
    // Safety check: don't cleanup if we have no active challenges (likely an error state)
    if (!activeChallengeIds || activeChallengeIds.length === 0) {
        logger.withCategory('api').debug('Skipping metadata cleanup: no active challenges provided (possibly loading error)', null);
        return true;
    }

    const metadata = loadMetadata();
    const storedChallengeIds = Object.keys(metadata);
    
    // Only cleanup challenges that are definitively stale
    // Be conservative: keep metadata if there's any doubt
    const staleChallengeIds = storedChallengeIds.filter(id => {
        const isStale = !activeChallengeIds.includes(id);
        
        // Additional safety: check if metadata is very recent (within last hour)
        // This prevents cleanup of challenges that were just voted on
        if (isStale && metadata[id] && metadata[id].lastVoteTime) {
            const voteTime = new Date(metadata[id].lastVoteTime);
            const hourAgo = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
            
            if (voteTime > hourAgo) {
                logger.withCategory('voting').debug(`Preserving recent metadata for challenge ${id} (voted ${voteTime.toLocaleTimeString()})`, null);
                return false; // Don't cleanup recent votes
            }
        }
        
        return isStale;
    });

    if (staleChallengeIds.length === 0) {
        return true; // Nothing to cleanup
    }

    logger.withCategory('api').debug(`Cleaning up metadata for ${staleChallengeIds.length} stale challenges:`, staleChallengeIds);

    staleChallengeIds.forEach(challengeId => {
        delete metadata[challengeId];
    });

    return saveMetadata(metadata);
};

/**
 * Get all metadata
 * @returns {Object} - Complete metadata object
 */
const getAllMetadata = () => {
    return loadMetadata();
};

/**
 * Reset all metadata (clear all entries)
 * @returns {boolean} - True if successful, false otherwise
 */
const resetAllMetadata = () => {
    return saveMetadata(getDefaultMetadata());
};

/**
 * Get update check data
 * @returns {Object} - {lastCheck: number|null, skipVersion: string|null}
 */
const getUpdateCheckData = () => {
    const metadata = loadMetadata();
    return metadata.updateCheck || { lastCheck: null, skipVersion: null };
};

/**
 * Set last update check timestamp
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {boolean} - True if successful, false otherwise
 */
const setLastUpdateCheck = (timestamp) => {
    if (typeof timestamp !== 'number' || timestamp <= 0) {
        logger.withCategory('update').error('Invalid timestamp provided for last update check', null);
        return false;
    }

    const metadata = loadMetadata();
    if (!metadata.updateCheck) {
        metadata.updateCheck = { lastCheck: null, skipVersion: null };
    }
    
    metadata.updateCheck.lastCheck = timestamp;
    return saveMetadata(metadata);
};

/**
 * Set version to skip for updates
 * @param {string} version - Version string to skip
 * @returns {boolean} - True if successful, false otherwise
 */
const setSkipUpdateVersion = (version) => {
    if (typeof version !== 'string' || version.length === 0) {
        logger.withCategory('update').error('Invalid version provided for skip update', null);
        return false;
    }

    const metadata = loadMetadata();
    if (!metadata.updateCheck) {
        metadata.updateCheck = { lastCheck: null, skipVersion: null };
    }
    
    metadata.updateCheck.skipVersion = version;
    return saveMetadata(metadata);
};

/**
 * Clear skip update version
 * @returns {boolean} - True if successful, false otherwise
 */
const clearSkipUpdateVersion = () => {
    const metadata = loadMetadata();
    if (!metadata.updateCheck) {
        metadata.updateCheck = { lastCheck: null, skipVersion: null };
    }
    
    metadata.updateCheck.skipVersion = null;
    return saveMetadata(metadata);
};

module.exports = {
    // Core functions
    loadMetadata,
    saveMetadata,
    getChallengeMetadata,
    setChallengeMetadata,
    
    // Convenience functions
    updateLastVoteTime,
    updateExposureBump,
    updateChallengeVoteMetadata,
    removeChallengeMetadata,
    cleanupStaleMetadata,
    
    // Update check functions
    getUpdateCheckData,
    setLastUpdateCheck,
    setSkipUpdateVersion,
    clearSkipUpdateVersion,
    
    // Utility functions
    getAllMetadata,
    resetAllMetadata,
    getMetadataPath,
};