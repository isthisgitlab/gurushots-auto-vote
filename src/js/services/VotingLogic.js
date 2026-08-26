// @ts-check
/**
 * Voting Logic Service
 *
 * Centralized business logic for voting decisions.
 * This service contains all the voting rules and logic that was previously
 * duplicated across api/main.js, mock/index.js, and index.js
 */

// Cast to any at the boundary: the settings facade isn't `// @ts-check`ed yet,
// and its `challengeId = null` defaults make TS infer param types too narrow
// (null) to accept the string IDs passed here. Drop the cast once settings.js
// is typed.
const settings = /** @type {any} */ (require('../settings'));
// Single source of truth for the auto-fill schedule threshold math (no import
// cycle: autoFill.js does not require VotingLogic). Cast for the same
// boundary reason as settings above — autoFill.js isn't `// @ts-check`ed yet.
const { getNextScheduleThresholdSec } = /** @type {any} */ (require('./autoFill'));
// Pure wall-clock math for the scheduled-fill feature (no import cycle:
// wallClock.js imports nothing). Cast for the same boundary reason as the
// two imports above — wallClock.js isn't `// @ts-check`ed yet.
const { occurrencesOf } = /** @type {any} */ (require('../scheduling/wallClock'));
const { isBoostWindowOpen: boostWindowOpen } = require('../voting/boostWindow');
const { DEFAULT_TIMEZONE } = require('../settings/uiDefaults');
// From settings/limits (not settings/schema) — keeps zod out of any bundle
// that reaches this module. No `any` cast needed: limits.js exports a plain
// number literal, so inference is already exact.
const { MAX_SCHEDULED_FILL_ENTRIES } = require('../settings/limits');

/**
 * Scheduled-fill state for a challenge at `now`.
 *
 * Both triggers are LISTS (issue #26 follow-up): every scheduledFillTime
 * entry opens its own daily window and every scheduledFillBeforeEnd entry its
 * own one-shot window, all sharing scheduledFillWindowMinutes, all OR'd —
 * `inWindow` is true when `now` sits inside ANY entry's
 * `[start, start + window]` interval.
 *
 * `active` is true only when useScheduledFill is on AND at least one USABLE
 * entry exists across both lists (a parseable 'HH:MM', or an offset > 0).
 * This is what keeps "enabled with no times" a harmless no-op: an
 * `active = useScheduledFill` shortcut would let replace mode permanently
 * block all threshold voting with no window ever opening. A corrupt entry
 * inside a list is skipped (contributing nothing, not even `active`); a
 * whole value that isn't an array turns that form off.
 *
 * The whole body is wrapped in try/catch returning the inactive state — the
 * same posture (and reason) as getExposureResolver in settings.js: this runs
 * inside the per-challenge voting loop, which has no per-iteration catch, so
 * a corrupt hand-edited override must degrade this one challenge's scheduled
 * fill to "off" rather than abort voting for every remaining challenge.
 *
 * Unlike isWithinLastHour/isWithinLastMinuteThreshold, the time-of-day form
 * doesn't compare against close_time — callers only iterate the API's active
 * (still-open) challenge list, so a stale in-window verdict for a closed
 * challenge can't occur there. A future caller feeding a broader list should
 * pre-filter on `close_time > now` (as soonestScheduledStart does).
 *
 * @param {any} challenge
 * @param {string} challengeId
 * @param {number} now - Current time (Unix timestamp, seconds)
 * @returns {{active: boolean, inWindow: boolean, replaces: boolean}}
 */
