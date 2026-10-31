/**
 * WebView (IPC) resolvers for the shared cadence math
 * (src/ts/scheduling/thresholdWindow.ts), the async-IPC counterpart of
 * src/ts/scheduling/nodeResolvers.ts: per-challenge values come back over
 * the getEffectiveSetting IPC channel instead of the synchronous settings
 * facade. Built as a factory over the autovote host so the controller
 * (src/ts/autovote/controller.ts) injects them into the shared cadence chain
 * (src/ts/scheduling/cadenceChain.ts) and the loop and math stay written
 * once. The two sets stay separate — see nodeResolvers.ts's header.
 */

import type { AutovoteHost } from './controller';
import type {
    ResolveThreshold,
    ResolveFinalWindowTopUp,
    ResolveBoostPrefill,
    ResolveCurrencyAuto,
    ResolveScenarioWake,
} from '../scheduling/thresholdWindow';
import type { ResolveScheduledFill } from '../scheduling/scheduledFill';
import type { RuleTiming } from '../voting/currencyAuto';

/** The six per-challenge resolvers the shared cadence decision consumes. */
export interface CadenceResolvers {
    resolveThreshold: ResolveThreshold;
    resolveScheduledFill: ResolveScheduledFill;
    resolveFinalWindowTopUp: ResolveFinalWindowTopUp;
    resolveBoostPrefill: ResolveBoostPrefill;
    resolveCurrencyAuto: ResolveCurrencyAuto;
    resolveScenarioWake: ResolveScenarioWake;
}

type ResolverHost = Pick<AutovoteHost, 'getEffectiveSetting' | 'getScenarioStatus'>;

/**
 * One currency rule's three timing conditions, read over IPC, batched; null
 * when the rule is off.
 */
const currencyTimingOf = async (
    host: ResolverHost,
    enableKey: string,
    prefix: string,
    challengeId: string,
): Promise<RuleTiming | null> => {
    const [enabled, afterStart, beforeEnd, afterPercent] = await Promise.all([
        host.getEffectiveSetting(enableKey, challengeId),
        host.getEffectiveSetting(`${prefix}AfterStart`, challengeId),
        host.getEffectiveSetting(`${prefix}BeforeEnd`, challengeId),
        host.getEffectiveSetting(`${prefix}AfterPercent`, challengeId),
    ]);
    return enabled === true
        ? { afterStartSec: Number(afterStart), beforeEndSec: Number(beforeEnd), afterPercent: Number(afterPercent) }
        : null;
};

/**
 * Build the WebView resolvers over the host's IPC members. The reads go
 * through the key-agnostic channel, typed `unknown`; the main process
 * resolves the schema-validated values, and the guards below mirror
 * nodeResolvers.ts gate for gate.
 */
export const createResolvers = (host: ResolverHost): CadenceResolvers => ({
    // Per-challenge lastMinuteThreshold over IPC (Promise).
    resolveThreshold: (challengeId: string) =>
        host.getEffectiveSetting('lastMinuteThreshold', challengeId) as Promise<number>,

    // Scheduled-fill cadence cap: the three per-challenge keys over the same
    // key-agnostic IPC channel, batched per challenge. Both trigger values are
    // LISTS, passed RAW — scheduledFill.ts owns the guards (no Number()
    // coercion: Number([a, b]) is NaN and would silently disable the cap for
    // multi-entry configs).
    resolveScheduledFill: async (challengeId: string) => {
        const [enabled, timesOfDay, beforeEndSecs] = await Promise.all([
            host.getEffectiveSetting('useScheduledFill', challengeId),
            host.getEffectiveSetting('scheduledFillTime', challengeId),
            host.getEffectiveSetting('scheduledFillBeforeEnd', challengeId),
        ]);
        return { enabled: enabled === true, timesOfDay, beforeEndSecs };
    },

    // Pre-final-window top-up cadence cap: the per-challenge keys over IPC,
    // batched. Enabled only when BOTH the final-window feature and this
    // opt-in are on — matching nodeResolvers.ts and the rule engine's gate.
    // durationSec is the configurable final-window length;
    // thresholdWindow/leadWindows.ts re-guards it.
    resolveFinalWindowTopUp: async (challengeId: string) => {
        const [voteBeforeFinalWindow, useFinalWindowExposure, leadMin, durationSec] = await Promise.all([
            host.getEffectiveSetting('voteBeforeFinalWindow', challengeId),
            host.getEffectiveSetting('useFinalWindowExposure', challengeId),
            host.getEffectiveSetting('voteBeforeFinalWindowLeadMin', challengeId),
            host.getEffectiveSetting('finalWindowDuration', challengeId),
        ]);
        return {
            enabled: voteBeforeFinalWindow === true && useFinalWindowExposure === true,
            leadSec: Number(leadMin) * 60,
            durationSec: Number(durationSec),
        };
    },

    // Pre-boost fill cadence cap: the per-challenge keys over IPC, batched.
    // Enabled only when the opt-in and autoBoost are on AND onlyBoost is
    // off — matching nodeResolvers.ts and the rule engine's gate (onlyBoost
    // blocks every vote ahead of the pre-boost branch, so waking for it could
    // only no-op). Both boost windows go through as numbers;
    // thresholdWindow/leadWindows.ts computes the apply instant from live
    // boost state and re-guards the `0 = off` sentinel.
    resolveBoostPrefill: async (challengeId: string) => {
        const [voteBeforeBoost, autoBoost, onlyBoost, leadMin, boostTime, keyUnlockedBoostTime] = await Promise.all([
            host.getEffectiveSetting('voteBeforeBoost', challengeId),
            host.getEffectiveSetting('autoBoost', challengeId),
            host.getEffectiveSetting('onlyBoost', challengeId),
            host.getEffectiveSetting('voteBeforeBoostLeadMin', challengeId),
            host.getEffectiveSetting('boostTime', challengeId),
            host.getEffectiveSetting('keyUnlockedBoostTime', challengeId),
        ]);
        return {
            enabled: voteBeforeBoost === true && autoBoost === true && onlyBoost !== true,
            leadSec: Number(leadMin) * 60,
            boostTimeSec: Number(boostTime),
            keyUnlockedBoostTimeSec: Number(keyUnlockedBoostTime),
        };
    },

    // Currency-automation cadence cap: each ENABLED rule's timing, null when
    // off (the async-IPC twin of nodeResolvers.resolveCurrencyAuto).
    resolveCurrencyAuto: async (challengeId: string) => {
        const [key, swap, fill, manualPhotosOnly] = await Promise.all([
            currencyTimingOf(host, 'autoKeyUnlock', 'autoKey', challengeId),
            currencyTimingOf(host, 'autoSwap', 'autoSwap', challengeId),
            currencyTimingOf(host, 'autoExposureFill', 'autoExposureFill', challengeId),
            host.getEffectiveSetting('manualPhotosOnly', challengeId),
        ]);
        // Manual Only: no swap ever fires on its own, so there is no wake to hold for it.
        return { key, swap: manualPhotosOnly === true ? null : swap, fill };
    },

    // Scenario boundary: the challenge's scenario and runtime state, or null
    // when no scenario can run for it (the async-IPC twin of
    // nodeResolvers.resolveScenarioWake; the IPC channel answers the
    // `{success, ...}` wrapper, so the guard reads the wrapped shape).
    resolveScenarioWake: async (challengeId: string) => {
        const status = await host.getScenarioStatus(challengeId);
        return status?.success && status.scenario && !status.corrupt
            ? { scenario: status.scenario, state: status.state, timezone: status.timezone }
            : null;
    },
});
