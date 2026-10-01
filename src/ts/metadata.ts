import type { ChallengeMetadataEntry, MetadataFile, UpdateCheckData } from './types/stores';
import * as logger from './logger';
import { formatTimeHMS } from './dateFormat';
import { createJsonStore } from './settings/storage';

// Platform-aware transport (fs on Electron/CLI, @capacitor/preferences on
// the Android app WebView, in-memory on the headless service); raw fs would
// throw on every call under Capacitor.
const metadataStore = createJsonStore({ fileName: 'metadata.json', prefKey: 'gurushots-metadata' });

/**
 * Default metadata structure
 * @returns Empty metadata object
 */
const getDefaultMetadata = (): MetadataFile => {
    return {
        updateCheck: {
            lastCheck: null,
            skipVersion: null,
        },
    };
};

/**
 * One challenge's entry. Challenge ids are numeric strings, so the lookup never
 * lands on the `updateCheck` block.
 * @param metadata - Loaded metadata
 * @param challengeId - Challenge ID
 */
const challengeEntry = (metadata: MetadataFile, challengeId: string | number): ChallengeMetadataEntry | undefined =>
    metadata[challengeId] as ChallengeMetadataEntry | undefined;

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
import { oneLine as oneLineId } from './format/logSafe';
import { isPlainObject } from './plainObject';

/**
 * Reject the three keys that address Object.prototype instead of creating an own
 * property. Challenge ids are numeric in practice, so this never fires today — but
 * the id is remote-controlled and every write path here uses it as a bracket key.
 */
const isUnsafeChallengeKey = (challengeId: string | number): boolean =>
    challengeId === '__proto__' || challengeId === 'constructor' || challengeId === 'prototype';

/**
 * Validate an entryIds snapshot.
 * @returns Failure reason, or null when the value is acceptable
 */
