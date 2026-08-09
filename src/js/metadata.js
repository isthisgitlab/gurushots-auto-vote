const logger = require('./logger');
const { formatTimeHMS } = require('./dateFormat');
const { createJsonStore } = require('./settings/storage');

// Platform-aware transport (fs on Electron/CLI, @capacitor/preferences on
// the Android app WebView, in-memory on the headless service). Replaces the
// old raw-fs access that threw on every call under Capacitor.
const metadataStore = createJsonStore({ fileName: 'metadata.json', prefKey: 'gurushots-metadata' });

/**
 * Get the metadata file path (fs platforms; debug/info surfaces).
 * @returns {string} - Path to metadata.json file
 */
const getMetadataPath = () => metadataStore.getFilePath();

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
 * Upper bounds for the per-challenge entry-id snapshot (voteOnNewEntry). Unlike
 * lastVoteTime/exposureBump these ids come straight off a remote API response, and
 * loadMetadata/saveMetadata parse and re-serialize the WHOLE file synchronously on
 * the Electron main process — so an inflated entries array would stall the UI on
 * every poll. Real max_photo_submits is single-digit; both caps are far above any
 * legitimate value and exist only to bound a malformed response.
 */
const MAX_TRACKED_ENTRY_IDS = 64;
const MAX_ENTRY_ID_LENGTH = 64;

// Challenge ids come from the GuruShots API, so collapse CR/LF before interpolating
// one into a message. These carry a bare id rather than the full `[Challenge …]`
// tag, so they use the shared helper directly instead of logger.challengeTag.
const { oneLine: oneLineId } = require('./format/logSafe');

/**
 * Reject the three keys that address Object.prototype instead of creating an own
 * property. Challenge ids are numeric in practice, so this never fires today — but
 * the id is remote-controlled and every write path here uses it as a bracket key.
 * @param {*} challengeId
 * @returns {boolean}
 */
const isUnsafeChallengeKey = (challengeId) =>
    challengeId === '__proto__' || challengeId === 'constructor' || challengeId === 'prototype';

/**
 * Validate an entryIds snapshot.
 * @param {*} entryIds
 * @returns {string|null} - Failure reason, or null when the value is acceptable
 */
const entryIdsFailureReason = (entryIds) => {
    if (!Array.isArray(entryIds)) {
        return `entryIds is not an array (type: ${typeof entryIds})`;
    }
    if (entryIds.length > MAX_TRACKED_ENTRY_IDS) {
        return `entryIds has ${entryIds.length} elements (max ${MAX_TRACKED_ENTRY_IDS})`;
    }
    for (const id of entryIds) {
        if (typeof id !== 'string' || id.length === 0) {
            return `entryIds contains a non-string or empty id (type: ${typeof id})`;
        }
        if (id.length > MAX_ENTRY_ID_LENGTH) {
            return `entryIds contains an id of length ${id.length} (max ${MAX_ENTRY_ID_LENGTH})`;
        }
    }
    return null;
};

/**
 * Validate metadata entry.
 *
 * lastVoteTime and exposureBump are always internally computed, so a malformed
 * value there means the whole entry is untrustworthy and gets dropped — that is
 * the long-standing behavior and these checks deliberately run FIRST so an entry
 * that is bad in both ways is still dropped rather than "repaired".
 *
 * entryIds is different: it derives from remote API data, so applying the same
 * all-or-nothing rule would let one odd API response silently wipe a challenge's
 * real voting history. A malformed entryIds is therefore STRIPPED, and the rest of
 * the entry survives.
 *
 * @param {Object} entry - Metadata entry to validate
 * @returns {Object} - {isValid, reason, entry, repairReason} where `entry` is the
 *   (possibly repaired) entry to store and `repairReason` describes a stripped
 *   field, if any
 */
