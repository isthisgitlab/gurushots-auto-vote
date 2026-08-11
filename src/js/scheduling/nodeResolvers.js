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

module.exports = { resolveThreshold, resolveScheduledFill };
