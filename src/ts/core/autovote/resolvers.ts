/**
 * WebView (IPC) resolvers for the shared cadence math
 * (src/ts/core/scheduling/thresholdWindow.ts), the async-IPC counterpart of
 * src/ts/core/scheduling/nodeResolvers.ts: per-challenge values come back over
 * the getEffectiveSetting IPC channel instead of the synchronous settings
 * facade. Built as a factory over the autovote host so the controller
 * (src/ts/core/autovote/controller.ts) injects them into the shared cadence chain
 * (src/ts/core/scheduling/cadenceChain.ts) and the loop and math stay written
 * once.
 *
 * The two sets stay separate on purpose: the scenario wake shapes differ —
 * services/scenarioStatus.scenarioWakeInput takes the service's unwrapped
 * `{scenario, state, corrupt, timezone}` shape, while the get-scenario-status
 * IPC answers a `{success, ...}` wrapper whose failure arm carries no status
 * fields at all — and the currency-auto manual-only gate reads through
 * different mechanisms (`isManualPhotosOnly` over the settings facade on the
 * Node side, the raw `manualPhotosOnly` key over IPC here). One shared
 * factory would need a normalization adapter on the Node side — a behavior
 * surface that does not exist today — so the Node resolvers keep their
 * synchronous bodies and the WebView keeps this async set.
 */

import type { AutovoteHost } from './controller';
import type {
    ResolveThreshold,
    ResolveFinalWindowTopUp,
    ResolveBoostPrefill,
    ResolveCurrencyAuto,
    ResolveScenarioWake,
    ResolveAutoSubmitClock,
    ResolveAutoSubmitSchedule,
} from '../scheduling/thresholdWindow';
import type { ResolveScheduledFill } from '../scheduling/scheduledFill';
import type { RuleTiming } from '../voting/currencyAuto';

/** The per-challenge resolvers the shared cadence decision consumes. */
export interface CadenceResolvers {
    resolveThreshold: ResolveThreshold;
    resolveScheduledFill: ResolveScheduledFill;
    resolveAutoSubmitClock: ResolveAutoSubmitClock;
    resolveAutoSubmitSchedule: ResolveAutoSubmitSchedule;
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

const resolveAutoSubmitClock = async (host: ResolverHost, challengeId: string) => {
    const [enabled, manualPhotosOnly, times, windowMinutes] = await Promise.all([
        host.getEffectiveSetting('autoSubmit', challengeId),
        host.getEffectiveSetting('manualPhotosOnly', challengeId),
        host.getEffectiveSetting('autoSubmitTime', challengeId),
        host.getEffectiveSetting('autoSubmitWindowMinutes', challengeId),
    ]);
    return { enabled: enabled === true, manualPhotosOnly: manualPhotosOnly === true, times, windowMinutes };
};

const resolveAutoSubmitSchedule = async (
    host: ResolverHost,
    challengeId: string,
): Promise<Awaited<ReturnType<ResolveAutoSubmitSchedule>>> => {
    const [enabled, manualPhotosOnly, schedule] = await Promise.all([
        host.getEffectiveSetting('autoSubmit', challengeId),
        host.getEffectiveSetting('manualPhotosOnly', challengeId),
        host.getEffectiveSetting('autoSubmitSchedule', challengeId),
    ]);
    if (!Array.isArray(schedule)) throw new Error('Auto-submit schedule is unavailable.');
    return {
        enabled: enabled === true,
        manualPhotosOnly: manualPhotosOnly === true,
        schedule: schedule as Awaited<ReturnType<ResolveAutoSubmitSchedule>>['schedule'],
    };
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

    resolveAutoSubmitClock: (challengeId: string) => resolveAutoSubmitClock(host, challengeId),

    resolveAutoSubmitSchedule: (challengeId: string) => resolveAutoSubmitSchedule(host, challengeId),

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
