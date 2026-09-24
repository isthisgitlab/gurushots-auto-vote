// @ts-check
/**
 * Pre-boost fill window: the vote-to-100% stretch ahead of an auto-applied
 * boost. Part of the services/VotingLogic facade.
 */

// Cast to any at the boundary: the settings facade isn't `// @ts-check`ed yet,
// and its `challengeId = null` defaults make TS infer param types too narrow
// (null) to accept the string IDs passed here. Drop the cast once settings.js
// is typed.
const settings = /** @type {any} */ (require('../../settings'));
const { boostApplyThreshold } = require('../../voting/boostWindow');
const { getEffectiveBoostTime, getEffectiveKeyUnlockedBoostTime } = require('./thresholds');
// Cast at the boundary for the same reason as settings above — logger.js
// isn't `// @ts-check`ed yet. Used only on the corrupt-config paths below,
// which must not stay silent: the orchestrator's per-challenge catch logs its
// own errors, so a swallowed one here would be strictly less visible.
const logger = /** @type {any} */ (require('../../logger'));
// CR/LF-collapse API-sourced values before they reach a log message (CWE-117).
// Imported directly rather than off the logger, matching newEntryTracker.js —
// the logger is mocked across much of the test suite, and its own oneLine() on
// the finished message is a backstop, not the first line of defence.
const { oneLine: oneLineId } = require('../../format/logSafe');

/**
 * Lead seconds before the boost-apply instant during which the pre-boost fill
 * runs. Clamped to the schema's 1..59 minute range; anything outside it (a
 * hand-edited file, an under-mocked caller, a non-number) falls back to the
 * schema default of 15 minutes. The lower bound MUST match
 * soonestBoostPrefillStart's guard in thresholdWindow.js (>= 60s) so the vote
 * rule and the scheduler's cadence cap can't disagree for the same corrupt input.
 * @param {string} challengeId
 * @returns {number} lead in seconds
 */
const getBoostPrefillLeadSec = (challengeId) => {
    // Coerced, not read raw: both cadence resolvers hand thresholdWindow.js a
    // `Number(...) * 60`, so reading the raw value here would let a hand-edited
    // string ("20") clamp to the 15m default on this side while the scheduler
    // capped on 20m. Coercing keeps the two guards genuinely identical.
    const raw = Number(settings.getEffectiveSetting('voteBeforeBoostLeadMin', challengeId));
    return Number.isFinite(raw) && raw >= 1 && raw <= 59 ? raw * 60 : 900;
};

/**
 * Pre-boost fill state for a challenge at `now`.
 *
 * Motivation: a boost multiplies what the entry has at the moment it lands, so
 * spending it on an entry whose exposure has decayed wastes a scarce, one-per-
 * challenge resource. When enabled, the configured lead before the boost is
 * auto-applied becomes a vote-to-100% window.
 *
 * The apply instant is not re-derived here — it comes from the same
 * boostApplyThreshold formula getBoostThresholdSec uses, so the fill can never
 * aim at a moment the boost runner disagrees with.
 *
 * Gating mirrors describeDeadlineActions' boost row, because a fill ahead of a
 * boost that never fires is pure waste:
 *   - the opt-in itself, and the autoBoost toggle;
 *   - a boost actually AVAILABLE (branch null = nothing to apply);
 *   - the `0 = off` sentinel on whichever window the branch measures against —
 *     boostApplyThreshold deliberately doesn't apply it (see its note), and the
 *     timer branch stays positive at boostTime=0.
 *
 * Deliberately NOT gated on the boost/turbo conflict (every candidate entry
 * already turboed): that check needs live entry state, and unlike a wasted boost
 * the exposure bought here still counts toward the challenge either way. This
 * keeps the window a function of timers and toggles, matching
 * orderDeadlineActions' stance.
 *
 * Known blind spot, shared with orderDeadlineActions/describeDeadlineActions: the
 * Emergency Fill override in shouldApplyBoost applies an available boost as soon
 * as the challenge is inside the emergency window, ignoring autoBoost and
 * boostTime. boostApplyThreshold does not model that, so a user who raises
 * `emergencyFill` above the effective boost window gets the boost spent BEFORE
 * this fill window opens. Not the default (emergencyFill 300s sits below both
 * boost windows), and the cost is a fill that arrives too late rather than a
 * wrong action.
 *
 * @param {any} challenge
 * @param {string} challengeId
 * @param {number} now - Current time (Unix timestamp, seconds)
 * @returns {{active: boolean, inWindow: boolean}}
 */
const getBoostPrefillState = (challenge, challengeId, now) => {
    const inactive = { active: false, inWindow: false };
    try {
        if (settings.getEffectiveSetting('voteBeforeBoost', challengeId) !== true) return inactive;
        if (settings.getEffectiveSetting('autoBoost', challengeId) !== true) return inactive;

        const closeTime = Number(challenge?.close_time);
        if (!Number.isFinite(closeTime)) return inactive;

        const boostTimeSec = getEffectiveBoostTime(challengeId);
        const keyUnlockedBoostTimeSec = getEffectiveKeyUnlockedBoostTime(challengeId);
        const { thresholdSec, branch } = boostApplyThreshold(challenge?.member?.boost, closeTime, {
            boostTimeSec,
            keyUnlockedBoostTimeSec,
        });
        if (branch === null) return inactive;

        // `0 = off` on the window this branch actually measures against.
        const windowSec = branch === 'timer' ? boostTimeSec : keyUnlockedBoostTimeSec;
        if (!Number.isFinite(windowSec) || windowSec <= 0) return inactive;
        // A non-positive apply instant means the boost is already due or the data is
        // malformed (expiry after close) — either way there is no lead left to fill in.
        if (!Number.isFinite(thresholdSec) || thresholdSec <= 0) return inactive;

        const timeUntilEnd = closeTime - now;
        return {
            active: true,
            // Strictly before the apply instant: at or past it the boost fires this
            // very cycle (deadline actions run ahead of the vote decision in the
            // orchestrator), so filling then would be too late to be the point.
            inWindow: timeUntilEnd > thresholdSec && timeUntilEnd <= thresholdSec + getBoostPrefillLeadSec(challengeId),
        };
    } catch (error) {
        // Fail-soft, matching getScheduledFillState/getVotingPauseState: degrade to
        // "no pre-boost window" and let the remaining rules evaluate. Letting this
        // throw would escape _runVotingRules into the orchestrator's per-challenge
        // catch, which abandons the WHOLE challenge for the cycle — losing even the
        // ordinary threshold vote over an optional extra.
        logger
            .withCategory('voting')
            .warning(
                `Pre-boost fill evaluation failed for challenge ${oneLineId(challengeId)} — treating it as off`,
                error,
            );
        return inactive;
    }
};

module.exports = {
    getBoostPrefillState,
};
