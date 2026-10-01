/**
 * GUI-side (WebView) resolvers for the shared cadence math
 * (src/ts/scheduling/thresholdWindow.ts), the async-IPC counterpart of
 * src/ts/scheduling/nodeResolvers.ts: per-challenge values come back over
 * the getEffectiveSetting IPC channel (react/api/ipc.ts) instead of the synchronous settings facade.
 * AutovoteContext injects these into the shared cadence chain
 * (src/ts/scheduling/cadenceChain.ts) so the loop and math are written once.
 */

import { computeNextCycleDelayMs as computeNextDelayMs } from '../../scheduling/thresholdWindow';
import * as ipc from '../api/ipc';

import type { Challenge } from '../../types/gurushots';
import type {
    ResolveThreshold,
    ResolveFinalWindowTopUp,
    ResolveBoostPrefill,
    ResolveCurrencyAuto,
    ResolveScenarioWake,
} from '../../scheduling/thresholdWindow';
import type { ResolveScheduledFill } from '../../scheduling/scheduledFill';

// WebView resolver: per-challenge lastMinuteThreshold over IPC (Promise). The
// key-agnostic channel is typed `unknown`; the main process resolves the
// schema-validated (numeric) effective value.
export const resolveThreshold: ResolveThreshold = (challengeId) =>
    ipc.getEffectiveSetting('lastMinuteThreshold', challengeId) as Promise<number>;

// WebView resolver for the scheduled-fill cadence cap: the three per-challenge
// keys over the same key-agnostic IPC channel, batched per challenge. Both
// trigger values are LISTS, passed RAW — scheduledFill.ts owns the guards
// (no Number() coercion: Number([a, b]) is NaN and would silently disable the
// cap for multi-entry configs).
export const resolveScheduledFill: ResolveScheduledFill = async (challengeId) => {
    const [enabled, timesOfDay, beforeEndSecs] = await Promise.all([
        ipc.getEffectiveSetting('useScheduledFill', challengeId),
        ipc.getEffectiveSetting('scheduledFillTime', challengeId),
        ipc.getEffectiveSetting('scheduledFillBeforeEnd', challengeId),
    ]);
    return { enabled: enabled === true, timesOfDay, beforeEndSecs };
};

// WebView resolver for the pre-final-window top-up cadence cap: the per-challenge
// keys over IPC, batched. Enabled only when BOTH the final-window feature and this
// opt-in are on — matching nodeResolvers.ts and the rule engine's gate. durationSec
// is the configurable final-window length; thresholdWindow.ts re-guards it.
export const resolveFinalWindowTopUp: ResolveFinalWindowTopUp = async (challengeId) => {
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
// off — matching nodeResolvers.ts and the rule engine's gate (onlyBoost blocks every
// vote ahead of the pre-boost branch, so waking for it could only no-op). Both boost
// windows go through as numbers; thresholdWindow.ts computes the apply instant from
// live boost state and re-guards the `0 = off` sentinel.
export const resolveBoostPrefill: ResolveBoostPrefill = async (challengeId) => {
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
const currencyTimingOf = async (enableKey: string, prefix: string, challengeId: string) => {
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

export const resolveCurrencyAuto: ResolveCurrencyAuto = async (challengeId) => {
    const [key, swap, fill] = await Promise.all([
        currencyTimingOf('autoKeyUnlock', 'autoKey', challengeId),
        currencyTimingOf('autoSwap', 'autoSwap', challengeId),
        currencyTimingOf('autoExposureFill', 'autoExposureFill', challengeId),
    ]);
    return { key, swap, fill };
};

// WebView resolver for the scenario boundary — the async-IPC twin of
// nodeResolvers.resolveScenarioWake: the challenge's scenario and runtime
// state, or null when no scenario can run for it.
export const resolveScenarioWake: ResolveScenarioWake = async (challengeId) => {
    const status = await ipc.getScenarioStatus(challengeId);
    return status?.success && status.scenario && !status.corrupt
        ? { scenario: status.scenario, state: status.state, timezone: status.timezone }
        : null;
};

/**
 * Delay (ms) until the next voting cycle, using the shared decision: fast fixed
 * cadence while in-window, otherwise the rolled random delay capped to the
 * soonest upcoming threshold entry or scheduled-fill window start. The host
 * rolls `normalDelayMs` and resolves `lastMinuteCheckMinutes` and `timezone`
 * (over IPC) and passes them in.
 * @param now - Unix timestamp (seconds)
 */
export async function computeNextCycleDelayMs(
    challenges: Challenge[],
    now: number,
    {
        normalDelayMs,
        lastMinuteCheckMinutes,
        minGapMs,
        timezone = null,
    }: { normalDelayMs: number; lastMinuteCheckMinutes: number; minGapMs: number; timezone?: string | null },
): Promise<{
    delayMs: number;
    mode:
        | 'last-minute'
        | 'approaching'
        | 'scheduled'
        | 'pre-final-window'
        | 'pre-boost'
        | 'boost-hold'
        | 'currency-rule'
        | 'scenario'
        | 'normal';
    nextEntry: object | null;
    nextScheduled: object | null;
    nextFinalWindowTopUp: object | null;
    nextBoostPrefill: object | null;
    nextCurrencyRule: object | null;
    nextScenarioWake: object | null;
    nextBoostHold: object | null;
}> {
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
        resolveScenarioWake,
    });
}