const entryIdsFailureReason = (entryIds: unknown): string | null => {
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
 * @param rawEntry - Metadata entry to validate (untrusted file contents)
 *   `entry` is the (possibly repaired) entry to store and `repairReason`
 *   describes a stripped field, if any
 */
const validateMetadataEntry = (
    rawEntry: unknown,
): { isValid: boolean; reason: string | null; entry: ChallengeMetadataEntry | null; repairReason: string | null } => {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
        return { isValid: false, reason: 'Entry is not an object or is null', entry: null, repairReason: null };
    }
    const entry = rawEntry as Record<string, unknown>;
    const { lastVoteTime } = entry;

    // Check lastVoteTime
    if (lastVoteTime && typeof lastVoteTime !== 'string') {
        return {
            isValid: false,
            reason: `lastVoteTime is not a string (type: ${typeof lastVoteTime})`,
            entry: null,
            repairReason: null,
        };
    }
    if (typeof lastVoteTime === 'string' && lastVoteTime) {
        const date = new Date(lastVoteTime);
        if (isNaN(date.getTime())) {
            return {
                isValid: false,
                reason: `lastVoteTime "${lastVoteTime}" is not a valid date format`,
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
            // Every field checked above is valid; unknown extra keys are kept as-is.
            return {
                isValid: true,
                reason: null,
                entry: repaired as ChallengeMetadataEntry,
                repairReason: failure,
            };
        }
    }

    return { isValid: true, reason: null, entry: entry as ChallengeMetadataEntry, repairReason: null };
};

/**
 * The two optional updateCheck fields: a present value that fails `isValid` is
 * reset to null (and logged via `describe`); an absent one stays null.
 */
const UPDATE_CHECK_FIELDS: Array<{
    key: keyof UpdateCheckData;
    label: string;
    isValid: (value: unknown) => boolean;
    describe: (value: unknown) => string;
}> = [
    {
        key: 'lastCheck',
        label: 'lastCheck timestamp',
        isValid: (value) => typeof value === 'number' && value > 0,
        describe: (value) =>
            typeof value === 'number' ? `${value} (must be > 0)` : `${value} (type: ${typeof value}, expected: number)`,
    },
    {
        key: 'skipVersion',
        label: 'skipVersion',
        isValid: (value) => typeof value === 'string' && value.length > 0,
        describe: (value) =>
            typeof value === 'string'
                ? `"${value}" (empty string)`
                : `${value} (type: ${typeof value}, expected: non-empty string)`,
    },
];

/**
 * Validate the updateCheck block.
 * @param updateCheck - untrusted file contents
 */
const validateUpdateCheck = (updateCheck: unknown): { updateCheck: UpdateCheckData; changed: boolean } => {
    if (!updateCheck) {
        // Add missing updateCheck structure
        return { updateCheck: { lastCheck: null, skipVersion: null }, changed: true };
    }
    const stored = updateCheck as Record<string, unknown>;
    // Each field is set below — to null or to a value its isValid accepted.
    const validUpdateCheck: Partial<Record<keyof UpdateCheckData, unknown>> = {};
    let changed = false;
    for (const { key, label, isValid, describe } of UPDATE_CHECK_FIELDS) {
        const value = stored[key];
        if (value === null || value === undefined) {
            validUpdateCheck[key] = null;
        } else if (isValid(value)) {
            validUpdateCheck[key] = value;
        } else {
            logger
                .withCategory(logger.CATEGORIES.UPDATE)
                .warning(`Invalid ${label} in metadata: ${describe(value)}, removing`, null);
            validUpdateCheck[key] = null;
            changed = true;
        }
    }
    return { updateCheck: validUpdateCheck as UpdateCheckData, changed };
};

/**
 * Validate every per-challenge entry into `validatedMetadata`.
 * @param metadata - Raw metadata (its updateCheck key is skipped)
 * @param validatedMetadata - Receives the kept (possibly repaired) entries
 * @returns True if any entry was dropped or repaired
 */
const validateChallengeEntries = (metadata: Record<string, unknown>, validatedMetadata: MetadataFile): boolean => {
    let changed = false;
    let removedCount = 0;
    for (const [challengeId, entry] of Object.entries(metadata)) {
        if (challengeId === 'updateCheck') continue;

        const validation = validateMetadataEntry(entry);
        if (!validation.isValid) {
            logger
                .withCategory('challenges')
                .warning(`Removing invalid metadata entry for challenge ${challengeId}: ${validation.reason}`);
            removedCount++;
            changed = true;
            continue;
        }
        // validation.entry is the repaired entry — identical to `entry` unless a
        // malformed entryIds snapshot was stripped off it.
        validatedMetadata[challengeId] = validation.entry as ChallengeMetadataEntry;
        if (validation.repairReason) {
            logger
                .withCategory('challenges')
                .warning(
                    `Dropping invalid entryIds snapshot for challenge ${oneLineId(challengeId)}: ${validation.repairReason}`,
                );
            changed = true;
        }
    }

    // Log summary if multiple entries were removed
    if (removedCount > 1) {
        logger.withCategory('api').warning(`Cleaned up ${removedCount} invalid metadata entries total`, null);
    }
    return changed;
};

/**
 * Validate entire metadata object
 * @param metadata - Metadata object to validate (untrusted file contents)
 */
const validateMetadata = (
    metadata: Record<string, unknown>,
): { validatedMetadata: MetadataFile; hasChanges: boolean } => {
    const { updateCheck, changed: updateCheckChanged } = validateUpdateCheck(metadata.updateCheck);
    const validatedMetadata: MetadataFile = { updateCheck };
    const entriesChanged = validateChallengeEntries(metadata, validatedMetadata);
    return { validatedMetadata, hasChanges: updateCheckChanged || entriesChanged };
};

/**
 * Load metadata from file
 * @returns Metadata object
 */
const loadMetadata = (): MetadataFile => {
    try {
        const metadataData = metadataStore.readRaw();

        if (metadataData) {
            const metadata: unknown = JSON.parse(metadataData);

            // Validate metadata; a file that is not a JSON object has nothing to keep.
            const { validatedMetadata, hasChanges } = validateMetadata(isPlainObject(metadata) ? metadata : {});

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
 * @param metadata - Metadata object to save
 * @returns True if successful, false otherwise
 */
const saveMetadata = (metadata: MetadataFile): boolean => {
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
 * @param challengeId - Challenge ID
 * @returns Metadata entry or null if not found
 */
const getChallengeMetadata = (challengeId: string | number): ChallengeMetadataEntry | null => {
    return challengeEntry(loadMetadata(), challengeId) || null;
};

/**
 * Set metadata for a specific challenge
 * @param challengeId - Challenge ID
 * @param lastVoteTime - ISO timestamp of last vote
 * @param exposureBump - Exposure level when vote occurred
 * @returns True if successful, false otherwise
 */
const setChallengeMetadata = (
    challengeId: string | number,
    lastVoteTime: string | undefined,
    exposureBump: number | undefined,
): boolean => {
    if (!challengeId) {
        logger.withCategory('challenges').error('Challenge ID is required', null);
        return false;
    }

    const entry: ChallengeMetadataEntry = {};

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
    const existing = challengeEntry(metadata, challengeId);
    metadata[challengeId] = existing ? { ...existing, ...entry } : entry;

    return saveMetadata(metadata);
};

/**
 * Update both last vote time and exposure bump for a challenge
 * @param challengeId - Challenge ID
 * @param exposure - Exposure level
 * @param timestamp - ISO timestamp (optional, defaults to now)
 * @returns True if successful, false otherwise
 */
const updateChallengeVoteMetadata = (
    challengeId: string | number,
    exposure: number,
    timestamp: string | null = null,
): boolean => {
    const voteTime = timestamp || new Date().toISOString();
    return setChallengeMetadata(challengeId, voteTime, exposure);
};

/**
 * True when two id lists hold the same members, regardless of order.
 * The server can reorder ranking.entries between polls (after a boost, or a
 * ranking resort) with no actual membership change, so every comparison on this
 * snapshot is a set comparison — a positional or JSON.stringify compare would
 * read a reorder as a change.
 */
const sameEntryIdSet = (a: string[] | null | undefined, b: string[] | null): boolean => {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    const setA = new Set(a);
    if (setA.size !== new Set(b).size) return false;
    return b.every((id) => setA.has(id));
};

/**
 * Read the persisted entry-id snapshot for a challenge (voteOnNewEntry).
 * @param challengeId - Challenge ID
 * @returns The stored ids, or null when none has ever been
 *   stored. `null` and `[]` are meaningfully different: `[]` means "seen, and the
 *   challenge had no entries", which is a valid baseline that must not fire.
 */
const getChallengeEntryIds = (challengeId: string): string[] | null => {
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
 * @param challengeId - Challenge ID
 * @param entryIds - Current entry ids
 * @returns True if successful (including the skipped-write case)
 */
const setChallengeEntryIds = (challengeId: string, entryIds: string[]): boolean => {
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
    const existing = challengeEntry(metadata, challengeId);
    if (existing && sameEntryIdSet(existing.entryIds, entryIds)) {
        return true; // Unchanged — skip the whole-file rewrite
    }

    metadata[challengeId] = { ...(existing || {}), entryIds };
    return saveMetadata(metadata);
};

/**
 * Clean up metadata for challenges that no longer exist
 * @param activeChallengeIds - Array of currently active challenge IDs
 * @returns True if cleanup was successful, false otherwise
 */
const cleanupStaleMetadata = (activeChallengeIds: string[]): boolean => {
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
        const lastVoteTime = challengeEntry(metadata, id)?.lastVoteTime;
        if (isStale && lastVoteTime) {
            const voteTime = new Date(lastVoteTime);
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
 * Get update check data
 */
const getUpdateCheckData = (): UpdateCheckData => {
    // loadMetadata() always validates/fills updateCheck, so no fallback needed.
    return loadMetadata().updateCheck;
};

/**
 * Set last update check timestamp
 * @param timestamp - Unix timestamp in milliseconds
 * @returns True if successful, false otherwise
 */
const setLastUpdateCheck = (timestamp: number): boolean => {
    if (typeof timestamp !== 'number' || timestamp <= 0) {
        logger.withCategory('update').error('Invalid timestamp provided for last update check', null);
        return false;
    }

    // loadMetadata() always validates/fills updateCheck.
    const metadata = loadMetadata();
    metadata.updateCheck.lastCheck = timestamp;
    return saveMetadata(metadata);
};

/**
 * Read the legacy metadata-resident skipVersion.
 * The canonical store is the settings blob (skipUpdateVersion);
 * AutoUpdater's one-shot migration reads this, persists it into settings,
 * verifies, and then calls clearLegacySkipVersion(). The field stays
 * accepted by validation so an old metadata.json round-trips untouched
 * until the migration has safely landed the value in settings.
 */
const getLegacySkipVersion = (): string | null => {
    const metadata = loadMetadata();
    return metadata.updateCheck?.skipVersion || null;
};

/**
 * Clear the legacy metadata-resident skipVersion after migration.
 */
const clearLegacySkipVersion = (): boolean => {
    const metadata = loadMetadata();
    if (!metadata.updateCheck?.skipVersion) return true;
    metadata.updateCheck.skipVersion = null;
    return saveMetadata(metadata);
};

export const initializeMetadataAsync = metadataStore.initializeAsync;
export const flushMetadataWrites = metadataStore.flushPendingWrites;
export {
    loadMetadata,
    saveMetadata,
    getChallengeMetadata,
    setChallengeMetadata,
    updateChallengeVoteMetadata,
    cleanupStaleMetadata,
    getChallengeEntryIds,
    setChallengeEntryIds,
    MAX_TRACKED_ENTRY_IDS,
    MAX_ENTRY_ID_LENGTH,
    getUpdateCheckData,
    setLastUpdateCheck,
    getLegacySkipVersion,
    clearLegacySkipVersion,
};
