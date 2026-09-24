// @ts-check
/**
 * Caller-facing vote decisions: the auto-vote and manual-vote evaluators that
 * map the rule engine's result onto their shapes and messages, plus the
 * threshold-free manual vote-to-100% check. Part of the services/VotingLogic
 * facade.
 */

// Cast to any at the boundary: the settings facade isn't `// @ts-check`ed yet,
// and its `challengeId = null` defaults make TS infer param types too narrow
// (null) to accept the string IDs passed here. Drop the cast once settings.js
// is typed.
const settings = /** @type {any} */ (require('../../settings'));
const { _runVotingRules } = require('./ruleEngine');

/**
 * @typedef {object} AutoVoteDecision
 * @property {boolean} shouldVote
 * @property {string} voteReason
 * @property {number} targetExposure
 * @property {boolean} forcedByNewEntry - Surfaced so the orchestrator can tell a
 *   new-entry-forced vote from an organic one without re-deriving the rule. It
 *   only preserves the trigger (skips recording the entry snapshot) when a FORCED
 *   vote throws; an organic vote's eligibility recurs by itself next cycle.
 * @property {boolean} [preservesNewEntryTrigger] - True when the decision was
 *   blocked by something that DEFERS the vote (the voting pause) rather than
 *   cancelling it, so the orchestrator keeps the new-entry trigger armed.
 */

/**
 * @typedef {object} ManualVoteDecision
 * @property {boolean} shouldAllowVoting
 * @property {string} errorMessage
 * @property {number} targetExposure
 */

/**
 * Auto-vote evaluator. Returns { shouldVote, voteReason, targetExposure, forcedByNewEntry }.
 * @param {any} challenge
 * @param {number} now
 * @param {{hasNewEntry?: boolean}} [options] - `hasNewEntry` must already be gated
 *   on the voteOnNewEntry setting by the caller; see `_runVotingRules`.
 * @returns {AutoVoteDecision}
 */
const evaluateVotingDecision = (challenge, now, options = {}) => {
    const r = _runVotingRules(challenge, now, 'auto', options);
    if (r.skipReason)
        return {
            shouldVote: false,
            voteReason: r.skipReason,
            targetExposure: r.targetExposure,
            forcedByNewEntry: false,
            preservesNewEntryTrigger: r.preservesNewEntryTrigger === true,
        };

    const {
        currentExposure,
        trigger,
        effectiveThreshold,
        effectiveFinalWindowExposure,
        effectiveLastMinuteThreshold,
        effectiveExposureTarget,
        effectiveFinalWindowExposureTarget,
    } = r.thresholdInfo;

    // A forced vote needs its own phrasing, not a suffix on the normal one. The
    // per-label templates below choose their comparison from `eligible`/`atTarget`,
    // and forcing flips those — so reusing them would emit a literally false
    // sentence ("exposure 100% < 90%") for precisely the case someone is reading
    // the log to understand. Any of the labels can be forced, so this branch
    // covers all of them before the map is consulted.
    if (r.forcedByNewEntry) {
        /** @type {Record<string, string>} */
        const forcedLabels = {
            flash: 'flash type',
            lastminute: `lastminute threshold (${effectiveLastMinuteThreshold}m)`,
            'pre-boost': 'pre-boost fill',
            scheduled: 'scheduled fill window',
            'pre-final-window': 'pre-final-window top-up',
            'final-window': 'final window threshold',
            normal: 'normal threshold',
        };
        const labelText = forcedLabels[/** @type {string} */ (r.ruleLabel)];
        // Exposure sitting exactly on a trigger below its target would read as the
        // tautology "exposure 90% >= 90%", so state it as a level instead.
        const state =
            currentExposure === trigger
                ? `exposure already at ${trigger}%`
                : `exposure ${currentExposure}% >= ${trigger}%`;
        return {
            shouldVote: true,
            voteReason: `${labelText}: new entry detected (${state}) — voting up to ${r.targetExposure}%`,
            targetExposure: r.targetExposure,
            forcedByNewEntry: true,
        };
    }
    /** @param {number} trigger @param {number} target @returns {string} */
    const targetSuffix = (trigger, target) => (target !== trigger ? ` (vote up to ${target}%)` : '');
    /** @type {Record<string, string>} */
    const reasons = {
        flash: r.atTarget ? 'flash type: exposure already at 100%' : `flash type: exposure ${currentExposure}% < 100%`,
        lastminute: r.atTarget
            ? `lastminute threshold (${effectiveLastMinuteThreshold}m): exposure already at 100%`
            : `lastminute threshold (${effectiveLastMinuteThreshold}m): exposure ${currentExposure}% < 100%`,
        'pre-boost': r.atTarget
            ? 'pre-boost fill: exposure already at 100%'
            : `pre-boost fill: exposure ${currentExposure}% < 100%`,
        scheduled: r.atTarget
            ? 'scheduled fill: exposure already at 100%'
            : `scheduled fill window: exposure ${currentExposure}% < 100%`,
        'pre-final-window': r.eligible
            ? `pre-final-window top-up: exposure ${currentExposure}% < ${effectiveThreshold}%${targetSuffix(effectiveThreshold, effectiveExposureTarget)}`
            : `pre-final-window top-up: exposure ${currentExposure}% >= ${effectiveThreshold}%`,
        'final-window': r.eligible
            ? `final window threshold: exposure ${currentExposure}% < ${effectiveFinalWindowExposure}%${targetSuffix(effectiveFinalWindowExposure, effectiveFinalWindowExposureTarget)}`
            : `final window threshold: exposure ${currentExposure}% >= ${effectiveFinalWindowExposure}%`,
        normal: r.eligible
            ? `normal threshold: exposure ${currentExposure}% < ${effectiveThreshold}%${targetSuffix(effectiveThreshold, effectiveExposureTarget)}`
            : `normal threshold: exposure ${currentExposure}% >= ${effectiveThreshold}%`,
    };
    return {
        shouldVote: r.eligible,
        voteReason: reasons[/** @type {string} */ (r.ruleLabel)],
        targetExposure: r.targetExposure,
        forcedByNewEntry: false,
    };
};

