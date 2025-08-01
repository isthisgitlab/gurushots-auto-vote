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
    return {};
};

/**
 * Validate metadata entry
 * @param {Object} entry - Metadata entry to validate
 * @returns {boolean} - True if valid, false otherwise
 */
const validateMetadataEntry = (entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    
    // Check lastVoteTime
    if (entry.lastVoteTime && typeof entry.lastVoteTime !== 'string') return false;
    if (entry.lastVoteTime) {
        const date = new Date(entry.lastVoteTime);
        if (isNaN(date.getTime())) return false;
    }
    
    // Check exposureBump (allow values > 100% as this can happen when insufficient images are available)
    if (entry.exposureBump !== undefined) {
        if (typeof entry.exposureBump !== 'number' || entry.exposureBump < 0) {
            return false;
        }
    }
    
    return true;
};

/**
 * Validate entire metadata object
 * @param {Object} metadata - Metadata object to validate
 * @returns {Object} - {validatedMetadata, hasChanges}
 */
const validateMetadata = (metadata) => {
    const validatedMetadata = {};
    let hasChanges = false;

    for (const [challengeId, entry] of Object.entries(metadata)) {
        if (validateMetadataEntry(entry)) {
            validatedMetadata[challengeId] = entry;
        } else {
            logger.warning(`Invalid metadata entry for challenge ${challengeId}, removing`);
            hasChanges = true;
        }
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
        logger.error('Error loading metadata:', error);
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
        const { validatedMetadata, hasChanges } = validateMetadata(metadata);

        if (hasChanges) {
            logger.warning('Some metadata entries were invalid and have been removed');
        }

        // Write validated metadata to file
        fs.writeFileSync(metadataPath, JSON.stringify(validatedMetadata, null, 2), 'utf8');
        return true;
    } catch (error) {
        logger.error('Error saving metadata:', error);
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
        logger.error('Challenge ID is required');
        return false;
    }

    const entry = {};
    
    if (lastVoteTime) {
        // Validate timestamp
        const date = new Date(lastVoteTime);
        if (isNaN(date.getTime())) {
            logger.error('Invalid timestamp provided');
            return false;
        }
        entry.lastVoteTime = lastVoteTime;
    }

    if (exposureBump !== undefined) {
        // Validate exposure value (allow values > 100% as this can happen when insufficient images are available)
        if (typeof exposureBump !== 'number' || exposureBump < 0) {
            logger.error('Invalid exposure value provided');
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
        logger.debug('Skipping metadata cleanup: no active challenges provided (possibly loading error)');
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
                logger.debug(`Preserving recent metadata for challenge ${id} (voted ${voteTime.toLocaleTimeString()})`);
                return false; // Don't cleanup recent votes
            }
        }
        
        return isStale;
    });

    if (staleChallengeIds.length === 0) {
        return true; // Nothing to cleanup
    }

    logger.debug(`Cleaning up metadata for ${staleChallengeIds.length} stale challenges:`, staleChallengeIds);

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
    
    // Utility functions
    getAllMetadata,
    resetAllMetadata,
    getMetadataPath,
};