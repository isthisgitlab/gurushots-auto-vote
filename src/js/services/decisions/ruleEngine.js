// @ts-check
/**
 * The shared voting-rule engine behind the auto- and manual-vote evaluators.
 * Rule precedence in `_runVotingRules` is load-bearing. Part of the
 * services/VotingLogic facade.
 */

// Cast to any at the boundary: the settings facade isn't `// @ts-check`ed yet,
// and its `challengeId = null` defaults make TS infer param types too narrow
// (null) to accept the string IDs passed here. Drop the cast once settings.js
// is typed.
const settings = /** @type {any} */ (require('../../settings'));
const {
    isWithinFinalWindow,
    getEffectiveLastMinuteThreshold,
    isWithinLastMinuteThreshold,
    getEffectiveExposureThreshold,
    getEffectiveFinalWindowExposureThreshold,
    getEffectiveExposureTarget,
    getEffectiveFinalWindowExposureTarget,
} = require('./thresholds');
const { getScheduledFillState, getVotingPauseState } = require('./triggerWindows');
const { getBoostPrefillState } = require('./boostPrefill');

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
 *   actually CHANGED the outcome: exposure was at/above the trigger but still
 *   below the target, so the vote happens anyway. False on every blocked path,
 *   once the target is met, and when the challenge was already eligible on its own.
 * @property {boolean} [preservesNewEntryTrigger] - Set on a blocked path that
 *   DEFERS rather than cancels: the orchestrator must keep any new-entry trigger
 *   armed instead of disarming it. Only the voting pause sets it.
 */

