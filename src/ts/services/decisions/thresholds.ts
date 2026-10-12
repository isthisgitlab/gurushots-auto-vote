/**
 * Per-challenge threshold and window resolution: the exposure triggers and
 * targets (with their `0`/null = "follow the trigger" sentinel), the
 * final-window and last-minute windows, and the boost/turbo timing windows
 * (whose `0` = off sentinel the callers interpret). Part of the
 * services/VotingLogic facade.
 */

import * as settings from '../../settings';

/**
 * Check if a challenge is within its final window (the configurable stretch
 * before close during which the final-window exposure rule applies).
 * @param closeTime - Challenge close time (Unix timestamp)
 * @param now - Current time (Unix timestamp)
 * @param windowSec - Final-window duration in seconds
 *   (finalWindowDuration). Defaults to one hour.
 * @returns True if within the final window
 */
const isWithinFinalWindow = (closeTime: number, now: number, windowSec: number = 3600): boolean => {
    const timeUntilEnd = closeTime - now;
    return timeUntilEnd <= windowSec && timeUntilEnd > 0;
};

/**
 * The last-minute threshold in minutes: validated to the schema's range (1..59)
 * when settings load. A NaN here would make the window comparison false, so the
 * last-minute rule would NEVER fire — and because the voting pause sits above
 * final-window, last-minute is the one rule a pause deliberately cannot block.
 *
 * Shared by the gate and by the log/message strings so the two can't disagree.
 */
const getEffectiveLastMinuteThreshold = (challengeId: string): number =>
    settings.getEffectiveSetting('lastMinuteThreshold', challengeId);

/**
 * Check if a challenge is within the last minute threshold
 * @param closeTime - Challenge close time (Unix timestamp)
 * @param now - Current time (Unix timestamp)
 * @param challengeId - Challenge ID for settings lookup
 * @returns True if within last minute threshold
 */
const isWithinLastMinuteThreshold = (closeTime: number, now: number, challengeId: string): boolean => {
    const timeUntilEnd = closeTime - now;
    return timeUntilEnd <= getEffectiveLastMinuteThreshold(challengeId) * 60 && timeUntilEnd > 0;
};

/**
 * Get the effective exposure threshold for a challenge
 * @param challengeId - Challenge ID
 * @returns Effective exposure threshold
 */
const getEffectiveExposureThreshold = (challengeId: string): number => {
    return settings.getEffectiveSetting('exposure', challengeId);
};

/**
 * Get the effective final-window exposure threshold for a challenge
 * @param challengeId - Challenge ID
 * @returns Effective final-window exposure threshold
 */
const getEffectiveFinalWindowExposureThreshold = (challengeId: string): number => {
    return settings.getEffectiveSetting('finalWindowExposure', challengeId);
};

/**
 * Resolve the effective normal-rule vote target. The schema sentinel `0` means
 * "follow the exposure trigger" (target == trigger).
 * @param challengeId - Challenge ID
 * @returns Effective target percentage
 */
const getEffectiveExposureTarget = (challengeId: string): number => {
    const raw = settings.getEffectiveSetting('exposureTarget', challengeId);
    // Treat the schema sentinel (0) and missing values (null/undefined from under-mocked
    // callers) the same — both mean "follow the trigger".
    return raw === 0 || raw == null ? getEffectiveExposureThreshold(challengeId) : raw;
};

/**
 * Resolve the effective final-window-rule vote target. Sentinel `0` means
 * "follow the finalWindowExposure trigger".
 * @param challengeId - Challenge ID
 * @returns Effective target percentage
 */
const getEffectiveFinalWindowExposureTarget = (challengeId: string): number => {
    const raw = settings.getEffectiveSetting('finalWindowExposureTarget', challengeId);
    return raw === 0 || raw == null ? getEffectiveFinalWindowExposureThreshold(challengeId) : raw;
};

/**
 * Get effective boost time for a challenge
 * @param challengeId - Challenge ID
 * @returns Effective boost time in seconds
 */
const getEffectiveBoostTime = (challengeId: string): number => {
    return settings.getEffectiveSetting('boostTime', challengeId);
};

/**
 * Get the effective key-unlocked boost window for a challenge.
 *
 * Separate from getEffectiveBoostTime on purpose: boostTime is measured against the boost's
 * own countdown, which a key-unlocked boost does not have. This one is measured against the
 * challenge's close time. Was a hardcoded 15 minutes; the default preserves that.
 *
 * @param challengeId - Challenge ID
 * @returns Seconds before close within which a key-unlocked boost is applied
 */
const getEffectiveKeyUnlockedBoostTime = (challengeId: string): number =>
    // An explicit 0 means "never auto-apply", matching the 0-is-off convention boostTime and
    // emergencyFill already use; the schema accepts it, so it is honoured.
    settings.getEffectiveSetting('keyUnlockedBoostTime', challengeId);

const getEffectiveTurboTime = (challengeId: string): number => {
    return settings.getEffectiveSetting('turboTime', challengeId);
};

export {
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
