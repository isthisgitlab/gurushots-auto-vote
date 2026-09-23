/**
 * Node-side resolvers for the shared cadence math (./thresholdWindow).
 *
 * On Electron main / CLI / Android headless the settings facade is available
 * synchronously, so per-challenge values come straight from it. The GUI
 * WebView has its own async variants over IPC in
 * react/contexts/autovoteScheduler.js — same shape, different transport.
 */

const settings = require('../settings');

// Per-challenge lastMinuteThreshold for the shared threshold math.
const resolveThreshold = (challengeId) => settings.getEffectiveSetting('lastMinuteThreshold', challengeId);

// Per-challenge scheduled-fill config for the cadence cap (./scheduledFill.js).
// Both trigger values are LISTS and are passed RAW — scheduledFill.js owns the
// Array.isArray/Number guards (one normalization site). No Number() coercion
// here: Number([14400]) happens to work via the single-element-array quirk,
// but Number([14400, 36000]) is NaN, which would silently kill the cadence
// cap for exactly the flagship two-offset case.
const resolveScheduledFill = (challengeId) => ({
    enabled: settings.getEffectiveSetting('useScheduledFill', challengeId) === true,
    timesOfDay: settings.getEffectiveSetting('scheduledFillTime', challengeId),
    beforeEndSecs: settings.getEffectiveSetting('scheduledFillBeforeEnd', challengeId),
});

// Per-challenge pre-final-window top-up config for the cadence cap (./thresholdWindow.js).
// Enabled only when BOTH the final-window feature and this opt-in are on — matching the
// rule engine's gate in VotingLogic._runVotingRules. leadSec is minutes → seconds and
// durationSec is the configurable final-window length; thresholdWindow.js re-guards a
// non-positive/NaN value for both.
const resolveFinalWindowTopUp = (challengeId) => ({
    enabled:
        settings.getEffectiveSetting('voteBeforeFinalWindow', challengeId) === true &&
        settings.getEffectiveSetting('useFinalWindowExposure', challengeId) === true,
    leadSec: Number(settings.getEffectiveSetting('voteBeforeFinalWindowLeadMin', challengeId)) * 60,
    durationSec: Number(settings.getEffectiveSetting('finalWindowDuration', challengeId)),
});

// Per-challenge pre-boost fill config for the cadence cap (./thresholdWindow.js).
// Enabled only when the opt-in and autoBoost are on AND onlyBoost is off — matching the
// rule engine, so the scheduler never wakes for a fill the rule would decline. onlyBoost
// is part of the gate because it blocks every vote ahead of the pre-boost branch in
// _runVotingRules, which would otherwise make this cap wake a cycle that can only no-op.
// Both boost windows are passed through as numbers because the apply instant depends on
// the challenge's live boost state, which only thresholdWindow.js sees; it re-guards the
// `0 = off` sentinel and an out-of-range leadSec.
const resolveBoostPrefill = (challengeId) => ({
    enabled:
        settings.getEffectiveSetting('voteBeforeBoost', challengeId) === true &&
        settings.getEffectiveSetting('autoBoost', challengeId) === true &&
        settings.getEffectiveSetting('onlyBoost', challengeId) !== true,
    leadSec: Number(settings.getEffectiveSetting('voteBeforeBoostLeadMin', challengeId)) * 60,
    boostTimeSec: Number(settings.getEffectiveSetting('boostTime', challengeId)),
    keyUnlockedBoostTimeSec: Number(settings.getEffectiveSetting('keyUnlockedBoostTime', challengeId)),
});

// Per-challenge currency-automation timing for the cadence cap (./thresholdWindow.js):
// each ENABLED rule's three timing conditions, null for a rule that is off. The
// enable keys are challengeOnly, so a challenge with no override or profile turning
// them on resolves all-null and never shortens the wait.
const currencyTimingOf = (enableKey, prefix, challengeId) =>
    settings.getEffectiveSetting(enableKey, challengeId) === true
        ? {
              afterStartSec: Number(settings.getEffectiveSetting(`${prefix}AfterStart`, challengeId)),
              beforeEndSec: Number(settings.getEffectiveSetting(`${prefix}BeforeEnd`, challengeId)),
              afterPercent: Number(settings.getEffectiveSetting(`${prefix}AfterPercent`, challengeId)),
          }
        : null;

const resolveCurrencyAuto = (challengeId) => ({
    key: currencyTimingOf('autoKeyUnlock', 'autoKey', challengeId),
    swap: currencyTimingOf('autoSwap', 'autoSwap', challengeId),
    fill: currencyTimingOf('autoExposureFill', 'autoExposureFill', challengeId),
});

module.exports = {
    resolveThreshold,
    resolveScheduledFill,
    resolveFinalWindowTopUp,
    resolveBoostPrefill,
    resolveCurrencyAuto,
};