const validateMetadataEntry = (entry) => {
    if (typeof entry !== 'object' || entry === null) {
        return { isValid: false, reason: 'Entry is not an object or is null', entry: null, repairReason: null };
    }

    // Check lastVoteTime
    if (entry.lastVoteTime && typeof entry.lastVoteTime !== 'string') {
        return {
            isValid: false,
            reason: `lastVoteTime is not a string (type: ${typeof entry.lastVoteTime})`,
            entry: null,
            repairReason: null,
        };
    }
    if (entry.lastVoteTime) {
        const date = new Date(entry.lastVoteTime);
        if (isNaN(date.getTime())) {
            return {
                isValid: false,
                reason: `lastVoteTime "${entry.lastVoteTime}" is not a valid date format`,
                entry: null,
                repairReason: null,
            };
        }
    }

    // Check exposureBump (allow values > 100% as this can happen when insufficient images are available)
    if (entry.exposureBump !== undefined) {
        if (typeof entry.exposureBump !== 'number') {
            return {
                isValid: false,
                reason: `exposureBump is not a number (type: ${typeof entry.exposureBump}, value: ${entry.exposureBump})`,
                entry: null,
                repairReason: null,
            };
        }
        if (entry.exposureBump < 0) {
            return {
                isValid: false,
                reason: `exposureBump is negative (${entry.exposureBump})`,
                entry: null,
                repairReason: null,
            };
        }
    }

    // Check entryIds LAST — strip-not-drop, so the checks above keep their
    // whole-entry-reject semantics.
    if (entry.entryIds !== undefined) {
        const failure = entryIdsFailureReason(entry.entryIds);
        if (failure) {
            const repaired = { ...entry };
            delete repaired.entryIds;
            return { isValid: true, reason: null, entry: repaired, repairReason: failure };
        }
    }

    return { isValid: true, reason: null, entry, repairReason: null };
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
                const valueDesc =
                    valueType === 'number'
                        ? `${updateCheck.lastCheck} (must be > 0)`
                        : `${updateCheck.lastCheck} (type: ${valueType}, expected: number)`;
                logger
                    .withCategory('general')
                    .warning(
                        `Invalid lastCheck timestamp in metadata: ${valueDesc}, removing`,
                        null,
                        logger.CATEGORIES.UPDATE,
                    );
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
                const valueDesc =
                    valueType === 'string'
                        ? `"${updateCheck.skipVersion}" (empty string)`
                        : `${updateCheck.skipVersion} (type: ${valueType}, expected: non-empty string)`;
                logger
                    .withCategory('general')
                    .warning(`Invalid skipVersion in metadata: ${valueDesc}, removing`, null, logger.CATEGORIES.UPDATE);
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
            // validation.entry is the repaired entry — identical to `entry` unless a
            // malformed entryIds snapshot was stripped off it.
            validatedMetadata[challengeId] = validation.entry;
            if (validation.repairReason) {
                logger
                    .withCategory('challenges')
                    .warning(
                        `Dropping invalid entryIds snapshot for challenge ${oneLineId(challengeId)}: ${validation.repairReason}`,
                    );
                hasChanges = true;
            }
        } else {
            logger
                .withCategory('challenges')
                .warning(`Removing invalid metadata entry for challenge ${challengeId}: ${validation.reason}`);
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
        const metadataData = metadataStore.readRaw();

        if (metadataData) {
            const metadata = JSON.parse(metadataData);

            // Validate metadata
            const { validatedMetadata, hasChanges } = validateMetadata(metadata);

            // If validation changed anything, save the corrected metadata
            if (hasChanges) {
                metadataStore.writeRaw(JSON.stringify(validatedMetadata, null, 2));
            }

            return validatedMetadata;
        }

        // Return empty metadata if the store has never been written
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
        // Validate metadata before saving
        const { validatedMetadata } = validateMetadata(metadata);

        metadataStore.writeRaw(JSON.stringify(validatedMetadata, null, 2));
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
 * True when two id lists hold the same members, regardless of order.
 * The server can reorder ranking.entries between polls (after a boost, or a
 * ranking resort) with no actual membership change, so every comparison on this
 * snapshot is a set comparison — a positional or JSON.stringify compare would
 * read a reorder as a change.
 * @param {string[]|null} a
 * @param {string[]|null} b
 * @returns {boolean}
 */
const sameEntryIdSet = (a, b) => {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    const setA = new Set(a);
    if (setA.size !== new Set(b).size) return false;
    return b.every((id) => setA.has(id));
};

/**
 * Read the persisted entry-id snapshot for a challenge (voteOnNewEntry).
 * @param {string} challengeId - Challenge ID
 * @returns {string[]|null} - The stored ids, or null when none has ever been
 *   stored. `null` and `[]` are meaningfully different: `[]` means "seen, and the
 *   challenge had no entries", which is a valid baseline that must not fire.
 */
const getChallengeEntryIds = (challengeId) => {
    const entry = getChallengeMetadata(challengeId);
    const stored = entry?.entryIds;
    return Array.isArray(stored) ? stored : null;
};

/**
 * Persist the entry-id snapshot for a challenge (voteOnNewEntry).
 * Skips the WRITE when the stored snapshot already holds the same set, so a
 * server-side reorder costs no serialization or disk write. Note the read still
 * happens — loadMetadata parses and re-validates the whole file — so callers
 * should not treat an unchanged snapshot as entirely free.
 * @param {string} challengeId - Challenge ID
 * @param {string[]} entryIds - Current entry ids
 * @returns {boolean} - True if successful (including the skipped-write case)
 */
const setChallengeEntryIds = (challengeId, entryIds) => {
    if (!challengeId) {
        logger.withCategory('challenges').error('Challenge ID is required', null);
        return false;
    }
    if (isUnsafeChallengeKey(challengeId)) {
        logger
            .withCategory('challenges')
            .warning(`Refusing to store entryIds under reserved key "${oneLineId(challengeId)}"`, null);
        return false;
    }
    const failure = entryIdsFailureReason(entryIds);
    if (failure) {
        logger
            .withCategory('challenges')
            .warning(`Refusing to store entryIds for challenge ${oneLineId(challengeId)}: ${failure}`, null);
        return false;
    }

    const metadata = loadMetadata();
    const existing = metadata[challengeId];
    if (existing && sameEntryIdSet(existing.entryIds, entryIds)) {
        return true; // Unchanged — skip the whole-file rewrite
    }

    metadata[challengeId] = { ...(existing || {}), entryIds };
    return saveMetadata(metadata);
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
        logger
            .withCategory('api')
            .debug('Skipping metadata cleanup: no active challenges provided (possibly loading error)', null);
        return true;
    }

    const metadata = loadMetadata();
    // Object.keys(metadata) includes the 'updateCheck' bookkeeping
    // entry; exclude it so cleanup only considers real challenge IDs
    // and doesn't gratuitously rewrite the file on every call.
    const storedChallengeIds = Object.keys(metadata).filter((id) => id !== 'updateCheck');

    // Only cleanup challenges that are definitively stale
    // Be conservative: keep metadata if there's any doubt
    const staleChallengeIds = storedChallengeIds.filter((id) => {
        const isStale = !activeChallengeIds.includes(id);

        // Additional safety: check if metadata is very recent (within last hour)
        // This prevents cleanup of challenges that were just voted on
        if (isStale && metadata[id] && metadata[id].lastVoteTime) {
            const voteTime = new Date(metadata[id].lastVoteTime);
            const hourAgo = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

            if (voteTime > hourAgo) {
                logger
                    .withCategory('voting')
                    .debug(`Preserving recent metadata for challenge ${id} (voted ${formatTimeHMS(voteTime)})`, null);
                return false; // Don't cleanup recent votes
            }
        }

        return isStale;
    });

    if (staleChallengeIds.length === 0) {
        return true; // Nothing to cleanup
    }

    logger
        .withCategory('api')
        .debug(`Cleaning up metadata for ${staleChallengeIds.length} stale challenges:`, staleChallengeIds);

    staleChallengeIds.forEach((challengeId) => {
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
 * Read the legacy metadata-resident skipVersion (pre-consolidation store).
 * The canonical store is now the settings blob (skipUpdateVersion);
 * AutoUpdater's one-shot migration reads this, persists it into settings,
 * verifies, and then calls clearLegacySkipVersion(). The field stays
 * accepted by validation so an old metadata.json round-trips untouched
 * until the migration has safely landed the value in settings.
 * @returns {string|null}
 */
const getLegacySkipVersion = () => {
    const metadata = loadMetadata();
    return metadata.updateCheck?.skipVersion || null;
};

/**
 * Clear the legacy metadata-resident skipVersion after migration.
 * @returns {boolean}
 */
const clearLegacySkipVersion = () => {
    const metadata = loadMetadata();
    if (!metadata.updateCheck?.skipVersion) return true;
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

    // Entry-id snapshot (voteOnNewEntry)
    getChallengeEntryIds,
    setChallengeEntryIds,
    MAX_TRACKED_ENTRY_IDS,
    MAX_ENTRY_ID_LENGTH,

    // Update check functions
    getUpdateCheckData,
    setLastUpdateCheck,
    getLegacySkipVersion,
    clearLegacySkipVersion,
    initializeMetadataAsync: metadataStore.initializeAsync,
    flushMetadataWrites: metadataStore.flushPendingWrites,

    // Utility functions
    getAllMetadata,
    resetAllMetadata,
    getMetadataPath,
};
