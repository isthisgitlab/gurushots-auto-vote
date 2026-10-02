/**
 * Shared last-minute threshold math for both voting schedulers.
 *
 * `runScheduler.ts` (CLI/Android) and `autovoteScheduler.ts` (React GUI) both
 * answer "which challenge crosses its lastMinuteThreshold next?" and "is any
 * challenge in its window now?" through this module. The only difference is
 * how a per-challenge threshold gets resolved:
 *   - Node:    settings.getEffectiveSetting('lastMinuteThreshold', id)  (sync)
 *   - WebView: window.api.getEffectiveSetting('lastMinuteThreshold', id) (async)
 *
 * So the math lives here once and takes a `resolveThreshold(idString)`
 * function that may return a number or a Promise<number>; both consumers wrap
 * it with their platform's resolver, so the part that actually drifts is
 * never duplicated. `computeNextCycleDelayMs` builds on these
 * to make the whole per-cycle cadence decision in one place, so every host
 * (CLI `runScheduler.ts`, GUI `AutovoteContext.tsx`, Android `headless/index.ts`)
 * drives a single setTimeout/alarm chain off the same rule rather than each
 * carrying its own boundary-switch timer.
 */

export { calculateNextThresholdEntry, isAnyChallengeInThresholdWindow } from './thresholdWindow/thresholds';
export { computeNextCycleDelayMs } from './thresholdWindow/cadenceDecision';
export { soonestFinalWindowTopUpStart, soonestBoostPrefillStart } from './thresholdWindow/leadWindows';
export { soonestCurrencyRuleStart, soonestScenarioWake, soonestBoostHoldEnd } from './thresholdWindow/ruleWakes';

export type { CadenceMode } from './thresholdWindow/shared';
export type { CadenceDecision } from './thresholdWindow/cadenceDecision';
export type { ResolveThreshold } from './thresholdWindow/thresholds';
export type { ResolveFinalWindowTopUp, ResolveBoostPrefill } from './thresholdWindow/leadWindows';
export type { ResolveCurrencyAuto, ResolveScenarioWake } from './thresholdWindow/ruleWakes';
