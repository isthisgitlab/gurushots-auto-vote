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
const resolveScheduledFill = (challengeId) => ({
    enabled: settings.getEffectiveSetting('useScheduledFill', challengeId) === true,
    timeOfDay: settings.getEffectiveSetting('scheduledFillTime', challengeId),
    beforeEndSec: Number(settings.getEffectiveSetting('scheduledFillBeforeEnd', challengeId)) || 0,
});

module.exports = { resolveThreshold, resolveScheduledFill };
