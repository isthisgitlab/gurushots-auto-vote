/**
 * GUI-side (WebView) resolvers for the shared cadence math
 * (src/js/scheduling/thresholdWindow.js), the async-IPC counterpart of
 * src/js/scheduling/nodeResolvers.js: per-challenge values come back over
 * window.api.getEffectiveSetting instead of the synchronous settings facade.
 * AutovoteContext injects these into the shared cadence chain
 * (src/js/scheduling/cadenceChain.js) so the loop and math are written once.
 */

import { computeNextCycleDelayMs as computeNextDelayMs } from '../../scheduling/thresholdWindow';

// WebView resolver: per-challenge lastMinuteThreshold over IPC (Promise).
export const resolveThreshold = (challengeId) => window.api.getEffectiveSetting('lastMinuteThreshold', challengeId);

// WebView resolver for the scheduled-fill cadence cap: the three per-challenge
// keys over the same key-agnostic IPC channel, batched per challenge. Both
// trigger values are LISTS, passed RAW — scheduledFill.js owns the guards
// (no Number() coercion: Number([a, b]) is NaN and would silently disable the
// cap for multi-entry configs).
export const resolveScheduledFill = async (challengeId) => {
    const [enabled, timesOfDay, beforeEndSecs] = await Promise.all([
        window.api.getEffectiveSetting('useScheduledFill', challengeId),
        window.api.getEffectiveSetting('scheduledFillTime', challengeId),
        window.api.getEffectiveSetting('scheduledFillBeforeEnd', challengeId),
    ]);
    return { enabled: enabled === true, timesOfDay, beforeEndSecs };
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