/**
 * Shared rule engine for the auto-vote and manual-vote evaluators.
 * Returns an intermediate result the per-mode wrappers map onto their
 * caller-facing shape:
 *
 *   { eligible:      true | false,
 *     skipReason:    string | null,   // when eligible=false because a rule blocked
 *     atTarget:      true | false,    // when exposure already meets target
 *     targetExposure:number,
 *     ruleLabel:     string,          // 'flash', 'lastminute', 'scheduled', 'pre-final-window', 'final-window', 'normal'
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
    // Same clamped value the gate uses, so a message can never quote a
    // threshold the rule didn't actually apply.
    const effectiveLastMinuteThreshold = getEffectiveLastMinuteThreshold(challengeId);
    const effectiveFinalWindowExposure = getEffectiveFinalWindowExposureThreshold(challengeId);
    const useFinalWindowExposure = settings.getEffectiveSetting('useFinalWindowExposure', challengeId);
    const effectiveExposureTarget = getEffectiveExposureTarget(challengeId);
    const effectiveFinalWindowExposureTarget = getEffectiveFinalWindowExposureTarget(challengeId);
    const voteBeforeFinalWindow = settings.getEffectiveSetting('voteBeforeFinalWindow', challengeId) === true;
    // Configurable final-window duration (seconds before close). Under-mocked
    // callers / hand-edited files can yield a non-number; the schema guarantees a
    // valid integer >= 60 otherwise. Fall back to the legacy fixed hour (3600)
    // rather than propagate NaN into the window math below.
    const rawFinalWindowSec = settings.getEffectiveSetting('finalWindowDuration', challengeId);
    const finalWindowSec = Number.isFinite(rawFinalWindowSec) && rawFinalWindowSec >= 60 ? rawFinalWindowSec : 3600;
    // Under-mocked callers / hand-edited files can yield a non-number here; the
    // schema guarantees 1..59 otherwise. Fall back to the schema default (15)
    // rather than propagate NaN into the window math below.
    const rawLeadMin = settings.getEffectiveSetting('voteBeforeFinalWindowLeadMin', challengeId);
    // Clamp to the schema's valid range (1..59). Anything outside — a hand-edited
    // sub-minute value, an over-59 value, or a non-number — falls back to the
    // default (15). The lower bound MUST match soonestFinalWindowTopUpStart's guard
    // in thresholdWindow.js (>= 60s) so the vote-rule window and the scheduler's
    // cadence cap can't disagree for the same corrupt input.
    const voteBeforeFinalWindowLeadMin =
        Number.isFinite(rawLeadMin) && rawLeadMin >= 1 && rawLeadMin <= 59 ? rawLeadMin : 15;

    const isWithinLastMinute = isWithinLastMinuteThreshold(challenge.close_time, now, challengeId);
    const withinFinalWindow = isWithinFinalWindow(challenge.close_time, now, finalWindowSec);
    // Top-up window straddling the final-window boundary:
    // [close-finalWindowSec-lead, close-finalWindowSec+lead]. Only meaningful when
    // both the final-window feature and this opt-in are on (it exists to fix the
    // final-window rule's low-trigger blind spot).
    const timeUntilEnd = challenge.close_time - now;
    const preFinalWindowLeadSec = voteBeforeFinalWindowLeadMin * 60;
    const withinPreFinalWindowTopUp =
        voteBeforeFinalWindow &&
        useFinalWindowExposure &&
        timeUntilEnd > 0 &&
        timeUntilEnd <= finalWindowSec + preFinalWindowLeadSec &&
        timeUntilEnd >= finalWindowSec - preFinalWindowLeadSec;
    // Optional-chained for consistency with evaluateManualVotingToHundred and the
    // boost/turbo predicates, which all guard this same tree. An unguarded read here threw
    // out of the per-challenge loop and abandoned every remaining challenge in the pass.
    const currentExposure = challenge?.member?.ranking?.exposure?.exposure_factor ?? 0;

    /**
     * @param {string} skipReason
     * @param {boolean} [preservesNewEntryTrigger] - See the field's note below.
     * @returns {VotingRuleResult}
     */
    const blocked = (skipReason, preservesNewEntryTrigger = false) => ({
        eligible: false,
        atTarget: false,
        skipReason,
        targetExposure: 100,
        ruleLabel: null,
        thresholdInfo: null,
        // A new entry never defeats a block — onlyBoost, vote-only-in-last-minute,
        // scheduled-fill-only, voting-paused and not-yet-started are all explicit
        // opt-outs. For the pause specifically this is the point: a new entry
        // appearing at 03:00 is the exact case the user asked not to spend votes on.
        forcedByNewEntry: false,
        // ...but DEFERRING the vote is not the same as forfeiting it. The
        // orchestrator disarms the new-entry trigger on a blocked decision,
        // which is safe for every other block because each lifts into a rule
        // that votes to 100% anyway. The pause is the one block that lifts into
        // the NORMAL threshold rule, which votes only while exposure is below
        // the trigger — so disarming there would lose the new entry's vote
        // outright. This flag asks the orchestrator to keep the trigger armed
        // until the pause ends.
        preservesNewEntryTrigger,
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
        // A detected new entry may bridge the trigger-to-target gap, but must not
        // defeat the target itself. Otherwise a challenge already full (or past a
        // lower final-window target) fetches 100 images only to discard them.
        // Gating on wouldBeAtTarget keeps `forcedByNewEntry` limited to cases where
        // the flag changed the outcome; below the trigger it stays organic and recurs.
        const forcedByNewEntry = hasNewEntry && wouldBeAtTarget && currentExposure < target;
        const atTarget = wouldBeAtTarget && !forcedByNewEntry;
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
        effectiveFinalWindowExposure,
        effectiveExposureTarget,
        effectiveFinalWindowExposureTarget,
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

    // Pre-boost fill: vote to 100% for the configured lead before an available
    // boost is auto-applied, so the boost multiplies a full entry rather than a
    // decayed one.
    //
    // Precedence is deliberate. It sits BELOW flash and last-minute, which
    // already vote to 100% anyway, so the ordering is only about which label the
    // log line carries. It sits ABOVE the voting pause for the same reason flash
    // and last-minute do: the boost is spent on the challenge's schedule whatever
    // the user's pause says (boost runs on the orchestrator's own path, ahead of
    // these rules and untouched by the pause), so letting a pause swallow the
    // fill would not defer the cost — it would land the boost on a decayed entry
    // and permanently waste a one-per-challenge resource. And it sits above
    // scheduled fill and all three threshold rules, which vote to lower targets.
    //
    // Auto only, and the guard is load-bearing rather than decorative: a manual
    // vote on a non-flash challenge outside its last-minute window reaches this
    // line, and letting it take the pre-boost path would relabel every such
    // manual skip message as a boost concern. Manual voting has its own
    // to-100% semantics and is never shaped by a boost timer.
    const boostPrefill = mode === 'auto' ? getBoostPrefillState(challenge, challengeId, now) : { inWindow: false };
    if (boostPrefill.inWindow) {
        return decided('pre-boost', 100, 100, sharedThresholdInfo);
    }

    // Voting pause: an opt-in window in which automatic voting is refused, so
    // exposure isn't spent during the overnight lull between match rounds.
    //
    // Precedence is deliberate and load-bearing. It sits BELOW flash,
    // last-minute and the pre-boost fill so a challenge that genuinely closes
    // mid-pause still gets its final fill, and a boost spent mid-pause still
    // lands on a full entry — dropping a placement is a permanent loss and so
    // is wasting a boost, while skipping a
    // night top-up only defers votes to a better hour, and a user pausing
    // 01:30-06:00 is describing the dead time BETWEEN rounds, not asking to
    // forfeit a challenge that ends inside it. It sits ABOVE scheduled fill and
    // all three threshold rules (normal, pre-final-window top-up,
    // final-window), which are exactly the discretionary exposure maintenance
    // the pause exists to defer.
    //
    // Auto only, mirroring onlyBoost: a manual vote is explicit user intent and
    // is never refused because a pause is configured. Boost/turbo are untouched
    // — they run ahead of this on the orchestrator's own path, and their timers
    // expire on the challenge's schedule rather than the user's.
    const pause = getVotingPauseState(challenge, challengeId, now);
    if (mode === 'auto' && pause.active && pause.inWindow) {
        // `true` = keep any new-entry trigger armed across the pause, so the
        // vote a new entry earns is DEFERRED to the end of the pause rather
        // than silently dropped (see `blocked`).
        return blocked('voting paused: inside configured pause window', true);
    }

    // Scheduled fill sits below flash/last-minute (which always win) and above
    // the threshold rules (which it can replace). Computed lazily here so the
    // extra settings reads and Intl work only happen when they can matter.
    const sched = getScheduledFillState(challenge, challengeId, now);
    if (sched.active && sched.inWindow) {
        return decided('scheduled', 100, 100, sharedThresholdInfo);
    }
    // Replace mode blocks the threshold rules (normal AND final-window) outside
    // the window — auto only, mirroring onlyBoost: a manual vote is explicit
    // user intent and is never refused just because a schedule exists.
    if (mode === 'auto' && sched.active && sched.replaces) {
        return blocked('scheduled-fill-only: outside scheduled fill window');
    }

    // Pre-final-window top-up. Placed ABOVE the final-window branch so during the
    // in-window grace part (where withinFinalWindow is already true) it overrides
    // the final-window rule — which, with its lower recovery trigger, would
    // otherwise leave an already-decayed challenge stranded below standard when the
    // window starts. Votes to the STANDARD trigger/target. Self-limiting: the
    // window is time-bounded and `decided` stops once exposure reaches the trigger,
    // so no persisted "already topped up" state is needed. Scheduled fill still
    // wins (handled above); before the boundary this is byte-identical to the
    // normal rule (same trigger/target) — only the label differs, for the scheduler
    // boundary and the log line.
    if (withinPreFinalWindowTopUp) {
        return decided('pre-final-window', effectiveThreshold, effectiveExposureTarget, sharedThresholdInfo);
    }

    if (withinFinalWindow && useFinalWindowExposure) {
        return decided(
            'final-window',
            effectiveFinalWindowExposure,
            effectiveFinalWindowExposureTarget,
            sharedThresholdInfo,
        );
    }

    return decided('normal', effectiveThreshold, effectiveExposureTarget, sharedThresholdInfo);
};

module.exports = {
    _runVotingRules,
};