const getScheduledFillState = (challenge, challengeId, now) => {
    const inactive = { active: false, inWindow: false, replaces: false };
    try {
        if (settings.getEffectiveSetting('useScheduledFill', challengeId) !== true) return inactive;

        // Corrupt window minutes fail soft to the schema default rather than
        // to "never in window" — with replace mode on, a NaN window would
        // otherwise silently block all threshold voting for the challenge.
        // Deliberately no schema-floor clamp: a hand-edited finite positive
        // value below the schema's min(5) is honored as typed (it's out of
        // range, not corrupt) — only non-numeric/non-positive values fall back.
        const windowMin = Number(settings.getEffectiveSetting('scheduledFillWindowMinutes', challengeId));
        const windowSec = (Number.isFinite(windowMin) && windowMin > 0 ? windowMin : 60) * 60;
        const timezone = settings.getSetting('timezone') || DEFAULT_TIMEZONE;
        // Both triggers are LISTS — every entry opens its own window, all OR'd.
        // Non-array corruption = form off; a corrupt ENTRY inside the array is
        // skipped (contributes nothing, not even `active`). The slice bounds
        // per-cycle Intl work against a post-migration hand-edited oversized
        // array (the write path and the load-time bounds pass both cap at
        // MAX_SCHEDULED_FILL_ENTRIES already).
        const rawTimes = settings.getEffectiveSetting('scheduledFillTime', challengeId);
        const times = (Array.isArray(rawTimes) ? rawTimes : []).slice(0, MAX_SCHEDULED_FILL_ENTRIES);
        const rawBefores = settings.getEffectiveSetting('scheduledFillBeforeEnd', challengeId);
        const befores = (Array.isArray(rawBefores) ? rawBefores : []).slice(0, MAX_SCHEDULED_FILL_ENTRIES);

        let active = false;
        let inWindow = false;

        // Time-of-day entries: unparseable values yield null → entry skipped.
        for (const entry of times) {
            const occ = occurrencesOf(entry, timezone, now);
            if (!occ) continue;
            active = true;
            if (now - occ.prev <= windowSec) inWindow = true;
        }
        // Before-end entries: NaN and non-positives fail the > 0 gate → skipped.
        for (const entry of befores) {
            const beforeEndSec = Number(entry);
            if (!(beforeEndSec > 0)) continue;
            active = true;
            const start = Number(challenge.close_time) - beforeEndSec;
            if (now >= start && now - start <= windowSec) inWindow = true;
        }

        if (!active) return inactive;
        return {
            active,
            inWindow,
            replaces: settings.getEffectiveSetting('scheduledFillReplaces', challengeId) === true,
        };
    } catch {
        return inactive;
    }
};

/**
 * Intermediate result from the shared rule engine (`_runVotingRules`); the
 * per-mode wrappers map it onto their caller-facing shapes.
 * @typedef {object} VotingRuleResult
 * @property {boolean} eligible
 * @property {boolean} atTarget
 * @property {string|null} skipReason
 * @property {number} targetExposure
 * @property {string|null} ruleLabel
 * @property {*} thresholdInfo
 * @property {boolean} forcedByNewEntry - True only when a detected new entry
 *   actually CHANGED the outcome: exposure was at/above the trigger and the vote
 *   happens anyway. False on every blocked path, and false when the challenge was
 *   already eligible on its own.
 */

/**
 * @typedef {object} AutoVoteDecision
 * @property {boolean} shouldVote
 * @property {string} voteReason
 * @property {number} targetExposure
 * @property {boolean} forcedByNewEntry - Surfaced so the orchestrator can tell a
 *   new-entry-forced vote from an organic one without re-deriving the rule. It
 *   only preserves the trigger (skips recording the entry snapshot) when a FORCED
 *   vote throws; an organic vote's eligibility recurs by itself next cycle.
 */

/**
 * @typedef {object} ManualVoteDecision
 * @property {boolean} shouldAllowVoting
 * @property {string} errorMessage
 * @property {number} targetExposure
 */

/**
 * @typedef {object} TurboDecision
 * @property {boolean} apply
 * @property {string|null} imageId
 * @property {boolean} fillNew
 * @property {string} reason
 */

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
 * Resolve the effective normal-rule vote target. The schema sentinel `0` means
 * "follow the exposure trigger" (legacy behavior — target == trigger).
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
 * Resolve the effective last-hour-rule vote target. Sentinel `0` means
 * "follow the lastHourExposure trigger".
 * @param {string} challengeId - Challenge ID
 * @returns {number} - Effective target percentage
 */
