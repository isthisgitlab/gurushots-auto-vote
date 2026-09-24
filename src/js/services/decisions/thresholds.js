// @ts-check
/**
 * Per-challenge threshold and window resolution: the exposure triggers and
 * targets (with their `0`/null = "follow the trigger" sentinel), the
 * final-window and last-minute windows, and the boost/turbo timing windows
 * (whose `0` = off sentinel the callers interpret). Part of the
 * services/VotingLogic facade.
 */

// Cast to any at the boundary: the settings facade isn't `// @ts-check`ed yet,
// and its `challengeId = null` defaults make TS infer param types too narrow
// (null) to accept the string IDs passed here. Drop the cast once settings.js
// is typed.
const settings = /** @type {any} */ (require('../../settings'));

/**
 * Check if a challenge is within its final window (the configurable stretch
 * before close during which the final-window exposure rule applies).
 * @param {number} closeTime - Challenge close time (Unix timestamp)
 * @param {number} now - Current time (Unix timestamp)
 * @param {number} [windowSec=3600] - Final-window duration in seconds
 *   (finalWindowDuration). Defaults to one hour.
 * @returns {boolean} - True if within the final window
 */
const isWithinFinalWindow = (closeTime, now, windowSec = 3600) => {
    const timeUntilEnd = closeTime - now;
    return timeUntilEnd <= windowSec && timeUntilEnd > 0;
};

/**
 * The last-minute threshold in minutes, clamped to the schema's range (1..59),
 * mirroring finalWindowDuration and voteBeforeFinalWindowLeadMin in
 * _runVotingRules.
 *
 * Without the clamp a corrupt or under-mocked value makes the window
 * comparison NaN-false, so the last-minute rule NEVER fires. Because the
 * voting pause sits above final-window, that is the difference between "votes
 * late" and "never votes at all": last-minute is the one rule a pause
 * deliberately cannot block.
 *
 * Shared by the gate and by the log/message strings so the two can't disagree:
 * reading it raw for display while gating on the clamped value would print
 * "lastminute threshold (NaNm)" on a rule that had just fired at 10m.
 *
 * @param {string} challengeId
 * @returns {number}
 */
const getEffectiveLastMinuteThreshold = (challengeId) => {
    const threshold = Number(settings.getEffectiveSetting('lastMinuteThreshold', challengeId));
    return Number.isFinite(threshold) && threshold >= 1 && threshold <= 59 ? threshold : 10;
};

/**
 * Check if a challenge is within the last minute threshold
 * @param {number} closeTime - Challenge close time (Unix timestamp)
 * @param {number} now - Current time (Unix timestamp)
 * @param {string} challengeId - Challenge ID for settings lookup
 * @returns {boolean} - True if within last minute threshold
 */
const isWithinLastMinuteThreshold = (closeTime, now, challengeId) => {
    const timeUntilEnd = closeTime - now;
    return timeUntilEnd <= getEffectiveLastMinuteThreshold(challengeId) * 60 && timeUntilEnd > 0;
};

/**
 * Get the effective exposure threshold for a challenge
 * @param {string} challengeId - Challenge ID
 * @returns {number} - Effective exposure threshold
 */
const getEffectiveExposureThreshold = (challengeId) => {
    return settings.getEffectiveSetting('exposure', challengeId);
};

/**
 * Get the effective final-window exposure threshold for a challenge
 * @param {string} challengeId - Challenge ID
 * @returns {number} - Effective final-window exposure threshold
 */
const getEffectiveFinalWindowExposureThreshold = (challengeId) => {
    return settings.getEffectiveSetting('finalWindowExposure', challengeId);
};

/**
 * Resolve the effective normal-rule vote target. The schema sentinel `0` means
 * "follow the exposure trigger" (target == trigger).
 * @param {string} challengeId - Challenge ID
 * @returns {number} - Effective target percentage
 */
const getEffectiveExposureTarget = (challengeId) => {
    const raw = settings.getEffectiveSetting('exposureTarget', challengeId);
    // Treat the schema sentinel (0) and missing values (null/undefined from under-mocked
    // callers) the same — both mean "follow the trigger".
    return raw === 0 || raw == null ? getEffectiveExposureThreshold(challengeId) : raw;
};

/**
 * Resolve the effective final-window-rule vote target. Sentinel `0` means
 * "follow the finalWindowExposure trigger".
 * @param {string} challengeId - Challenge ID
 * @returns {number} - Effective target percentage
 */
const getEffectiveFinalWindowExposureTarget = (challengeId) => {
    const raw = settings.getEffectiveSetting('finalWindowExposureTarget', challengeId);
    return raw === 0 || raw == null ? getEffectiveFinalWindowExposureThreshold(challengeId) : raw;
};

/**
 * Get effective boost time for a challenge
 * @param {string} challengeId - Challenge ID
 * @returns {number} - Effective boost time in seconds
 */
const getEffectiveBoostTime = (challengeId) => {
    return settings.getEffectiveSetting('boostTime', challengeId);
};

/**
 * Get the effective key-unlocked boost window for a challenge.
 *
 * Separate from getEffectiveBoostTime on purpose: boostTime is measured against the boost's
 * own countdown, which a key-unlocked boost does not have. This one is measured against the
 * challenge's close time. Was a hardcoded 15 minutes; the default preserves that.
 *
 * @param {string} challengeId - Challenge ID
 * @returns {number} - Seconds before close within which a key-unlocked boost is applied
 */
const getEffectiveKeyUnlockedBoostTime = (challengeId) => {
    const value = settings.getEffectiveSetting('keyUnlockedBoostTime', challengeId);
    // An explicit 0 means "never auto-apply", matching the 0-is-off convention boostTime and
    // emergencyFill already use, and it is a value both the schema and the GUI input accept —
    // so it must be honoured rather than quietly replaced by the default. Only a genuinely
    // unusable value (missing, null, NaN, negative — reachable from an under-mocked caller or
    // a hand-edited settings file) falls back to the schema default. Type-checked rather than
    // coerced, because Number(null) is 0 and would otherwise read as a deliberate "off".
    const raw = typeof value === 'number' ? value : Number.NaN;
    return Number.isFinite(raw) && raw >= 0 ? raw : 900;
};

/**
 * @param {string} challengeId
 * @returns {number}
 */
const getEffectiveTurboTime = (challengeId) => {
    return settings.getEffectiveSetting('turboTime', challengeId);
};

module.exports = {
    isWithinFinalWindow,
    getEffectiveLastMinuteThreshold,
    isWithinLastMinuteThreshold,
    getEffectiveExposureThreshold,
    getEffectiveFinalWindowExposureThreshold,
    getEffectiveExposureTarget,
    getEffectiveFinalWindowExposureTarget,
    getEffectiveBoostTime,
    getEffectiveKeyUnlockedBoostTime,
    getEffectiveTurboTime,
};
