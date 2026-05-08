/**
 * Voting Logic Service
 *
 * Centralized business logic for voting decisions.
 * This service contains all the voting rules and logic that was previously
 * duplicated across api/main.js, mock/index.js, and index.js
 */

const settings = require('../settings');

/**
 * Check if a challenge is within the last hour
 * @param {number} closeTime - Challenge close time (Unix timestamp)
 * @param {number} now - Current time (Unix timestamp)
 * @returns {boolean} - True if within last hour
 */
const isWithinLastHour = (closeTime, now) => {
    const timeUntilEnd = closeTime - now;
    return timeUntilEnd <= 3600 && timeUntilEnd > 0; // 3600 seconds = 1 hour
};

/**
 * Check if a challenge is within the last minute threshold
 * @param {number} closeTime - Challenge close time (Unix timestamp)
 * @param {number} now - Current time (Unix timestamp)
 * @param {string} challengeId - Challenge ID for settings lookup
 * @returns {boolean} - True if within last minute threshold
 */
const isWithinLastMinuteThreshold = (closeTime, now, challengeId) => {
    const effectiveLastMinuteThreshold = settings.getEffectiveSetting('lastMinuteThreshold', challengeId);
    const timeUntilEnd = closeTime - now;
    return timeUntilEnd <= effectiveLastMinuteThreshold * 60 && timeUntilEnd > 0;
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
 * Get the effective last hour exposure threshold for a challenge
 * @param {string} challengeId - Challenge ID
 * @returns {number} - Effective last hour exposure threshold
 */
const getEffectiveLastHourExposureThreshold = (challengeId) => {
    return settings.getEffectiveSetting('lastHourExposure', challengeId);
};

/**
 * Shared rule engine for the auto-vote and manual-vote evaluators.
 * Returns an intermediate result the per-mode wrappers map onto their
 * caller-facing shape:
 *
 *   { eligible:      true | false,
 *     skipReason:    string | null,   // when eligible=false because a rule blocked
 *     atTarget:      true | false,    // when exposure already meets target
 *     targetExposure:number,
 *     ruleLabel:     string,          // 'flash', 'lastminute', 'last-hour', 'normal'
 *     thresholdInfo: object }         // small bundle of settings the wrapper formats
 */
const _runVotingRules = (challenge, now, mode) => {
    const challengeId = challenge.id.toString();

    const onlyBoost = mode === 'auto' && settings.getEffectiveSetting('onlyBoost', challengeId);
    const voteOnlyInLastMinute = settings.getEffectiveSetting('voteOnlyInLastMinute', challengeId);
    const effectiveThreshold = getEffectiveExposureThreshold(challengeId);
    const effectiveLastMinuteThreshold = settings.getEffectiveSetting('lastMinuteThreshold', challengeId);
    const effectiveLastHourExposure = getEffectiveLastHourExposureThreshold(challengeId);
    const useLastHourExposure = settings.getEffectiveSetting('useLastHourExposure', challengeId);

    const isWithinLastMinute = isWithinLastMinuteThreshold(challenge.close_time, now, challengeId);
    const withinLastHour = isWithinLastHour(challenge.close_time, now);
    const currentExposure = challenge.member.ranking.exposure.exposure_factor;

    const blocked = (skipReason) => ({
        eligible: false,
        atTarget: false,
        skipReason,
        targetExposure: 100,
        ruleLabel: null,
        thresholdInfo: null,
    });
    const decided = (ruleLabel, targetExposure, thresholdInfo) => {
        const atTarget = currentExposure >= targetExposure;
        return {
            eligible: !atTarget,
            atTarget,
            skipReason: null,
            targetExposure,
            ruleLabel,
            thresholdInfo: { ...thresholdInfo, currentExposure },
        };
    };

    if (onlyBoost) return blocked('boost-only mode enabled');
    if (mode === 'auto' && challenge.start_time >= now) return blocked('challenge not started');

    if (challenge.type === 'flash') {
        return decided('flash', 100, { effectiveLastMinuteThreshold, effectiveThreshold, effectiveLastHourExposure });
    }

    if (voteOnlyInLastMinute && !isWithinLastMinute) {
        return blocked(`vote-only-in-last-threshold: not within last ${effectiveLastMinuteThreshold}m threshold`);
    }

    if (isWithinLastMinute) {
        return decided('lastminute', 100, {
            effectiveLastMinuteThreshold,
            effectiveThreshold,
            effectiveLastHourExposure,
        });
    }

    if (withinLastHour && useLastHourExposure) {
        return decided('last-hour', effectiveLastHourExposure, {
            effectiveLastMinuteThreshold,
            effectiveThreshold,
            effectiveLastHourExposure,
        });
    }

    return decided('normal', effectiveThreshold, {
        effectiveLastMinuteThreshold,
        effectiveThreshold,
        effectiveLastHourExposure,
    });
};

/**
 * Auto-vote evaluator. Returns { shouldVote, voteReason, targetExposure }.
 */
const evaluateVotingDecision = (challenge, now) => {
    const r = _runVotingRules(challenge, now, 'auto');
    if (r.skipReason) return { shouldVote: false, voteReason: r.skipReason, targetExposure: r.targetExposure };

    const { currentExposure, effectiveThreshold, effectiveLastHourExposure, effectiveLastMinuteThreshold } =
        r.thresholdInfo;
    const reasons = {
        flash: r.atTarget ? 'flash type: exposure already at 100%' : `flash type: exposure ${currentExposure}% < 100%`,
        lastminute: r.atTarget
            ? `lastminute threshold (${effectiveLastMinuteThreshold}m): exposure already at 100%`
            : `lastminute threshold (${effectiveLastMinuteThreshold}m): exposure ${currentExposure}% < 100%`,
        'last-hour': r.eligible
            ? `last hour threshold: exposure ${currentExposure}% < ${effectiveLastHourExposure}%`
            : `last hour threshold: exposure ${currentExposure}% >= ${effectiveLastHourExposure}%`,
        normal: r.eligible
            ? `normal threshold: exposure ${currentExposure}% < ${effectiveThreshold}%`
            : `normal threshold: exposure ${currentExposure}% >= ${effectiveThreshold}%`,
    };
    return { shouldVote: r.eligible, voteReason: reasons[r.ruleLabel], targetExposure: r.targetExposure };
};

/**
 * Manual-vote evaluator. Returns { shouldAllowVoting, errorMessage, targetExposure }.
 */
const evaluateManualVotingDecision = (challenge, now, challengeTitle) => {
    const r = _runVotingRules(challenge, now, 'manual');
    if (r.skipReason) {
        // Manual path uses different phrasing for the only-in-last-minute skip reason.
        const challengeId = challenge.id.toString();
        const lastMinute = settings.getEffectiveSetting('lastMinuteThreshold', challengeId);
        return {
            shouldAllowVoting: false,
            errorMessage: `Challenge "${challengeTitle}" voting is restricted to last ${lastMinute} minutes only`,
            targetExposure: r.targetExposure,
        };
    }

    if (r.atTarget) {
        const { effectiveLastMinuteThreshold, effectiveThreshold, effectiveLastHourExposure } = r.thresholdInfo;
        const messages = {
            flash: `Challenge "${challengeTitle}" already has 100% exposure (flash type)`,
            lastminute: `Challenge "${challengeTitle}" already has 100% exposure (lastminute threshold: ${effectiveLastMinuteThreshold}m)`,
            'last-hour': `Challenge "${challengeTitle}" already has ${effectiveLastHourExposure}% exposure (last hour threshold)`,
            normal: `Challenge "${challengeTitle}" already has ${effectiveThreshold}% exposure`,
        };
        return { shouldAllowVoting: false, errorMessage: messages[r.ruleLabel], targetExposure: r.targetExposure };
    }

    return { shouldAllowVoting: true, errorMessage: '', targetExposure: r.targetExposure };
};

/**
 * Evaluate whether manual voting to 100% should be allowed on a challenge
 * (Used for manual vote buttons - bypasses all threshold configurations)
 * @param {Object} challenge - Challenge object
 * @param {number} now - Current time (Unix timestamp)
 * @param {string} challengeTitle - Challenge title for error messages
 * @returns {Object} - Decision with shouldAllowVoting boolean, errorMessage string, and targetExposure number
 */
const evaluateManualVotingToHundred = (challenge, now, challengeTitle) => {
    // Get current exposure
    const currentExposure = challenge.member.ranking.exposure.exposure_factor;

    // Simple logic: allow voting if exposure is below 100%
    let shouldAllowVoting = false;
    let errorMessage = '';
    const targetExposure = 100; // Always target 100% for manual voting

    // Rule 1: Skip if challenge hasn't started yet
    if (challenge.start_time >= now) {
        errorMessage = `Challenge "${challengeTitle}" has not started yet`;
        return { shouldAllowVoting, errorMessage, targetExposure };
    }

    // Rule 2: Skip if challenge has ended
    if (challenge.close_time <= now) {
        errorMessage = `Challenge "${challengeTitle}" has already ended`;
        return { shouldAllowVoting, errorMessage, targetExposure };
    }

    // Rule 3: Allow voting if exposure is below 100%
    if (currentExposure < 100) {
        shouldAllowVoting = true;
    } else {
        errorMessage = `Challenge "${challengeTitle}" already has 100% exposure`;
    }

    return { shouldAllowVoting, errorMessage, targetExposure };
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
 * Check if boost should be applied to a challenge
 * - Timer-based available (state === 'AVAILABLE' with timeout):
 *   apply when timeUntilBoostExpires <= effectiveBoostTime
 * - Key-unlocked available (state === 'AVAILABLE_KEY' or available with no timeout):
 *   ignore boost timer completely and apply only if challenge ends in next 10 minutes
 * @param {Object} challenge - Challenge object
 * @param {number} now - Current time (Unix timestamp)
 * @returns {boolean} - True if boost should be applied
 */
const shouldApplyBoost = (challenge, now) => {
    if (!challenge) return false;

    // Never apply if challenge already ended or not started yet
    if (challenge.close_time <= now) return false;

    const challengeId = challenge.id?.toString?.() || '';
    const effectiveBoostTime = getEffectiveBoostTime(challengeId); // seconds

    const boost = challenge.member?.boost || {};
    const boostState = boost.state;
    const hasTimeout = typeof boost.timeout === 'number' && boost.timeout > 0;

    // Determine if this is a key-unlocked availability
    // Treat AVAILABLE without timeout as key-unlocked as well
    const isKeyUnlocked = boostState === 'AVAILABLE_KEY' || (boostState === 'AVAILABLE' && !hasTimeout);

    const timeUntilEnd = challenge.close_time - now;
    const CLOSING = 15 * 60; // seconds

    if (isKeyUnlocked) {
        // Auto-apply only if the challenge ends within next 10 minutes
        return timeUntilEnd > 0 && timeUntilEnd <= CLOSING;
    }

    // Timer-based AVAILABLE with a timeout: use existing effectiveBoostTime window
    if (boostState === 'AVAILABLE' && hasTimeout) {
        const timeUntilBoostExpires = boost.timeout - now;
        return timeUntilBoostExpires > 0 && timeUntilBoostExpires <= effectiveBoostTime;
    }

    // All other states: do not auto-apply
    return false;
};

/**
 * Returns true while the boost window is currently usable (state AVAILABLE
 * with an active timer, or AVAILABLE_KEY / AVAILABLE without timeout).
 * Used by both shouldApplyBoost (for its own decision) and shouldApplyTurbo
 * (to optionally skip turbo while a boost is queued for the same challenge).
 * @param {Object} challenge
 * @param {number} now - Unix timestamp in seconds
 * @returns {boolean}
 */
const isBoostWindowOpen = (challenge, now) => {
    const boost = challenge?.member?.boost || {};
    const hasTimeout = typeof boost.timeout === 'number' && boost.timeout > 0;
    if (boost.state === 'AVAILABLE_KEY') return true;
    if (boost.state === 'AVAILABLE') {
        return hasTimeout ? boost.timeout > now : true;
    }
    return false;
};

const getEffectiveTurboTime = (challengeId) => {
    return settings.getEffectiveSetting('turboTime', challengeId);
};

/**
 * Decides whether to play the Turbo mini-game on a challenge.
 * @param {Object} challenge
 * @param {number} now - Unix timestamp in seconds
 * @returns {boolean}
 */
const shouldPlayAutoTurbo = (challenge, now) => {
    if (!challenge) return false;
    if (challenge.close_time <= now) return false;

    const challengeId = challenge.id?.toString?.() || '';
    if (!settings.getEffectiveSetting('autoTurbo', challengeId)) return false;

    const turbo = challenge.member?.turbo || {};
    const state = turbo.state;
    if (state === 'FREE' || state === 'IN_PROGRESS') return true;
    if (state === 'TIMER' && typeof turbo.time_to_open === 'number' && turbo.time_to_open <= now) {
        return true;
    }
    return false;
};

/**
 * Decides whether to apply a won Turbo to one of the user's entries.
 * @param {Object} challenge
 * @param {number} now - Unix timestamp in seconds
 * @returns {{apply: boolean, imageId: string|null, reason: string}}
 */
const shouldApplyTurbo = (challenge, now) => {
    const noop = (reason) => ({ apply: false, imageId: null, reason });
    if (!challenge) return noop('no challenge');
    if (challenge.close_time <= now) return noop('challenge ended');

    const challengeId = challenge.id?.toString?.() || '';
    if (!settings.getEffectiveSetting('useTurbo', challengeId)) return noop('useTurbo disabled');

    const turbo = challenge.member?.turbo || {};
    if (turbo.state !== 'WON') return noop(`turbo state ${turbo.state || 'unknown'}`);

    const effectiveTurboTime = getEffectiveTurboTime(challengeId);
    const timeUntilEnd = challenge.close_time - now;
    if (timeUntilEnd > effectiveTurboTime) {
        return noop(`${Math.floor(timeUntilEnd / 60)}m remaining > ${Math.floor(effectiveTurboTime / 60)}m threshold`);
    }

    const allowDuringBoost = settings.getEffectiveSetting('turboApplyWhenBoostActive', challengeId);
    if (!allowDuringBoost && isBoostWindowOpen(challenge, now)) {
        return noop('boost window currently open');
    }

    const entries = challenge.member?.ranking?.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
        return noop('no entries to apply turbo to');
    }
    const requestedIndex = settings.getEffectiveSetting('turboImageIndex', challengeId);
    const safeIndex =
        requestedIndex === 0 ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, requestedIndex - 1));
    const imageId = entries[safeIndex]?.id;
    if (!imageId) return noop('selected entry has no id');
    return { apply: true, imageId, reason: 'eligible' };
};

module.exports = {
    isWithinLastHour,
    isWithinLastMinuteThreshold,
    getEffectiveExposureThreshold,
    getEffectiveLastHourExposureThreshold,
    evaluateVotingDecision,
    evaluateManualVotingDecision,
    evaluateManualVotingToHundred,
    getEffectiveBoostTime,
    shouldApplyBoost,
    isBoostWindowOpen,
    getEffectiveTurboTime,
    shouldPlayAutoTurbo,
    shouldApplyTurbo,
};
