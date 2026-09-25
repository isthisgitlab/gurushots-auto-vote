// @ts-check
/**
 * Scenario durations: plain seconds (a non-negative integer) or a string of
 * `<number><unit>` parts — `"90m"`, `"5d"`, `"1d 6h"`, `"4m 30s"` — so a
 * hand-written scenario never needs 432000. Dependency-free: the validator,
 * the engine and (later) the renderer's builder all read durations the same
 * way.
 */

/** Longest duration a scenario may express — exhibitions run ~21.5 days. */
const MAX_DURATION_SEC = 60 * 24 * 60 * 60;

const UNIT_SEC = { d: 86400, h: 3600, m: 60, s: 1 };
const DURATION_PATTERN = /^\s*(?:\d+\s*[dhms]\s*)+$/i;
const PART_PATTERN = /(\d+)\s*([dhms])/gi;

/**
 * Seconds for a duration value, or null when it is not a valid duration
 * (wrong type, negative, fractional, malformed string, or beyond
 * MAX_DURATION_SEC).
 *
 * @param {unknown} value
 * @returns {number|null}
 */
const parseDuration = (value) => {
    let seconds = null;
    if (typeof value === 'number') {
        seconds = Number.isInteger(value) && value >= 0 ? value : null;
    } else if (typeof value === 'string' && DURATION_PATTERN.test(value)) {
        seconds = 0;
        for (const [, amount, unit] of value.matchAll(PART_PATTERN)) {
            seconds += Number(amount) * UNIT_SEC[/** @type {'d'|'h'|'m'|'s'} */ (unit.toLowerCase())];
        }
    }
    return seconds !== null && seconds <= MAX_DURATION_SEC ? seconds : null;
};

module.exports = { parseDuration, MAX_DURATION_SEC };
