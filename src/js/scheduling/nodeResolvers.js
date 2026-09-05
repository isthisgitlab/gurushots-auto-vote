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

module.exports = { resolveThreshold, resolveScheduledFill, resolveFinalWindowTopUp };
