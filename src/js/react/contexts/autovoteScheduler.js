/**
 * Thin GUI wrapper over the shared last-minute threshold math
 * (src/js/scheduling/thresholdWindow.js). The only GUI-specific piece is the
 * threshold resolver: in the WebView per-challenge thresholds come back
 * asynchronously over IPC (window.api.getEffectiveSetting). The math itself is
 * shared with runScheduler.js (CLI/Android) so a cadence change is made once.
 */

import { computeNextCycleDelayMs as computeNextDelayMs } from '../../scheduling/thresholdWindow';

// WebView resolver: per-challenge lastMinuteThreshold over IPC (Promise).
const resolveThreshold = (challengeId) => window.api.getEffectiveSetting('lastMinuteThreshold', challengeId);

// WebView resolver for the scheduled-fill cadence cap: the three per-challenge
// keys over the same key-agnostic IPC channel, batched per challenge.
const resolveScheduledFill = async (challengeId) => {
    const [enabled, timeOfDay, beforeEndSec] = await Promise.all([
        window.api.getEffectiveSetting('useScheduledFill', challengeId),
        window.api.getEffectiveSetting('scheduledFillTime', challengeId),
        window.api.getEffectiveSetting('scheduledFillBeforeEnd', challengeId),
    ]);
    return { enabled: enabled === true, timeOfDay, beforeEndSec: Number(beforeEndSec) || 0 };
};

/**
 * Delay (ms) until the next voting cycle, using the shared decision: fast fixed
 * cadence while in-window, otherwise the rolled random delay capped to the
 * soonest upcoming threshold entry or scheduled-fill window start. The host
 * rolls `normalDelayMs` and resolves `lastMinuteCheckMinutes` and `timezone`
 * (over IPC) and passes them in.
 * @param {Array} challenges
 * @param {number} now - Unix timestamp (seconds)
 * @param {{normalDelayMs:number, lastMinuteCheckMinutes:number, minGapMs:number, timezone?:(string|null)}} opts
 * @returns {Promise<{delayMs:number, mode:'last-minute'|'approaching'|'scheduled'|'normal', nextEntry:(object|null), nextScheduled:(object|null)}>}
 */
export async function computeNextCycleDelayMs(
    challenges,
    now,
    { normalDelayMs, lastMinuteCheckMinutes, minGapMs, timezone = null },
) {
    return computeNextDelayMs(challenges, now, {
        resolveThreshold,
        normalDelayMs,
        lastMinuteCheckMinutes,
        minGapMs,
        resolveScheduledFill,
        timezone,
    });
}
