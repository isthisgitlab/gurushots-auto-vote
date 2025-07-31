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
    return timeUntilEnd <= (effectiveLastMinuteThreshold * 60) && timeUntilEnd > 0;
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
 * Evaluate whether voting should occur on a challenge
 * @param {Object} challenge - Challenge object
 * @param {number} now - Current time (Unix timestamp)
 * @returns {Object} - Voting decision with shouldVote boolean and reason string
 */
const evaluateVotingDecision = (challenge, now) => {
    const challengeId = challenge.id.toString();
    
    // Get all relevant settings
    const onlyBoost = settings.getEffectiveSetting('onlyBoost', challengeId);
    const voteOnlyInLastMinute = settings.getEffectiveSetting('voteOnlyInLastMinute', challengeId);
    const effectiveThreshold = getEffectiveExposureThreshold(challengeId);
    const effectiveLastMinuteThreshold = settings.getEffectiveSetting('lastMinuteThreshold', challengeId);
    const effectiveLastHourExposure = getEffectiveLastHourExposureThreshold(challengeId);
    
    // Check time-based conditions
    const isWithinLastMinute = isWithinLastMinuteThreshold(challenge.close_time, now, challengeId);
    const withinLastHour = isWithinLastHour(challenge.close_time, now);
    
    // Get current exposure
    const currentExposure = challenge.member.ranking.exposure.exposure_factor;
    
    // Evaluate voting decision based on business rules
    let shouldVote = false;
    let voteReason = '';
    
    // Rule 1: Skip if boost-only mode is enabled
    if (onlyBoost) {
        voteReason = 'boost-only mode enabled';
        return { shouldVote, voteReason };
    }
    
    // Rule 2: Skip if challenge hasn't started yet
    if (challenge.start_time >= now) {
        voteReason = 'challenge not started';
        return { shouldVote, voteReason };
    }
    
    // Rule 3: Flash type challenges - always use 100% threshold
    if (challenge.type === 'flash') {
        if (currentExposure < 100) {
            shouldVote = true;
            voteReason = `flash type: exposure ${currentExposure}% < 100%`;
        } else {
            voteReason = 'flash type: exposure already at 100%';
        }
        return { shouldVote, voteReason };
    }
    
    // Rule 4: Vote-only-in-last-minute mode - skip if not within threshold
    if (voteOnlyInLastMinute && !isWithinLastMinute) {
        voteReason = `vote-only-in-last-threshold enabled: not within last ${effectiveLastMinuteThreshold}m threshold`;
        return { shouldVote, voteReason };
    }
    
    // Rule 5: Within last minute threshold - always use 100% threshold
    if (isWithinLastMinute) {
        if (currentExposure < 100) {
            shouldVote = true;
            voteReason = `lastminute threshold (${effectiveLastMinuteThreshold}m): exposure ${currentExposure}% < 100%`;
        } else {
            voteReason = `lastminute threshold (${effectiveLastMinuteThreshold}m): exposure already at 100%`;
        }
        return { shouldVote, voteReason };
    }
    
    // Rule 6: Within last hour - use lastHourExposure threshold
    if (withinLastHour) {
        if (currentExposure < effectiveLastHourExposure) {
            shouldVote = true;
            voteReason = `last hour threshold: exposure ${currentExposure}% < ${effectiveLastHourExposure}%`;
        } else {
            voteReason = `last hour threshold: exposure ${currentExposure}% >= ${effectiveLastHourExposure}%`;
        }
        return { shouldVote, voteReason };
    }
    
    // Rule 7: Normal logic - use regular exposure threshold
    if (currentExposure < effectiveThreshold) {
        shouldVote = true;
        voteReason = `normal threshold: exposure ${currentExposure}% < ${effectiveThreshold}%`;
    } else {
        voteReason = `normal threshold: exposure ${currentExposure}% >= ${effectiveThreshold}%`;
    }
    
    return { shouldVote, voteReason };
};

