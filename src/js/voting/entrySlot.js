// @ts-check
/**
 * Entry-slot addressing shared by every "which of my entries" setting
 * (turboImageIndex, boostImageIndex, autoSwapImageIndex). Pure and
 * dependency-free so both the Node-side rules and renderer-reachable modules
 * can use it.
 */

/**
 * Resolve a 1-indexed entry-index setting to the actual entries[] array slot.
 * Returns null ONLY for empty/non-array input; on any non-empty array, always
 * returns a valid integer slot in [0, entries.length - 1].
 *   - empty / non-array entries → null
 *   - non-integer or negative requestedIndex (corrupt settings, undefined reads)
 *     → slot 0 (first entry) rather than propagating NaN
 *   - 0 → last entry slot (sentinel)
 *   - positives → clamped to [0, entries.length - 1]
 *
 * @param {*} entries
 * @param {*} requestedIndex
 * @returns {number|null}
 */
const resolveEntryIndex = (entries, requestedIndex) => {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    if (!Number.isInteger(requestedIndex) || requestedIndex < 0) return 0;
    if (requestedIndex === 0) return entries.length - 1;
    return Math.min(entries.length - 1, requestedIndex - 1);
};

module.exports = { resolveEntryIndex };
