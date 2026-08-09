// @ts-check
/**
 * New-entry detection for the `voteOnNewEntry` setting.
 *
 * A challenge's exposure is diluted the moment a new photo lands in it, but the
 * exposure_factor the API reports does not necessarily reflect that on the same
 * poll — so the normal threshold rule sees "already at target" and skips, and the
 * fresh entry sits without exposure until some later cycle catches the drop.
 * Detecting the entry itself closes that gap.
 *
 * There is no other cross-poll entry state in the app: autoFill.reflectNewEntry
 * mutates the pass-local challenge object and is discarded at end of cycle. So
 * detection needs a snapshot that survives the pass, which is what the tracker
 * pair below provides.
 *
 * Every comparison here is over SETS, never positions. The server can reorder
 * member.ranking.entries between polls (after a boost, or a ranking resort) with no
 * membership change at all; a positional compare would read that as a new entry and
 * force a vote on every cycle.
 */

const metadata = require('../metadata');
const logger = require('../logger');

// metadata owns these (it enforces them at persistence time); read them here so the
// pre-persistence bound can't drift from the write-side one.
//
// The fallback exists because `id.length <= undefined` is false for EVERY id, so a
// missing import would silently discard whole snapshots rather than bound them. It
// falls back to a real number rather than Infinity: this bound is the DoS guard for
// an oversized remote response, and failing open would quietly undo it. Only a
// broken import can reach this (both values are static literals in metadata), so it
// also warns — a silent degrade here would be invisible until it mattered.
const FALLBACK_ENTRY_ID_CAP = 64;
/** @param {*} value @param {string} name @returns {number} */
const finiteCap = (value, name) => {
    if (Number.isFinite(value)) return value;
    logger
        .withCategory('challenges')
        .warning(`metadata.${name} is not a finite number; falling back to ${FALLBACK_ENTRY_ID_CAP}`, null);
    return FALLBACK_ENTRY_ID_CAP;
};
const MAX_TRACKED_ENTRY_IDS = finiteCap(metadata.MAX_TRACKED_ENTRY_IDS, 'MAX_TRACKED_ENTRY_IDS');
const MAX_ENTRY_ID_LENGTH = finiteCap(metadata.MAX_ENTRY_ID_LENGTH, 'MAX_ENTRY_ID_LENGTH');

// Challenge ids come from the API, so every bare-id interpolation below is
// CR/LF-collapsed first. Imported from format/logSafe rather than taken off the
// logger: the logger is mocked in much of the suite, and a sanitizer that vanishes
// under a mock stops being exercised exactly where it is asserted.
const { oneLine: oneLineId } = require('../format/logSafe');

/**
 * Extract the current entry ids from a challenge.
 *
 * Ids are filtered, not just coerced: a null/undefined id must not become the
 * literal string "undefined" and pollute the diff set (it would also trip the
 * metadata validator later and cost the whole snapshot).
 *
 * @param {any} challenge
 * @returns {string[]|null} - null when the challenge carries no usable entries
 *   array at all, which means "don't track this one" rather than "no entries".
 */
const readEntryIds = (challenge) => {
    const entries = challenge?.member?.ranking?.entries;
    if (!Array.isArray(entries)) return null;
    // Bound the work BEFORE doing it, not just at persistence time. This runs every
    // poll on the Electron main process, and metadata's write-side caps would reject
    // an oversized payload only after the map/filter/Set traversal had already
    // happened — and reject it every cycle, since a rejected snapshot never settles.
    // Real max_photo_submits is single-digit, so the caps are far above anything
    // legitimate; they only bound a malformed or hostile response.
    return entries
        .slice(0, MAX_TRACKED_ENTRY_IDS)
        .map((entry) => (entry?.id == null ? '' : String(entry.id)))
        .filter((id) => id.length > 0 && id.length <= MAX_ENTRY_ID_LENGTH && id !== 'undefined' && id !== 'null');
};

/**
 * True when `currentIds` contains at least one id absent from `previousIds`.
 *
 * A null `previousIds` means this challenge has never been tracked, and returns
 * false: "no snapshot" carries no information, and firing there would mean voting
 * on every pre-existing entry of every challenge. Note this guard does NOT cover
 * re-enabling the setting after a disable — that path finds a stale snapshot rather
 * than null and fires once, by design.
 *
 * Removals alone are not new entries; a same-size swap is.
 *
 * @param {string[]|null} previousIds
 * @param {string[]} currentIds
 * @returns {boolean}
 */
const hasNewEntries = (previousIds, currentIds) => {
    if (!Array.isArray(previousIds)) return false;
    if (!Array.isArray(currentIds)) return false;
    const previous = new Set(previousIds);
    return currentIds.some((id) => !previous.has(id));
};

/**
 * Whether the current ids are safe to persist as the new baseline.
 *
 * Guards one specific corruption: a poll that returns an EMPTY entries array for a
 * challenge that previously had entries. Nothing upstream distinguishes "the user
 * really removed every photo" from a partial/degraded API response, and recording
 * the empty array would poison the baseline — the unchanged entries would come back
 * looking brand new on the very next poll and force a spurious vote.
 *
 * Keeping the older, non-empty baseline is strictly safer in both readings: after a
 * transient blip the same ids reappear and correctly read as "nothing new", and
 * after a genuine deletion any photo added later is still genuinely absent from the
 * stored set, so it fires exactly as it should.
 *
 * @param {string[]|null} previousIds
 * @param {string[]} currentIds
 * @returns {boolean}
 */
const shouldRecordSnapshot = (previousIds, currentIds) => {
    if (!Array.isArray(currentIds)) return false;
    if (currentIds.length > 0) return true;
    // currentIds is empty — only trust it when there is nothing better stored.
    return !Array.isArray(previousIds) || previousIds.length === 0;
};

/**
 * @typedef {{get: (challengeId: string) => string[]|null, set: (challengeId: string, ids: string[]) => void}} EntryTracker
 */

/**
 * Tracker backed by metadata.json — the real strategy.
 * @returns {EntryTracker}
 */
const createMetadataEntryTracker = () => ({
    get: (challengeId) => metadata.getChallengeEntryIds(challengeId),
    set: (challengeId, ids) => {
        // A dropped write leaves the trigger armed, so the next pass re-fires the
        // same forced vote — worth a line rather than swallowing the boolean, even
        // though saveMetadata logs its own errors.
        if (!metadata.setChallengeEntryIds(challengeId, ids)) {
            logger
                .withCategory('challenges')
                .warning(`Could not persist entry snapshot for challenge ${oneLineId(challengeId)}`, null);
        }
    },
});

/**
 * In-memory tracker — the mock strategy.
 *
 * Mock mode must NOT write to metadata.json: the store is shared and un-namespaced
 * between real and mock, mock challenge ids never match real ones, and mock passes
 * cleanupStaleMetadata: null — so mock snapshots would accumulate in the user's real
 * metadata file and never be pruned. Same reasoning as the cleanupStaleMetadata
 * split documented in votingOrchestrator.
 *
 * @returns {EntryTracker}
 */
const createMemoryEntryTracker = () => {
    /** @type {Map<string, string[]>} */
    const store = new Map();
    return {
        get: (challengeId) => (store.has(challengeId) ? /** @type {string[]} */ (store.get(challengeId)) : null),
        set: (challengeId, ids) => {
            store.set(challengeId, [...ids]);
        },
    };
};

module.exports = {
    readEntryIds,
    hasNewEntries,
    shouldRecordSnapshot,
    createMetadataEntryTracker,
    createMemoryEntryTracker,
};
