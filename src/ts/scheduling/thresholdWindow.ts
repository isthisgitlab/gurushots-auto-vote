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
 * Every function takes a `resolveThreshold(idString)` (or the like) that may
 * return a value or a Promise, so the part that actually drifts between
 * platforms is never duplicated. This facade re-exports the sub-modules:
 *   - thresholdWindow/thresholds      last-minute threshold queries
 *   - thresholdWindow/leadWindows     pre-final-window top-up / pre-boost wakes
 *   - thresholdWindow/ruleWakes       currency-rule, scenario and boost-hold wakes
 *   - thresholdWindow/cadenceDecision `computeNextCycleDelayMs`, the whole
 *                                     per-cycle cadence decision every host
 *                                     (CLI `runScheduler.ts`, GUI
 *                                     `AutovoteContext.tsx`, Android
 *                                     `headless/index.ts`) drives its single
 *                                     setTimeout/alarm chain from
 *   - thresholdWindow/shared          types and helpers common to the above
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