/**
 * Evaluate whether manual voting should be allowed on a challenge
 * (Used for vote-on-challenge functionality)
 * @param {Object} challenge - Challenge object
 * @param {number} now - Current time (Unix timestamp)
 * @param {string} challengeTitle - Challenge title for error messages
 * @returns {Object} - Decision with shouldAllowVoting boolean and errorMessage string
 */
const evaluateManualVotingDecision = (challenge, now, challengeTitle) => {
    const challengeId = challenge.id.toString();
    
    // Get all relevant settings
    const voteOnlyInLastMinute = settings.getEffectiveSetting('voteOnlyInLastMinute', challengeId);
    const effectiveThreshold = getEffectiveExposureThreshold(challengeId);
    const effectiveLastMinuteThreshold = settings.getEffectiveSetting('lastMinuteThreshold', challengeId);
    const effectiveLastHourExposure = getEffectiveLastHourExposureThreshold(challengeId);
    
    // Check time-based conditions
    const isWithinLastMinute = isWithinLastMinuteThreshold(challenge.close_time, now, challengeId);
    const withinLastHour = isWithinLastHour(challenge.close_time, now);
    
    // Get current exposure
    const currentExposure = challenge.member.ranking.exposure.exposure_factor;
    
    // Evaluate voting decision based on business rules
    let shouldAllowVoting = false;
    let errorMessage = '';
    
    // Rule 1: Flash type challenges - always use 100% threshold
    if (challenge.type === 'flash') {
        if (currentExposure >= 100) {
            errorMessage = `Challenge "${challengeTitle}" already has 100% exposure (flash type)`;
        } else {
            shouldAllowVoting = true;
        }
        return { shouldAllowVoting, errorMessage };
    }
    
    // Rule 2: Vote-only-in-last-minute mode - skip if not within threshold
    if (voteOnlyInLastMinute && !isWithinLastMinute) {
        errorMessage = `Challenge "${challengeTitle}" voting is restricted to last ${effectiveLastMinuteThreshold} minutes only`;
        return { shouldAllowVoting, errorMessage };
    }
    
    // Rule 3: Within last minute threshold - always use 100% threshold
    if (isWithinLastMinute) {
        if (currentExposure >= 100) {
            errorMessage = `Challenge "${challengeTitle}" already has 100% exposure (lastminute threshold: ${effectiveLastMinuteThreshold}m)`;
        } else {
            shouldAllowVoting = true;
        }
        return { shouldAllowVoting, errorMessage };
    }
    
    // Rule 4: Within last hour - use lastHourExposure threshold
    if (withinLastHour) {
        if (currentExposure >= effectiveLastHourExposure) {
            errorMessage = `Challenge "${challengeTitle}" already has ${effectiveLastHourExposure}% exposure (last hour threshold)`;
        } else {
            shouldAllowVoting = true;
        }
        return { shouldAllowVoting, errorMessage };
    }
    
    // Rule 5: Normal logic - use regular exposure threshold
    if (currentExposure >= effectiveThreshold) {
        errorMessage = `Challenge "${challengeTitle}" already has ${effectiveThreshold}% exposure`;
    } else {
        shouldAllowVoting = true;
    }
    
    return { shouldAllowVoting, errorMessage };
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
 * @param {Object} challenge - Challenge object
 * @param {number} now - Current time (Unix timestamp)
 * @returns {boolean} - True if boost should be applied
 */
const shouldApplyBoost = (challenge, now) => {
    const challengeId = challenge.id.toString();
    const effectiveBoostTime = getEffectiveBoostTime(challengeId);
    const timeUntilEnd = challenge.close_time - now;
    
    return timeUntilEnd <= effectiveBoostTime && timeUntilEnd > 0;
};

module.exports = {
    isWithinLastHour,
    isWithinLastMinuteThreshold,
    getEffectiveExposureThreshold,
    getEffectiveLastHourExposureThreshold,
    evaluateVotingDecision,
    evaluateManualVotingDecision,
    getEffectiveBoostTime,
    shouldApplyBoost,
}; 