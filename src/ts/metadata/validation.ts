import * as logger from '../logger';
// Challenge ids come from the GuruShots API, so collapse CR/LF before interpolating
// one into a message. These carry a bare id rather than the full `[Challenge …]`
// tag, so they use the shared helper directly instead of logger.challengeTag.
import { oneLine as oneLineId } from '../format/logSafe';

import type { ChallengeMetadataEntry, MetadataFile, UpdateCheckData } from '../types/stores';

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

export { MAX_TRACKED_ENTRY_IDS, MAX_ENTRY_ID_LENGTH, isUnsafeChallengeKey, entryIdsFailureReason, validateMetadata };
