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
    let nextEntry = null;
    let earliestEntryTime = Infinity;

    for (const challenge of challenges) {
        if (challenge.type === 'flash' || challenge.close_time <= now) {
            continue;
        }

        const effectiveLastMinuteThreshold = await window.api.getEffectiveSetting(
            'lastMinuteThreshold',
            challenge.id.toString(),
        );
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
