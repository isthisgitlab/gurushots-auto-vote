// @ts-check
/**
 * Rule math for the currency automation (automatic KEY unlock, photo SWAP and
 * exposure FILL). Pure and dependency-free — no settings, no services — so the
 * Node runners (services/currencyAuto.js), the scheduler's wake-up cap
 * (scheduling/thresholdWindow.js) and any renderer view all answer "is this rule
 * open?" identically.
 *
 * A rule's timing is up to three optional conditions, each 0 = off:
 *   - afterStartSec  — at least this long after the challenge started
 *   - beforeEndSec   — at most this long before it closes
 *   - afterPercent   — at least this percent of its length has run
 * Every condition that is set must hold (AND). With none set the rule is open
 * for the whole challenge. The rule opens at the LATEST of the set conditions'
 * instants and stays open until close_time.
 */

const { resolveEntryIndex } = require('./entrySlot');

/**
 * @typedef {{afterStartSec?: number, beforeEndSec?: number, afterPercent?: number}} RuleTiming
 */

/** @param {unknown} value */
const positive = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Unix second at which the rule opens, or null when it can never be decided —
 * a condition needs start_time / close_time and the payload lacks it. Fail
 * closed: spending currency on a challenge whose clock can't be read would be
 * exactly the blanket spend the timing conditions exist to prevent.
 *
 * @param {any} challenge
 * @param {RuleTiming} timing
 * @returns {number|null}
 */
const ruleOpensAt = (challenge, timing) => {
    const start = Number(challenge?.start_time);
    const close = Number(challenge?.close_time);
    const hasStart = Number.isFinite(start);
    const hasClose = Number.isFinite(close);
    const afterStartSec = positive(timing?.afterStartSec);
    const beforeEndSec = positive(timing?.beforeEndSec);
    const afterPercent = Math.min(positive(timing?.afterPercent), 99);

    let opens = hasStart ? start : -Infinity;
    if (afterStartSec > 0) {
        if (!hasStart) return null;
        opens = Math.max(opens, start + afterStartSec);
    }
    if (beforeEndSec > 0) {
        if (!hasClose) return null;
        opens = Math.max(opens, close - beforeEndSec);
    }
    if (afterPercent > 0) {
        if (!hasStart || !hasClose || close <= start) return null;
        opens = Math.max(opens, start + ((close - start) * afterPercent) / 100);
    }
    return opens;
};

/**
 * True while the rule is open: on or after its opening instant and before the
 * challenge closes.
 *
 * @param {any} challenge
 * @param {RuleTiming} timing
 * @param {number} nowSec
 * @returns {boolean}
 */
const isRuleOpen = (challenge, timing, nowSec) => {
    const opens = ruleOpensAt(challenge, timing);
    if (opens === null || nowSec < opens) return false;
    const close = Number(challenge?.close_time);
    return !Number.isFinite(close) || nowSec < close;
};

/**
 * An entry carrying a boost or turbo. Swapping it out moves the boost/turbo
 * off the challenge's scoreboard photo, so the automation avoids it unless the
 * user allows it.
 *
 * @param {any} entry
 * @returns {boolean}
 */
const isProtectedEntry = (entry) => entry?.boosted === true || entry?.boosting === true || entry?.turbo === true;

/**
 * The entry an automatic swap should replace, or null when none qualifies.
 *
 *   - lowestVotes: the candidate with the fewest votes (ties → the later slot,
 *     the more recent photo); otherwise the configured slot (imageIndex: 1-4, 0 =
 *     last), stepping backward (wrapping) past protected entries.
 *   - allowProtected: when false, boosted/turbo'd entries are never picked.
 *   - maxVotes > 0: the picked entry must have fewer votes than this.
 *
 * @param {any} entries
 * @param {{imageIndex?: number, lowestVotes?: boolean, allowProtected?: boolean, maxVotes?: number}} options
 * @returns {any|null}
 */
const pickSwapTarget = (entries, { imageIndex = 0, lowestVotes = false, allowProtected = false, maxVotes = 0 }) => {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    /** @param {any} entry */
    const eligible = (entry) => entry && (allowProtected || !isProtectedEntry(entry));
    /** @param {any} entry */
    const votesOf = (entry) => {
        const votes = Number(entry?.votes);
        return Number.isFinite(votes) ? votes : 0;
    };

    let target = null;
    if (lowestVotes) {
        for (const entry of entries) {
            if (eligible(entry) && (target === null || votesOf(entry) <= votesOf(target))) target = entry;
        }
    } else {
        const start = /** @type {number} */ (resolveEntryIndex(entries, imageIndex));
        for (let step = 0; step < entries.length; step++) {
            const entry = entries[(start - step + entries.length) % entries.length];
            if (eligible(entry)) {
                target = entry;
                break;
            }
        }
    }
    if (target === null) return null;
    const ceiling = positive(maxVotes);
    return ceiling > 0 && votesOf(target) >= ceiling ? null : target;
};

/**
 * The exposure voting can reach this cycle: the pool's starting exposure plus
 * the ratio of every distinct image in it — the same walk submitVotes does.
 * Null when there is no readable pool (no images, or no exposure figure).
 *
 * @param {any} voteImages - the getVoteImages response
 * @returns {number|null}
 */
const votePoolReach = (voteImages) => {
    const start = Number(voteImages?.voting?.exposure?.exposure_factor);
    const images = voteImages?.images;
    if (!Number.isFinite(start) || !Array.isArray(images) || images.length === 0) return null;
    const seen = new Set();
    let reach = start;
    for (const image of images) {
        if (!image || seen.has(image.id)) continue;
        seen.add(image.id);
        const ratio = Number(image.ratio);
        if (Number.isFinite(ratio)) reach += ratio;
    }
    return reach;
};

/**
 * Whether an exposure FILL is worth spending: exposure is below the threshold
 * AND voting cannot lift it back there. `reach` is votePoolReach (null = no
 * pool, so voting can reach nothing beyond the current exposure).
 *
 * @param {number} exposure - current exposure_factor
 * @param {number|null} reach
 * @param {number} belowPct - the fill threshold
 * @returns {boolean}
 */
const fillBeatsVoting = (exposure, reach, belowPct) => {
    const current = Number(exposure);
    const threshold = Number(belowPct);
    if (!Number.isFinite(current) || !Number.isFinite(threshold)) return false;
    if (current >= threshold) return false;
    const reachable = reach === null ? current : reach;
    return reachable < threshold;
};

module.exports = { ruleOpensAt, isRuleOpen, isProtectedEntry, pickSwapTarget, votePoolReach, fillBeatsVoting };
