// @ts-check
/**
 * Boost/turbo entry selection: which entry a boost or turbo lands on, never
 * sharing one, and how a boost sources its entry when every candidate is
 * taken. Part of the services/VotingLogic facade.
 */

// Cast to any at the boundary: the settings facade isn't `// @ts-check`ed yet,
// and its `challengeId = null` defaults make TS infer param types too narrow
// (null) to accept the string IDs passed here. Drop the cast once settings.js
// is typed.
const settings = /** @type {any} */ (require('../../settings'));
// 0 = last / 1-4 = slot addressing, shared with the swap automation.
const { resolveEntryIndex } = require('../../voting/entrySlot');

/**
 * Pick the entry at the configured 1-indexed slot, falling back to the
 * entry one position earlier (wrapping past slot 0 to the last entry)
 * if the configured entry already has the conflicting action applied.
 *
 * GuruShots permits at most one turbo and one boost per challenge, on
 * different entries. So when boost is picking an entry it must avoid the
 * turboed one (conflictField='turbo'); when turbo is picking it must avoid
 * the boosted one (conflictField='boosted'). A single-step backward fallback
 * is always sufficient — unless the challenge has only one entry and that
 * one is already in the conflicting state, in which case returns null.
 *
 * @param {*} entries
 * @param {*} requestedIndex
 * @param {string} conflictField
 * @returns {*}
 */
const pickEntryAvoidingConflict = (entries, requestedIndex, conflictField) => {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    // Non-empty array guaranteed above, so resolveEntryIndex returns a number.
    let slot = /** @type {number} */ (resolveEntryIndex(entries, requestedIndex));
    if (entries[slot]?.[conflictField]) {
        slot = (slot - 1 + entries.length) % entries.length;
    }
    return entries[slot]?.[conflictField] ? null : entries[slot];
};

/**
 * Pick the entry a boost should land on: `boostImageIndex` (1-indexed, 0 = last), stepping
 * off any entry that already carries turbo. Symmetric to shouldApplyTurbo's own pick, which
 * avoids boosted entries.
 *
 * Lives here rather than privately inside api/boost.js so the mock boost surface resolves the
 * SAME entry the real one does. Both then raise the conflict flag on it, which is what keeps
 * the same-pass "boost and turbo never share an entry" rule true in mock mode too — the mock
 * runs the identical shared voting pass, so a rule that only held on the real surface would
 * make mock runs quietly diverge.
 *
 * @param {any} challenge
 * @param {string} challengeId
 * @returns {any|null} the entry to boost, or null when every candidate is turboed
 */
const pickBoostEntry = (challenge, challengeId) => {
    const entries = challenge?.member?.ranking?.entries;
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const requestedIndex = settings.getEffectiveSetting('boostImageIndex', challengeId);
    return pickEntryAvoidingConflict(entries, requestedIndex, 'turbo');
};

/**
 * Resolves how a boost should source its target entry for a challenge:
 * - `'always'`  — `boostFillNew` is on: always submit a fresh photo and boost it.
 * - `'conflict'` — `boostFillNewOnConflict` is on AND the only existing entry is
 *   already turboed (so Boost cannot be placed on any existing entry): submit a
 *   fresh photo purely to break that boost/turbo conflict.
 * - `'no'` — boost an existing entry the normal way.
 *
 * `boostFillNew` (always) takes precedence over `boostFillNewOnConflict`, and the
 * conflict mode only engages when the conflict actually exists — mirroring the
 * `!picked` branch in {@link shouldApplyTurbo}, where picker-null with at least
 * one entry means the single entry carries the other feature's flag.
 *
 * @param {any} challenge
 * @param {string} challengeId
 * @returns {'always'|'conflict'|'no'}
 */
const resolveBoostFillNewMode = (challenge, challengeId) => {
    if (settings.getEffectiveSetting('boostFillNew', challengeId) === true) return 'always';
    if (settings.getEffectiveSetting('boostFillNewOnConflict', challengeId) === true) {
        const entries = challenge?.member?.ranking?.entries;
        if (Array.isArray(entries) && entries.length >= 1 && pickBoostEntry(challenge, challengeId) === null) {
            return 'conflict';
        }
    }
    return 'no';
};

module.exports = {
    pickEntryAvoidingConflict,
    pickBoostEntry,
    resolveBoostFillNewMode,
};
