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
    return entries
        .map((entry) => (entry?.id == null ? '' : String(entry.id)))
        .filter((id) => id.length > 0 && id !== 'undefined' && id !== 'null');
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
 * @typedef {{get: (challengeId: string) => string[]|null, set: (challengeId: string, ids: string[]) => void}} EntryTracker
 */

/**
 * Tracker backed by metadata.json — the real strategy.
 * @returns {EntryTracker}
 */
const createMetadataEntryTracker = () => ({
    get: (challengeId) => metadata.getChallengeEntryIds(challengeId),
    set: (challengeId, ids) => {
        metadata.setChallengeEntryIds(challengeId, ids);
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
    createMetadataEntryTracker,
    createMemoryEntryTracker,
};