/**
 * Manual-vote evaluator. Returns { shouldAllowVoting, errorMessage, targetExposure }.
 * @param {any} challenge
 * @param {number} now
 * @param {string} challengeTitle
 * @returns {ManualVoteDecision}
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
        const { effectiveLastMinuteThreshold, effectiveThreshold, effectiveFinalWindowExposure } = r.thresholdInfo;
        /** @type {Record<string, string>} */
        const messages = {
            flash: `Challenge "${challengeTitle}" already has 100% exposure (flash type)`,
            lastminute: `Challenge "${challengeTitle}" already has 100% exposure (lastminute threshold: ${effectiveLastMinuteThreshold}m)`,
            scheduled: `Challenge "${challengeTitle}" already has 100% exposure (scheduled fill window)`,
            'pre-final-window': `Challenge "${challengeTitle}" already has ${effectiveThreshold}% exposure (pre-final-window top-up)`,
            'final-window': `Challenge "${challengeTitle}" already has ${effectiveFinalWindowExposure}% exposure (final window threshold)`,
            normal: `Challenge "${challengeTitle}" already has ${effectiveThreshold}% exposure`,
        };
        return {
            shouldAllowVoting: false,
            errorMessage: messages[/** @type {string} */ (r.ruleLabel)],
            targetExposure: r.targetExposure,
        };
    }

    return { shouldAllowVoting: true, errorMessage: '', targetExposure: r.targetExposure };
};

/**
 * Evaluate whether manual voting to 100% should be allowed on a challenge
 * (Used for manual vote buttons - bypasses all threshold configurations)
 * @param {any} challenge - Challenge object
 * @param {number} now - Current time (Unix timestamp)
 * @param {string} challengeTitle - Challenge title for error messages
 * @returns {Object} - Decision with shouldAllowVoting boolean, errorMessage string, and targetExposure number
 */
const evaluateManualVotingToHundred = (challenge, now, challengeTitle) => {
    // Defensive read — partial API responses (new challenge types, flash
    // variants, server hiccups) can arrive without a ranking node, and
    // throwing here would dump the whole vote-all loop into the per-
    // challenge catch with no useful diagnostic. Match the ?. style
    // shouldApplyBoost / shouldApplyTurbo use on the same tree.
    //
    // Behavioral note: `?? 0` deliberately treats absent ranking as 0%
    // exposure, which lets shouldAllowVoting fire for a brand-new entry
    // that hasn't accumulated any exposure data. The previous (throw)
    // path silently skipped such challenges; the new path attempts the
    // vote, which is more useful for the manual vote-to-100% flow.
    const currentExposure = challenge.member?.ranking?.exposure?.exposure_factor ?? 0;

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

module.exports = {
    evaluateVotingDecision,
    evaluateManualVotingDecision,
    evaluateManualVotingToHundred,
};
