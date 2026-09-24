/**
 * GUI-side (WebView) resolvers for the shared cadence math
 * (src/js/scheduling/thresholdWindow.js), the async-IPC counterpart of
 * src/js/scheduling/nodeResolvers.js: per-challenge values come back over
 * the getEffectiveSetting IPC channel (react/api/ipc.js) instead of the synchronous settings facade.
 * AutovoteContext injects these into the shared cadence chain
 * (src/js/scheduling/cadenceChain.js) so the loop and math are written once.
 */

import { computeNextCycleDelayMs as computeNextDelayMs } from '../../scheduling/thresholdWindow';
import * as ipc from '../api/ipc';

// WebView resolver: per-challenge lastMinuteThreshold over IPC (Promise).
export const resolveThreshold = (challengeId) => ipc.getEffectiveSetting('lastMinuteThreshold', challengeId);

// WebView resolver for the scheduled-fill cadence cap: the three per-challenge
// keys over the same key-agnostic IPC channel, batched per challenge. Both
// trigger values are LISTS, passed RAW — scheduledFill.js owns the guards
// (no Number() coercion: Number([a, b]) is NaN and would silently disable the
// cap for multi-entry configs).
export const resolveScheduledFill = async (challengeId) => {
    const [enabled, timesOfDay, beforeEndSecs] = await Promise.all([
        ipc.getEffectiveSetting('useScheduledFill', challengeId),
        ipc.getEffectiveSetting('scheduledFillTime', challengeId),
        ipc.getEffectiveSetting('scheduledFillBeforeEnd', challengeId),
    ]);
    return { enabled: enabled === true, timesOfDay, beforeEndSecs };
};

// WebView resolver for the pre-final-window top-up cadence cap: the per-challenge
// keys over IPC, batched. Enabled only when BOTH the final-window feature and this
// opt-in are on — matching nodeResolvers.js and the rule engine's gate. durationSec
// is the configurable final-window length; thresholdWindow.js re-guards it.
export const resolveFinalWindowTopUp = async (challengeId) => {
    const [voteBeforeFinalWindow, useFinalWindowExposure, leadMin, durationSec] = await Promise.all([
        ipc.getEffectiveSetting('voteBeforeFinalWindow', challengeId),
        ipc.getEffectiveSetting('useFinalWindowExposure', challengeId),
        ipc.getEffectiveSetting('voteBeforeFinalWindowLeadMin', challengeId),
        ipc.getEffectiveSetting('finalWindowDuration', challengeId),
    ]);
    return {
        enabled: voteBeforeFinalWindow === true && useFinalWindowExposure === true,
        leadSec: Number(leadMin) * 60,
        durationSec: Number(durationSec),
    };
};

// WebView resolver for the pre-boost fill cadence cap: the per-challenge keys over
// IPC, batched. Enabled only when the opt-in and autoBoost are on AND onlyBoost is
// off — matching nodeResolvers.js and the rule engine's gate (onlyBoost blocks every
// vote ahead of the pre-boost branch, so waking for it could only no-op). Both boost
// windows go through as numbers; thresholdWindow.js computes the apply instant from
// live boost state and re-guards the `0 = off` sentinel.
export const resolveBoostPrefill = async (challengeId) => {
    const [voteBeforeBoost, autoBoost, onlyBoost, leadMin, boostTime, keyUnlockedBoostTime] = await Promise.all([
        ipc.getEffectiveSetting('voteBeforeBoost', challengeId),
        ipc.getEffectiveSetting('autoBoost', challengeId),
        ipc.getEffectiveSetting('onlyBoost', challengeId),
        ipc.getEffectiveSetting('voteBeforeBoostLeadMin', challengeId),
        ipc.getEffectiveSetting('boostTime', challengeId),
        ipc.getEffectiveSetting('keyUnlockedBoostTime', challengeId),
    ]);
    return {
        enabled: voteBeforeBoost === true && autoBoost === true && onlyBoost !== true,
        leadSec: Number(leadMin) * 60,
        boostTimeSec: Number(boostTime),
        keyUnlockedBoostTimeSec: Number(keyUnlockedBoostTime),
    };
};

// WebView resolver for the currency-automation cadence cap — the async-IPC twin of
// nodeResolvers.resolveCurrencyAuto: each ENABLED rule's timing, null when off.
const currencyTimingOf = async (enableKey, prefix, challengeId) => {
    const [enabled, afterStart, beforeEnd, afterPercent] = await Promise.all([
        ipc.getEffectiveSetting(enableKey, challengeId),
        ipc.getEffectiveSetting(`${prefix}AfterStart`, challengeId),
        ipc.getEffectiveSetting(`${prefix}BeforeEnd`, challengeId),
        ipc.getEffectiveSetting(`${prefix}AfterPercent`, challengeId),
    ]);
    return enabled === true
        ? { afterStartSec: Number(afterStart), beforeEndSec: Number(beforeEnd), afterPercent: Number(afterPercent) }
        : null;
};

export const resolveCurrencyAuto = async (challengeId) => {
    const [key, swap, fill] = await Promise.all([
        currencyTimingOf('autoKeyUnlock', 'autoKey', challengeId),
        currencyTimingOf('autoSwap', 'autoSwap', challengeId),
        currencyTimingOf('autoExposureFill', 'autoExposureFill', challengeId),
    ]);
    return { key, swap, fill };
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
 * @returns {Promise<{delayMs:number, mode:'last-minute'|'approaching'|'scheduled'|'pre-final-window'|'pre-boost'|'currency-rule'|'normal', nextEntry:(object|null), nextScheduled:(object|null), nextFinalWindowTopUp:(object|null), nextBoostPrefill:(object|null), nextCurrencyRule:(object|null)}>}
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
        resolveFinalWindowTopUp,
        resolveBoostPrefill,
        resolveCurrencyAuto,
    });
}
