/**
 * Pure scheduler helpers used by AutovoteContext. The interesting logic
 * here ("which challenge crosses its lastMinuteThreshold next?") doesn't
 * touch any of the context's refs, so it lives as a plain async function
 * — the context wraps it with the ref/interval bookkeeping.
 */

/**
 * Walk the active challenges and find the soonest one that will cross
 * its per-challenge `lastMinuteThreshold` boundary. Flash and already-
 * closed challenges are ignored. Returns null when nothing crosses
 * before its close_time.
 *
 * @param {Array} challenges - Active challenges from the API
 * @param {number} now       - Current Unix timestamp (seconds)
 * @returns {{challengeId, challengeTitle, entryTime, lastMinuteThreshold}|null}
 */
export async function calculateNextThresholdEntry(challenges, now) {
    // Filter first so flash / closed challenges don't waste IPC calls,
    // then fetch all per-challenge thresholds in parallel — sequential
    // awaits become N × IPC roundtrip on user accounts with many active
    // challenges, which slows scheduler responsiveness noticeably.
    const eligible = challenges.filter((c) => c.type !== 'flash' && c.close_time > now);
    const thresholds = await Promise.all(
        eligible.map((c) => window.api.getEffectiveSetting('lastMinuteThreshold', c.id.toString())),
    );

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
 * its per-challenge `lastMinuteThreshold` window. Mirrors the guards + threshold
 * lookup in `calculateNextThresholdEntry`, but tests "now" rather than a future
 * entry time — used by the context to decide when to leave the fixed last-minute
 * cadence and revert to the normal randomized cadence. (Parallel of
 * `runScheduler.js`'s `isAnyChallengeInThresholdWindow`.)
 *
 * @param {Array} challenges - Active challenges from the API
 * @param {number} now       - Current Unix timestamp (seconds)
 * @returns {Promise<boolean>}
 */
export async function isAnyChallengeInThresholdWindow(challenges, now) {
    const eligible = challenges.filter((c) => c.type !== 'flash' && c.close_time > now);
    const thresholds = await Promise.all(
        eligible.map((c) => window.api.getEffectiveSetting('lastMinuteThreshold', c.id.toString())),
    );
    return eligible.some((challenge, i) => challenge.close_time - now <= thresholds[i] * 60);
}
