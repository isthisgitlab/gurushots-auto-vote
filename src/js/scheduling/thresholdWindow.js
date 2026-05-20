/**
 * Shared last-minute threshold math for both voting schedulers.
 *
 * `runScheduler.js` (CLI/Android) and `autovoteScheduler.js` (React GUI) each
 * used to carry their own copy of "which challenge crosses its
 * lastMinuteThreshold next?" and "is any challenge in its window now?". The
 * only real difference was how a per-challenge threshold gets resolved:
 *   - Node:    settings.getEffectiveSetting('lastMinuteThreshold', id)  (sync)
 *   - WebView: window.api.getEffectiveSetting('lastMinuteThreshold', id) (async)
 *
 * So the math lives here once and takes a `resolveThreshold(idString)`
 * function that may return a number or a Promise<number>; both consumers wrap
 * it with their platform's resolver. This removes the "fix BOTH" duplication
 * for the part that actually drifts. The timer engines (node-cron vs
 * setInterval) stay platform-specific — they legitimately differ.
 *
 * @callback ResolveThreshold
 * @param {string} challengeId - Challenge id as a string.
 * @returns {number|Promise<number>} The effective lastMinuteThreshold (minutes).
 */

// Non-flash challenges that are still open at `now`. Flash challenges never
// enter last-minute mode, and closed ones can't.
const eligibleChallenges = (challenges, now) => challenges.filter((c) => c.type !== 'flash' && c.close_time > now);

/**
 * Find the soonest challenge that will cross its per-challenge
 * `lastMinuteThreshold` boundary after `now`. Returns null when none will.
 *
 * @param {Array} challenges
 * @param {number} now - Unix timestamp (seconds)
 * @param {ResolveThreshold} resolveThreshold
 * @returns {Promise<{challengeId, challengeTitle, entryTime, lastMinuteThreshold}|null>}
 */
async function calculateNextThresholdEntry(challenges, now, resolveThreshold) {
    const eligible = eligibleChallenges(challenges, now);
    const thresholds = await Promise.all(eligible.map((c) => resolveThreshold(c.id.toString())));

    let nextEntry = null;
    let earliestEntryTime = Infinity;

    for (let i = 0; i < eligible.length; i++) {
        const challenge = eligible[i];
        const effectiveLastMinuteThreshold = thresholds[i];
        const thresholdEntryTime = challenge.close_time - effectiveLastMinuteThreshold * 60;

        if (thresholdEntryTime > now && thresholdEntryTime < earliestEntryTime) {
            earliestEntryTime = thresholdEntryTime;
            nextEntry = {
                challengeId: challenge.id,
                challengeTitle: challenge.title,
                entryTime: thresholdEntryTime,
                lastMinuteThreshold: effectiveLastMinuteThreshold,
            };
        }
    }

    return nextEntry;
}

/**
 * True when at least one non-flash, still-open challenge is currently inside
 * its per-challenge `lastMinuteThreshold` window (inclusive boundary). Used to
 * decide when to leave the fixed last-minute cadence and revert to normal.
 *
 * @param {Array} challenges
 * @param {number} now - Unix timestamp (seconds)
 * @param {ResolveThreshold} resolveThreshold
 * @returns {Promise<boolean>}
 */
async function isAnyChallengeInThresholdWindow(challenges, now, resolveThreshold) {
    const eligible = eligibleChallenges(challenges, now);
    const thresholds = await Promise.all(eligible.map((c) => resolveThreshold(c.id.toString())));
    return eligible.some((challenge, i) => challenge.close_time - now <= thresholds[i] * 60);
}

module.exports = { calculateNextThresholdEntry, isAnyChallengeInThresholdWindow };
