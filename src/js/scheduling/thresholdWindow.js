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
 * for the part that actually drifts. `computeNextCycleDelayMs` builds on these
 * to make the whole per-cycle cadence decision in one place, so every host
 * (CLI `runScheduler.js`, GUI `AutovoteContext.jsx`, Android `headless/index.js`)
 * drives a single setTimeout/alarm chain off the same rule rather than each
 * carrying its own boundary-switch timer.
 *
 * @callback ResolveThreshold
 * @param {string} challengeId - Challenge id as a string.
 * @returns {number|Promise<number>} The effective lastMinuteThreshold (minutes).
 */

// Non-flash challenges that are still open at `now`. Flash challenges never
// enter last-minute mode, and closed ones can't.
const eligibleChallenges = (challenges, now) => challenges.filter((c) => c.type !== 'flash' && c.close_time > now);

/**
 * Resolve each eligible challenge's per-challenge threshold ONCE. Every
 * threshold question (in-window? next entry? next delay?) is then answered from
 * this single resolved snapshot — important because on the WebView each
 * `resolveThreshold` call is an IPC round-trip, and on Node it re-reads the
 * settings file, so resolving per-question would double the cost and could even
 * read two different `now`s mid-decision.
 *
 * @param {Array} challenges
 * @param {number} now - Unix timestamp (seconds)
 * @param {ResolveThreshold} resolveThreshold
 * @returns {Promise<{eligible:Array, thresholds:number[]}>}
 */
async function resolveEligibleThresholds(challenges, now, resolveThreshold) {
    const eligible = eligibleChallenges(challenges, now);
    const thresholds = await Promise.all(eligible.map((c) => resolveThreshold(c.id.toString())));
    return { eligible, thresholds };
}

// Pure decision helpers over an already-resolved (eligible, thresholds) snapshot.
const anyInWindow = (eligible, thresholds, now) => eligible.some((c, i) => c.close_time - now <= thresholds[i] * 60);

const soonestThresholdEntry = (eligible, thresholds, now) => {
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
                // Fall back to the id so a missing/empty title never logs as "undefined".
                challengeTitle: challenge.title || `challenge ${challenge.id}`,
                entryTime: thresholdEntryTime,
                lastMinuteThreshold: effectiveLastMinuteThreshold,
            };
        }
    }
    return nextEntry;
};

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
    const { eligible, thresholds } = await resolveEligibleThresholds(challenges, now, resolveThreshold);
    return soonestThresholdEntry(eligible, thresholds, now);
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
    const { eligible, thresholds } = await resolveEligibleThresholds(challenges, now, resolveThreshold);
    return anyInWindow(eligible, thresholds, now);
}

/**
 * Single source of cadence truth for every host. Decide how long to wait before
 * the next voting cycle so we never sleep past an upcoming last-minute boundary:
 *
 *   - any challenge already inside its window → fixed fast cadence
 *     (`lastMinuteCheckMinutes`), because deadline timing matters more than the
 *     anti-metronome randomness once we're in the final stretch;
 *   - otherwise the rolled random delay, but capped to the soonest *upcoming*
 *     threshold entry so the next cycle lands on the boundary instead of
 *     overshooting it;
 *   - a far-off boundary (further than one random delay) doesn't shorten the
 *     wait — we just poll at the normal cadence and re-evaluate next cycle, by
 *     which point the boundary is within a random delay and the cap kicks in.
 *
 * Every result is floored at `minGapMs` so an overrun / boundary-already-here
 * case can't busy-loop. Keeping this here (taking already-resolved scalars +
 * the same `resolveThreshold` callback the other helpers use) means the module
 * stays free of settings I/O and the decision is identical on all platforms.
 * Thresholds are resolved in a single pass and both questions (in-window? next
 * entry?) are answered from that one snapshot — no double resolution.
 *
 * @param {Array} challenges
 * @param {number} now - Unix timestamp (seconds)
 * @param {object} opts
 * @param {ResolveThreshold} opts.resolveThreshold
 * @param {number} opts.normalDelayMs - the random delay already rolled by the host
 * @param {number} opts.lastMinuteCheckMinutes - fixed last-minute cadence (minutes)
 * @param {number} opts.minGapMs - hard floor on the returned delay
 * @returns {Promise<{delayMs:number, mode:'last-minute'|'approaching'|'normal', nextEntry:(object|null)}>}
 */
async function computeNextCycleDelayMs(
    challenges,
    now,
    { resolveThreshold, normalDelayMs, lastMinuteCheckMinutes, minGapMs },
) {
    const { eligible, thresholds } = await resolveEligibleThresholds(challenges, now, resolveThreshold);

    if (anyInWindow(eligible, thresholds, now)) {
        return { delayMs: Math.max(minGapMs, lastMinuteCheckMinutes * 60_000), mode: 'last-minute', nextEntry: null };
    }

    const nextEntry = soonestThresholdEntry(eligible, thresholds, now);
    if (nextEntry) {
        const msUntilEntry = (nextEntry.entryTime - now) * 1000;
        if (msUntilEntry < normalDelayMs) {
            return { delayMs: Math.max(minGapMs, msUntilEntry), mode: 'approaching', nextEntry };
        }
    }

    return { delayMs: normalDelayMs, mode: 'normal', nextEntry };
}

module.exports = { calculateNextThresholdEntry, isAnyChallengeInThresholdWindow, computeNextCycleDelayMs };