const getEffectiveLastHourExposureTarget = (challengeId) => {
    const raw = settings.getEffectiveSetting('lastHourExposureTarget', challengeId);
    return raw === 0 || raw == null ? getEffectiveLastHourExposureThreshold(challengeId) : raw;
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
 *
 * @param {any} challenge
 * @param {number} now
 * @param {'auto'|'manual'} mode
 * @param {{hasNewEntry?: boolean}} [options] - `hasNewEntry` is supplied
 *   ALREADY GATED on the voteOnNewEntry setting by the caller (the orchestrator
 *   owns that read). Deliberately not read here: two reads of the same key in two
 *   layers would drift.
 * @returns {VotingRuleResult}
 */
const _runVotingRules = (challenge, now, mode, options = {}) => {
    const challengeId = challenge.id.toString();
    const hasNewEntry = options.hasNewEntry === true;

    const onlyBoost = mode === 'auto' && settings.getEffectiveSetting('onlyBoost', challengeId);
    const voteOnlyInLastMinute = settings.getEffectiveSetting('voteOnlyInLastMinute', challengeId);
    const effectiveThreshold = getEffectiveExposureThreshold(challengeId);
    const effectiveLastMinuteThreshold = settings.getEffectiveSetting('lastMinuteThreshold', challengeId);
    const effectiveLastHourExposure = getEffectiveLastHourExposureThreshold(challengeId);
    const useLastHourExposure = settings.getEffectiveSetting('useLastHourExposure', challengeId);
    const effectiveExposureTarget = getEffectiveExposureTarget(challengeId);
    const effectiveLastHourExposureTarget = getEffectiveLastHourExposureTarget(challengeId);

    const isWithinLastMinute = isWithinLastMinuteThreshold(challenge.close_time, now, challengeId);
    const withinLastHour = isWithinLastHour(challenge.close_time, now);
    // Optional-chained for consistency with evaluateManualVotingToHundred and the
    // boost/turbo predicates, which all guard this same tree. An unguarded read here threw
    // out of the per-challenge loop and abandoned every remaining challenge in the pass.
    const currentExposure = challenge?.member?.ranking?.exposure?.exposure_factor ?? 0;

    /** @param {string} skipReason @returns {VotingRuleResult} */
    const blocked = (skipReason) => ({
        eligible: false,
        atTarget: false,
        skipReason,
        targetExposure: 100,
        ruleLabel: null,
        thresholdInfo: null,
        // A new entry never defeats a block — onlyBoost, vote-only-in-last-minute,
        // scheduled-fill-only and not-yet-started are all explicit opt-outs.
        forcedByNewEntry: false,
    });
    // Eligibility uses the trigger ("vote if below"); the loop ceiling uses the target
    // ("vote up to"). For flash and lastminute they are intentionally both 100.
    /**
     * @param {string} ruleLabel
     * @param {number} trigger
     * @param {number} target
     * @param {*} thresholdInfo
     * @returns {VotingRuleResult}
     */
    const decided = (ruleLabel, trigger, target, thresholdInfo) => {
        const wouldBeAtTarget = currentExposure >= trigger;
        // A detected new entry defeats the at-target check only — it never unblocks
        // a blocked rule. Gated on wouldBeAtTarget so `forcedByNewEntry` marks the
        // cases where the flag actually changed the outcome: when exposure is
        // already below the trigger the vote is organic and recurs on its own next
        // cycle, so there is no trigger worth preserving across a failure.
        const forcedByNewEntry = hasNewEntry && wouldBeAtTarget;
        const atTarget = wouldBeAtTarget && !hasNewEntry;
        return {
            eligible: !atTarget,
            atTarget,
            skipReason: null,
            targetExposure: target,
            ruleLabel,
            thresholdInfo: { ...thresholdInfo, currentExposure, trigger },
            forcedByNewEntry,
        };
    };

    const sharedThresholdInfo = {
        effectiveLastMinuteThreshold,
        effectiveThreshold,
        effectiveLastHourExposure,
        effectiveExposureTarget,
        effectiveLastHourExposureTarget,
    };

    if (onlyBoost) return blocked('boost-only mode enabled');
    if (mode === 'auto' && challenge.start_time >= now) return blocked('challenge not started');
    // Symmetric with the not-started guard above. Both time windows below require
    // `timeUntilEnd > 0`, so without this a challenge whose close_time has passed falls all
    // the way through to the *normal* rule and votes — the exact opposite of the intent, and
    // reachable whenever a challenge closes partway through a pass. Placed ahead of the flash
    // branch so a closed flash challenge is skipped too. Auto only, mirroring not-started:
    // the manual to-100% path does its own `close_time <= now` check, and adding a manual
    // block here would surface under the last-minute message this function reuses for every
    // manual skip reason.
    if (mode === 'auto' && challenge.close_time <= now) return blocked('challenge has ended');

    if (challenge.type === 'flash') {
        return decided('flash', 100, 100, sharedThresholdInfo);
    }

    if (voteOnlyInLastMinute && !isWithinLastMinute) {
        return blocked(`vote-only-in-last-threshold: not within last ${effectiveLastMinuteThreshold}m threshold`);
    }

    if (isWithinLastMinute) {
        return decided('lastminute', 100, 100, sharedThresholdInfo);
    }

    // Scheduled fill sits below flash/last-minute (which always win) and above
    // the threshold rules (which it can replace). Computed lazily here so the
    // extra settings reads and Intl work only happen when they can matter.
    const sched = getScheduledFillState(challenge, challengeId, now);
    if (sched.active && sched.inWindow) {
        return decided('scheduled', 100, 100, sharedThresholdInfo);
    }
    // Replace mode blocks the threshold rules (normal AND last-hour) outside
    // the window — auto only, mirroring onlyBoost: a manual vote is explicit
    // user intent and is never refused just because a schedule exists.
    if (mode === 'auto' && sched.active && sched.replaces) {
        return blocked('scheduled-fill-only: outside scheduled fill window');
    }

    if (withinLastHour && useLastHourExposure) {
        return decided('last-hour', effectiveLastHourExposure, effectiveLastHourExposureTarget, sharedThresholdInfo);
    }

    return decided('normal', effectiveThreshold, effectiveExposureTarget, sharedThresholdInfo);
};

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
        };

    const {
        currentExposure,
        trigger,
        effectiveThreshold,
        effectiveLastHourExposure,
        effectiveLastMinuteThreshold,
        effectiveExposureTarget,
        effectiveLastHourExposureTarget,
    } = r.thresholdInfo;

    // A forced vote needs its own phrasing, not a suffix on the normal one. The
    // per-label templates below choose their comparison from `eligible`/`atTarget`,
    // and forcing flips those — so reusing them would emit a literally false
    // sentence ("exposure 100% < 90%") for precisely the case someone is reading
    // the log to understand. Any of the five labels can be forced, so this branch
    // covers all of them before the map is consulted.
    if (r.forcedByNewEntry) {
        /** @type {Record<string, string>} */
        const forcedLabels = {
            flash: 'flash type',
            lastminute: `lastminute threshold (${effectiveLastMinuteThreshold}m)`,
            scheduled: 'scheduled fill window',
            'last-hour': 'last hour threshold',
            normal: 'normal threshold',
        };
        const labelText = forcedLabels[/** @type {string} */ (r.ruleLabel)];
        // For the always-100 rules the trigger equals the exposure by construction,
        // so "exposure 100% >= 100%" would be a tautology rather than information.
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
        scheduled: r.atTarget
            ? 'scheduled fill: exposure already at 100%'
            : `scheduled fill window: exposure ${currentExposure}% < 100%`,
        'last-hour': r.eligible
            ? `last hour threshold: exposure ${currentExposure}% < ${effectiveLastHourExposure}%${targetSuffix(effectiveLastHourExposure, effectiveLastHourExposureTarget)}`
            : `last hour threshold: exposure ${currentExposure}% >= ${effectiveLastHourExposure}%`,
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
        const { effectiveLastMinuteThreshold, effectiveThreshold, effectiveLastHourExposure } = r.thresholdInfo;
        /** @type {Record<string, string>} */
        const messages = {
            flash: `Challenge "${challengeTitle}" already has 100% exposure (flash type)`,
            lastminute: `Challenge "${challengeTitle}" already has 100% exposure (lastminute threshold: ${effectiveLastMinuteThreshold}m)`,
            scheduled: `Challenge "${challengeTitle}" already has 100% exposure (scheduled fill window)`,
            'last-hour': `Challenge "${challengeTitle}" already has ${effectiveLastHourExposure}% exposure (last hour threshold)`,
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
 * True when the per-challenge Emergency Fill window is enabled (> 0) and the
 * challenge is currently inside it (closing within that many seconds). Mirrors
 * the window check in autoFill.maybeEmergencyFillChallenge.
 *
 * Used by the boost/turbo APPLY paths so that at the buzzer an available boost
 * or won turbo gets used even when its own auto-apply toggle is off — an unused
 * boost/turbo on a closing challenge is simply wasted. Returns false (no
 * override) when Emergency Fill is disabled, so a user can opt out by setting it
 * to 0.
 * @param {any} challenge
 * @param {number} now - Unix timestamp in seconds
 * @returns {boolean}
 */
const isWithinEmergencyWindow = (challenge, now) => {
    if (!challenge) return false;
    const challengeId = challenge.id?.toString?.() || '';
    const emergencySeconds = settings.getEffectiveSetting('emergencyFill', challengeId);
    if (!Number.isFinite(emergencySeconds) || emergencySeconds <= 0) return false;
    const closeTime = Number(challenge.close_time);
    if (!Number.isFinite(closeTime)) return false;
    const secondsRemaining = closeTime - now;
    return secondsRemaining > 0 && secondsRemaining <= emergencySeconds;
};

/**
 * Check if boost should be applied to a challenge
 * - Timer-based available (state === 'AVAILABLE' with timeout):
 *   apply when timeUntilBoostExpires <= effectiveBoostTime
 * - Key-unlocked available (state === 'AVAILABLE_KEY' or available with no timeout):
 *   ignore boost timer completely and apply only if challenge ends in next 15 minutes
 * @param {any} challenge - Challenge object
 * @param {number} now - Current time (Unix timestamp)
 * @param {{emergency?: boolean}} [options] - When `emergency` is true and the
 *   challenge is inside the Emergency Fill window, apply any available boost
 *   regardless of the autoBoost toggle or the boostTime window.
 * @returns {boolean} - True if boost should be applied
 */
const shouldApplyBoost = (challenge, now, options = {}) => {
    if (!challenge) return false;

    // Never apply if challenge already ended or not started yet
    if (challenge.close_time <= now) return false;

    const challengeId = challenge.id?.toString?.() || '';

    // Emergency override: inside the Emergency Fill window, apply an available
    // boost even when autoBoost is off — at the buzzer an unused boost is wasted.
    const emergency = options.emergency === true && isWithinEmergencyWindow(challenge, now);
    if (!emergency && !settings.getEffectiveSetting('autoBoost', challengeId)) return false;

    // In the emergency window the boostTime threshold no longer matters (the
    // challenge is about to close), so apply whenever a boost is actually
    // available to apply — mirrors isBoostWindowOpen.
    if (emergency) return isBoostWindowOpen(challenge, now);

    const effectiveBoostTime = getEffectiveBoostTime(challengeId); // seconds

    const boost = challenge.member?.boost || {};
    const boostState = boost.state;
    const hasTimeout = typeof boost.timeout === 'number' && boost.timeout > 0;

    // Determine if this is a key-unlocked availability
    // Treat AVAILABLE without timeout as key-unlocked as well
    const isKeyUnlocked = boostState === 'AVAILABLE_KEY' || (boostState === 'AVAILABLE' && !hasTimeout);

    const timeUntilEnd = challenge.close_time - now;

    if (isKeyUnlocked) {
        // A key-unlocked boost has no timer of its own, so it is measured against the
        // challenge's close time via its own setting (was a hardcoded 15 minutes).
        return timeUntilEnd > 0 && timeUntilEnd <= getEffectiveKeyUnlockedBoostTime(challengeId);
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
 * Predicate itself is shared with the renderer (voting/boostWindow.js).
 * @param {any} challenge
 * @param {number} now - Unix timestamp in seconds
 * @returns {boolean}
 */
const isBoostWindowOpen = (challenge, now) => boostWindowOpen(challenge?.member?.boost, now);

/**
 * @param {string} challengeId
 * @returns {number}
 */
const getEffectiveTurboTime = (challengeId) => {
    return settings.getEffectiveSetting('turboTime', challengeId);
};

/**
 * Resolve a 1-indexed entry-index setting (turboImageIndex / boostImageIndex)
 * to the actual entries[] array slot. Returns null ONLY for empty/non-array
 * input; on any non-empty array, always returns a valid integer slot in
 * [0, entries.length - 1].
 *   - empty / non-array entries → null
 *   - non-integer or negative requestedIndex (corrupt settings, undefined reads)
 *     → slot 0 (first entry) rather than propagating NaN
 *   - 0 → last entry slot (sentinel)
 *   - positives → clamped to [0, entries.length - 1]
 *
 * @param {*} entries
 * @param {*} requestedIndex
 * @returns {number|null}
 */
const resolveEntryIndex = (entries, requestedIndex) => {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    if (!Number.isInteger(requestedIndex) || requestedIndex < 0) return 0;
    if (requestedIndex === 0) return entries.length - 1;
    return Math.min(entries.length - 1, requestedIndex - 1);
};

/**
 * Pick the entry at the configured 1-indexed slot, falling back to the
 * entry one position earlier (wrapping past slot 0 to the last entry)
 * if the configured entry already has the conflicting action applied.
 *
 * GuruShots permits at most one turbo and one boost per challenge, on
 * different entries. So when boost is picking an entry it must avoid the
 * turboed one (conflictField='turbo'); when turbo is picking it must avoid
 * the boosted one (conflictField='boosted'). A single-step backward fallback
 * is always sufficient — unless the challenge has only one entry and that
 * one is already in the conflicting state, in which case returns null.
 *
 * @param {*} entries
 * @param {*} requestedIndex
 * @param {string} conflictField
 * @returns {*}
 */
const pickEntryAvoidingConflict = (entries, requestedIndex, conflictField) => {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    // Non-empty array guaranteed above, so resolveEntryIndex returns a number.
    let slot = /** @type {number} */ (resolveEntryIndex(entries, requestedIndex));
    if (entries[slot]?.[conflictField]) {
        slot = (slot - 1 + entries.length) % entries.length;
    }
    return entries[slot]?.[conflictField] ? null : entries[slot];
};

/**
 * Pick the entry a boost should land on: `boostImageIndex` (1-indexed, 0 = last), stepping
 * off any entry that already carries turbo. Symmetric to shouldApplyTurbo's own pick, which
 * avoids boosted entries.
 *
 * Lives here rather than privately inside api/boost.js so the mock boost surface resolves the
 * SAME entry the real one does. Both then raise the conflict flag on it, which is what keeps
 * the same-pass "boost and turbo never share an entry" rule true in mock mode too — the mock
 * runs the identical shared voting pass, so a rule that only held on the real surface would
 * make mock runs quietly diverge.
 *
 * @param {any} challenge
 * @param {string} challengeId
 * @returns {any|null} the entry to boost, or null when every candidate is turboed
 */
const pickBoostEntry = (challenge, challengeId) => {
    const entries = challenge?.member?.ranking?.entries;
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const requestedIndex = settings.getEffectiveSetting('boostImageIndex', challengeId);
    return pickEntryAvoidingConflict(entries, requestedIndex, 'turbo');
};

/**
 * Decides whether to play the Turbo mini-game on a challenge.
 * @param {any} challenge
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
 *
 * When `turboFillNew` is on the caller will submit a fresh photo and Turbo
 * that instead of an existing entry, so the "no entries" guard is relaxed
 * (fill-new can create the first entry) and `imageId` is returned only as a
 * fallback target for when the fresh submit can't happen.
 *
 * @param {any} challenge
 * @param {number} now - Unix timestamp in seconds
 * @param {{emergency?: boolean}} [options] - When `emergency` is true and the
 *   challenge is inside the Emergency Fill window, apply a won turbo regardless
 *   of the useTurbo toggle, the turboTime window, or an open boost window.
 * @returns {{apply: boolean, imageId: string|null, fillNew: boolean, reason: string}}
 */
const shouldApplyTurbo = (challenge, now, options = {}) => {
    /** @param {string} reason @returns {TurboDecision} */
    const noop = (reason) => ({ apply: false, imageId: null, fillNew: false, reason });
    if (!challenge) return noop('no challenge');
    if (challenge.close_time <= now) return noop('challenge ended');

    const challengeId = challenge.id?.toString?.() || '';

    // Emergency override: inside the Emergency Fill window, apply a won turbo
    // even when useTurbo is off — at the buzzer an unused turbo is wasted. The
    // turboTime threshold and the turboApplyWhenBoostActive guard below are also
    // skipped in this case (the challenge is about to close, and any available
    // boost is applied alongside turbo on a separate entry).
    const emergency = options.emergency === true && isWithinEmergencyWindow(challenge, now);
    if (!emergency && !settings.getEffectiveSetting('useTurbo', challengeId)) return noop('useTurbo disabled');

    const turbo = challenge.member?.turbo || {};
    if (turbo.state !== 'WON') return noop(`turbo state ${turbo.state || 'unknown'}`);

    if (!emergency) {
        const effectiveTurboTime = getEffectiveTurboTime(challengeId);
        const timeUntilEnd = challenge.close_time - now;
        if (timeUntilEnd > effectiveTurboTime) {
            return noop(
                `${Math.floor(timeUntilEnd / 60)}m remaining > ${Math.floor(effectiveTurboTime / 60)}m threshold`,
            );
        }

        const allowDuringBoost = settings.getEffectiveSetting('turboApplyWhenBoostActive', challengeId);
        if (!allowDuringBoost && isBoostWindowOpen(challenge, now)) {
            return noop('boost window currently open');
        }
    }

    const fillNew = settings.getEffectiveSetting('turboFillNew', challengeId) === true;

    // Resolve the existing-entry pick. With fill-new on it is only the
    // fallback target (used when no fresh photo can be submitted), so an
    // empty/conflicting entry list is fine — fill-new creates a new entry.
    const entries = challenge.member?.ranking?.entries;
    const hasEntries = Array.isArray(entries) && entries.length > 0;
    const requestedIndex = settings.getEffectiveSetting('turboImageIndex', challengeId);
    const picked = hasEntries ? pickEntryAvoidingConflict(entries, requestedIndex, 'boosted') : null;
    const existingImageId = picked?.id || null;

    if (fillNew) {
        return { apply: true, imageId: existingImageId, fillNew: true, reason: 'eligible (fill-new)' };
    }

    if (!hasEntries) {
        return noop('no entries to apply turbo to');
    }
    if (!picked) {
        // The invariant (≤1 boost per challenge) means picker-null is only
        // reachable when entries.length === 1 and that entry has Boost.
        return noop('only entry already has Boost applied');
    }
    if (!existingImageId) return noop('selected entry has no id');
    return { apply: true, imageId: existingImageId, fillNew: false, reason: 'eligible' };
};

/**
 * Effective seconds-before-close at which the next auto-fill becomes due:
 * the largest autoFillSchedule threshold whose target count hasn't been met
 * yet, straight from autoFill.getNextScheduleThresholdSec (single source of
 * truth — it does the end-alignment shift for challenges allowing fewer
 * images than the schedule covers, plus the clamping and defensive parsing).
 * With every row satisfied, shifted/clamped away, or no schedule, the window
 * never opens (0).
 * Note: the entry count is read live, so this is a snapshot at call time
 * (orderDeadlineActions is called once per challenge before the runners
 * execute).
 * @param {any} challenge
 * @param {string} challengeId
 * @returns {number}
 */
const getAutoFillThresholdSec = (challenge, challengeId) => {
    const entries = challenge?.member?.ranking?.entries;
    const entryCount = Array.isArray(entries) ? entries.length : 0;
    const schedule = settings.getEffectiveSetting('autoFillSchedule', challengeId);
    return getNextScheduleThresholdSec(schedule, entryCount, challenge?.max_photo_submits);
};

/**
 * Effective seconds-before-close at which emergency fill activates (0 = off).
 * @param {string} challengeId
 * @returns {number}
 */
const getEmergencyFillThresholdSec = (challengeId) => {
    const seconds = settings.getEffectiveSetting('emergencyFill', challengeId);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
};

/**
 * Effective seconds-before-close at which boost becomes due. Key-unlocked
 * boosts apply inside the fixed 15m closing window; timer-based boosts apply
 * when `timeUntilBoostExpires <= boostTime`, converted to a seconds-before-close
 * figure (`close_time - boost.timeout + boostTime`) so it's comparable to the
 * other deadline actions. `boost.timeout` is an absolute Unix-epoch timestamp
 * (same contract shouldApplyBoost relies on via `boost.timeout - now`), NOT a
 * countdown; the formula assumes the normal `close_time > boost.timeout` case.
 * Malformed data where the boost expires after close yields a negative figure,
 * which only sorts boost later — its handler (shouldApplyBoost) is still the
 * source of truth for whether to actually apply. Returns -Infinity when no boost
 * is available, so the boost action sorts last.
 * @param {any} challenge
 * @param {string} challengeId
 * @returns {number}
 */
const getBoostThresholdSec = (challenge, challengeId) => {
    const boost = challenge?.member?.boost || {};
    const hasTimeout = typeof boost.timeout === 'number' && boost.timeout > 0;
    if (boost.state === 'AVAILABLE_KEY' || (boost.state === 'AVAILABLE' && !hasTimeout)) {
        return getEffectiveKeyUnlockedBoostTime(challengeId); // mirrors shouldApplyBoost
    }
    if (boost.state === 'AVAILABLE' && hasTimeout) {
        const boostTime = getEffectiveBoostTime(challengeId);
        return Number(challenge.close_time) - boost.timeout + boostTime;
    }
    return -Infinity;
};

/**
 * Order the per-challenge deadline actions by the seconds-before-close at which
 * each becomes due, largest window first — so actions fire in the order their
 * configured timers imply rather than a fixed code order. Each action's own
 * handler still decides whether to actually act; this only fixes ordering.
 *
 * The ordering is therefore user-controlled: it falls out of the time settings, so
 * widening turboTime or boostTime moves that action earlier in the pass. With the
 * defaults (turboTime 7200, autoFill's top row 1800, emergencyFill 300) the real
 * order is turbo → autoFill → emergencyFill → boost. An earlier version of this
 * comment gave "auto-fill 15m → turbo 12m" as the worked example, which inverted
 * what the defaults actually produce; the numbers, not the code order, decide.
 *
 * Note this sorts turbo on its configured window even when no turbo is held or
 * Auto-Apply Turbo is off — the runner then no-ops. That keeps the ordering a pure
 * function of the settings rather than of live challenge state.
 *
 * Tie-break (stable): autoFill → emergencyFill → boost → turbo, so fills and
 * boost precede turbo and a freshly filled (and locally reflected) entry is
 * available when turbo runs on a tie.
 *
 * @param {any} challenge
 * @returns {Array<{action: 'autoFill'|'turbo'|'emergencyFill'|'boost', thresholdSec: number}>}
 */
const orderDeadlineActions = (challenge) => {
    const challengeId = challenge?.id?.toString?.() || '';
    /** @type {Record<string, number>} */
    const tieOrder = { autoFill: 0, emergencyFill: 1, boost: 2, turbo: 3 };
    /** @type {Array<{action: 'autoFill'|'turbo'|'emergencyFill'|'boost', thresholdSec: number}>} */
    const actions = [
        { action: 'autoFill', thresholdSec: getAutoFillThresholdSec(challenge, challengeId) },
        { action: 'turbo', thresholdSec: getEffectiveTurboTime(challengeId) },
        { action: 'emergencyFill', thresholdSec: getEmergencyFillThresholdSec(challengeId) },
        { action: 'boost', thresholdSec: getBoostThresholdSec(challenge, challengeId) },
    ];
    return actions.sort((a, b) => {
        if (b.thresholdSec !== a.thresholdSec) return b.thresholdSec - a.thresholdSec;
        return tieOrder[a.action] - tieOrder[b.action];
    });
};

/**
 * Read-only, renderer-facing description of a challenge's upcoming deadline
 * actions: the ordered actions that will ACTUALLY fire (gated on the same
 * conditions the runner uses, not merely on a positive threshold) plus each
 * one's absolute due instant, and the boost/turbo conflict flag.
 *
 * Gating matters because several threshold getters stay positive even when the
 * feature is off or the resource isn't held:
 *   - turbo: getEffectiveTurboTime defaults to 7200 even with no turbo — show
 *     only when a turbo is WON and Auto-Apply Turbo is on.
 *   - boost: getBoostThresholdSec's timer branch stays positive when
 *     boostTime=0 ("off") — re-check that, and honour the autoBoost toggle.
 *   - autoFill: gate on the autoFill toggle (a schedule can imply a threshold
 *     while auto-fill is disabled).
 *   - a threshold of 0 / -Infinity means off/n-a (auto-fill satisfied,
 *     emergency-fill off, key-unlocked boost off) — always omitted.
 *
 * Purely reads the passed challenge object (never mutates it, never calls an
 * apply path), so it cannot perturb a concurrent sequential voting pass. The
 * entry count is read at call time, so this is a snapshot that can drift from
 * what the runner later sees after a mid-cycle fill — callers must present it
 * as advisory.
 *
 * @param {any} challenge
 * @param {number} now - Unix timestamp in seconds
 * @returns {{actions: Array<{action: string, thresholdSec: number, dueAt: number|null}>, boostBlocked: boolean}}
 */
const describeDeadlineActions = (challenge, now) => {
    const challengeId = challenge?.id?.toString?.() || '';
    const closeTime = Number(challenge?.close_time);
    const boost = challenge?.member?.boost || {};
    const boostHasTimeout = typeof boost.timeout === 'number' && boost.timeout > 0;
    const boostTimerBranch = boost.state === 'AVAILABLE' && boostHasTimeout;
    const turboState = challenge?.member?.turbo?.state;

    const isVisible = (action, thresholdSec) => {
        if (!Number.isFinite(thresholdSec) || thresholdSec <= 0) return false;
        switch (action) {
            case 'turbo':
                return turboState === 'WON' && settings.getEffectiveSetting('useTurbo', challengeId) === true;
            case 'boost':
                if (settings.getEffectiveSetting('autoBoost', challengeId) !== true) return false;
                // Timer branch stays positive at boostTime=0 (off); key-unlocked
                // branch already resolves to 0 when off and is dropped above.
                if (boostTimerBranch && !(getEffectiveBoostTime(challengeId) > 0)) return false;
                return true;
            case 'autoFill':
                return settings.getEffectiveSetting('autoFill', challengeId) === true;
            case 'emergencyFill':
                return true; // thresholdSec > 0 already means enabled (0 = off)
            default:
                return false;
        }
    };

    const actions = orderDeadlineActions(challenge)
        .filter(({ action, thresholdSec }) => isVisible(action, thresholdSec))
        .map(({ action, thresholdSec }) => ({
            action,
            thresholdSec,
            dueAt: Number.isFinite(closeTime) ? closeTime - thresholdSec : null,
        }));

    // Boost/turbo conflict: a boost is available to place, there IS an entry to
    // place it on, but every candidate entry is already turboed. The
    // entries.length >= 1 guard is required — pickBoostEntry also returns null
    // when there are simply no entries yet (a freshly joined challenge before
    // auto-fill), which is NOT a conflict.
    const entries = challenge?.member?.ranking?.entries;
    const boostBlocked =
        isBoostWindowOpen(challenge, now) &&
        Array.isArray(entries) &&
        entries.length >= 1 &&
        pickBoostEntry(challenge, challengeId) === null;

    return { actions, boostBlocked };
};

module.exports = {
    isWithinLastHour,
    isWithinLastMinuteThreshold,
    getEffectiveExposureThreshold,
    getEffectiveLastHourExposureThreshold,
    getEffectiveExposureTarget,
    getEffectiveLastHourExposureTarget,
    getScheduledFillState,
    evaluateVotingDecision,
    evaluateManualVotingDecision,
    evaluateManualVotingToHundred,
    getEffectiveBoostTime,
    getEffectiveKeyUnlockedBoostTime,
    pickBoostEntry,
    isWithinEmergencyWindow,
    shouldApplyBoost,
    isBoostWindowOpen,
    getEffectiveTurboTime,
    shouldPlayAutoTurbo,
    shouldApplyTurbo,
    resolveEntryIndex,
    pickEntryAvoidingConflict,
    getAutoFillThresholdSec,
    getEmergencyFillThresholdSec,
    getBoostThresholdSec,
    orderDeadlineActions,
    describeDeadlineActions,
};
