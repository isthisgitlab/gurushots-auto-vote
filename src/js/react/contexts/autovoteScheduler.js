/**
 * Thin GUI wrappers over the shared last-minute threshold math
 * (src/js/scheduling/thresholdWindow.js). The only GUI-specific piece is the
 * threshold resolver: in the WebView per-challenge thresholds come back
 * asynchronously over IPC (window.api.getEffectiveSetting). The math itself is
 * shared with runScheduler.js (CLI/Android) so a cadence change is made once.
 *
 * These keep the `(challenges, now)` signatures AutovoteContext already calls.
 */

import {
    calculateNextThresholdEntry as calcNextThresholdEntry,
    isAnyChallengeInThresholdWindow as anyChallengeInThresholdWindow,
    computeNextCycleDelayMs as computeNextDelayMs,
} from '../../scheduling/thresholdWindow';

// WebView resolver: per-challenge lastMinuteThreshold over IPC (Promise).
const resolveThreshold = (challengeId) => window.api.getEffectiveSetting('lastMinuteThreshold', challengeId);

/**
 * Soonest challenge to cross its per-challenge lastMinuteThreshold boundary.
 * @param {Array} challenges - Active challenges from the API
 * @param {number} now       - Current Unix timestamp (seconds)
 * @returns {Promise<{challengeId, challengeTitle, entryTime, lastMinuteThreshold}|null>}
 */
export async function calculateNextThresholdEntry(challenges, now) {
    return calcNextThresholdEntry(challenges, now, resolveThreshold);
}

/**
 * True when at least one non-flash, still-open challenge is currently inside
 * its per-challenge lastMinuteThreshold window.
 * @param {Array} challenges - Active challenges from the API
 * @param {number} now       - Current Unix timestamp (seconds)
 * @returns {Promise<boolean>}
 */
export async function isAnyChallengeInThresholdWindow(challenges, now) {
    return anyChallengeInThresholdWindow(challenges, now, resolveThreshold);
}

/**
 * Delay (ms) until the next voting cycle, using the shared decision: fast fixed
 * cadence while in-window, otherwise the rolled random delay capped to the
 * soonest upcoming threshold entry. The host rolls `normalDelayMs` and resolves
 * `lastMinuteCheckMinutes` (over IPC) and passes them in.
 * @param {Array} challenges
 * @param {number} now - Unix timestamp (seconds)
 * @param {{normalDelayMs:number, lastMinuteCheckMinutes:number, minGapMs:number}} opts
 * @returns {Promise<{delayMs:number, mode:'last-minute'|'approaching'|'normal', nextEntry:(object|null)}>}
 */
export async function computeNextCycleDelayMs(challenges, now, { normalDelayMs, lastMinuteCheckMinutes, minGapMs }) {
    return computeNextDelayMs(challenges, now, { resolveThreshold, normalDelayMs, lastMinuteCheckMinutes, minGapMs });
}
