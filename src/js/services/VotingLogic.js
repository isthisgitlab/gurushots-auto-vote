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
const { getNextScheduleThresholdSec, evaluateEmergencyFill, getSlotsRemaining } = /** @type {any} */ (
    require('./autoFill')
);
// Pure wall-clock math for the scheduled-fill feature (no import cycle:
// wallClock.js imports nothing). Cast for the same boundary reason as the
// two imports above — wallClock.js isn't `// @ts-check`ed yet.
const { occurrencesOf } = /** @type {any} */ (require('../scheduling/wallClock'));
const { isBoostWindowOpen: boostWindowOpen, boostApplyThreshold } = require('../voting/boostWindow');
// 0 = last / 1-4 = slot addressing, shared with the swap automation.
const { resolveEntryIndex } = require('../voting/entrySlot');
const { DEFAULT_TIMEZONE } = require('../settings/uiDefaults');
// From settings/limits (not settings/schema) — keeps zod out of any bundle
// that reaches this module. No `any` cast needed: limits.js exports a plain
// number literal, so inference is already exact.
const { MAX_SCHEDULED_FILL_ENTRIES, MAX_VOTING_PAUSE_MINUTES } = require('../settings/limits');
// Cast at the boundary for the same reason as the imports above — logger.js
// isn't `// @ts-check`ed yet. Used only on the corrupt-config paths below,
// which must not stay silent: the orchestrator's per-challenge catch logs its
// own errors, so a swallowed one here would be strictly less visible.
const logger = /** @type {any} */ (require('../logger'));
// CR/LF-collapse API-sourced values before they reach a log message (CWE-117).
// Imported directly rather than off the logger, matching newEntryTracker.js —
// the logger is mocked across much of the test suite, and its own oneLine() on
// the finished message is a backstop, not the first line of defence.
const { oneLine: oneLineId } = require('../format/logSafe');

/**
 * Shared trigger-window evaluation for the two features built on the same pair
 * of trigger LISTS: scheduled fill (vote inside the window) and the voting
 * pause (refuse to vote inside it). Only the setting KEYS and the fallback
 * duration differ, so both read this — a second copy of the entry loops would
 * let the two drift on corruption handling, which is where all the subtlety is.
 *
 * Every time entry opens its own daily window and every before-end entry its
 * own one-shot window, all sharing one duration, all OR'd — `inWindow` is true
 * when `now` sits inside ANY entry's `[start, start + duration]` interval.
 *
 * `active` is true only when the master switch is on AND at least one USABLE
 * entry exists across both lists (a parseable 'HH:MM', or an offset > 0). This
 * is what keeps "enabled with no times" a harmless no-op: an
 * `active = enabled` shortcut would let scheduled fill's replace mode block
 * all threshold voting with no window ever opening, and would make a pause
 * with no times readable as "paused forever". A corrupt entry inside a list is
 * skipped (contributing nothing, not even `active`); a whole value that isn't
 * an array turns that form off.
 *
 * Callers wrap this in the try/catch — see getScheduledFillState.
 *
 * Unlike isWithinFinalWindow/isWithinLastMinuteThreshold, the time-of-day form
 * doesn't compare against close_time — callers only iterate the API's active
 * (still-open) challenge list, so a stale in-window verdict for a closed
 * challenge can't occur there. A future caller feeding a broader list should
 * pre-filter on `close_time > now` (as soonestScheduledStart does).
 *
 * @param {any} challenge
 * @param {string} challengeId
 * @param {number} now - Current time (Unix timestamp, seconds)
 * @param {{enabledKey: string, timesKey: string, beforeEndKey: string,
 *          durationKey: string, defaultDurationMin: number,
 *          onCorruptDuration: 'default'|'off', maxDurationMin: number|null}} keys
 *   `onCorruptDuration` and `maxDurationMin` are the per-feature corruption
 *   policy — see the duration block below for why the two features must not
 *   share one. Both are required rather than optional so a future third caller
 *   has to state its direction explicitly instead of inheriting one silently.
 * @returns {{active: boolean, inWindow: boolean}}
 */
const _triggerWindowState = (challenge, challengeId, now, keys) => {
    if (settings.getEffectiveSetting(keys.enabledKey, challengeId) !== true) {
        return { active: false, inWindow: false };
    }

    // Corrupt duration handling is per-feature, because the two features must
    // fail in OPPOSITE directions and a shared fallback would get one of them
    // backwards:
    //   - scheduled fill (`onCorruptDuration: 'default'`) falls back to the
    //     schema default. Failing to "never in window" would, under replace
    //     mode, silently block all threshold voting.
    //   - the voting pause (`onCorruptDuration: 'off'`) turns the feature OFF.
    //     Substituting a default here would be fail-CLOSED: a user with a
    //     30-minute pause whose value got corrupted would silently get the
    //     4-hour default instead — a longer outage than they ever configured.
    // Deliberately no schema-FLOOR clamp either way: a finite positive value
    // below the schema's min(5) is honored as typed (out of range, not corrupt).
    const rawDuration = settings.getEffectiveSetting(keys.durationKey, challengeId);
    const durationMin = Number(rawDuration);
    let effectiveDurationMin;
    if (Number.isFinite(durationMin) && durationMin > 0) {
        effectiveDurationMin = durationMin;
    } else if (keys.onCorruptDuration === 'off') {
        logger
            .withCategory('voting')
            .warning(
                `${keys.durationKey} for challenge ${oneLineId(challengeId)} is not a positive number (${oneLineId(JSON.stringify(rawDuration))}) — treating the feature as off for this challenge`,
                null,
            );
        return { active: false, inWindow: false };
    } else {
        effectiveDurationMin = keys.defaultDurationMin;
    }
    // Ceiling clamp, opt-in per feature. The pause sets one because an
    // oversized hand-edited value there means "never vote again" — an
    // unbounded window swallows every comparison below. Scheduled fill passes
    // none: an oversized fill window just means "always fill", which is
    // harmless, and clamping it would change long-standing behavior.
    if (keys.maxDurationMin && effectiveDurationMin > keys.maxDurationMin) {
        logger
            .withCategory('voting')
            .warning(
                `${keys.durationKey} for challenge ${oneLineId(challengeId)} is ${effectiveDurationMin}m, above the ${keys.maxDurationMin}m maximum — clamping`,
                null,
            );
        effectiveDurationMin = keys.maxDurationMin;
    }
    const durationSec = effectiveDurationMin * 60;
    const timezone = settings.getSetting('timezone') || DEFAULT_TIMEZONE;
    // Both triggers are LISTS — every entry opens its own window, all OR'd.
    // Non-array corruption = form off; a corrupt ENTRY inside the array is
    // skipped (contributes nothing, not even `active`). The slice bounds
    // per-cycle Intl work against a post-migration hand-edited oversized
    // array (the write path and the load-time bounds pass both cap at
    // MAX_SCHEDULED_FILL_ENTRIES already).
    const rawTimes = settings.getEffectiveSetting(keys.timesKey, challengeId);
    const times = (Array.isArray(rawTimes) ? rawTimes : []).slice(0, MAX_SCHEDULED_FILL_ENTRIES);
    const rawBefores = settings.getEffectiveSetting(keys.beforeEndKey, challengeId);
    const befores = (Array.isArray(rawBefores) ? rawBefores : []).slice(0, MAX_SCHEDULED_FILL_ENTRIES);

    let active = false;
    let inWindow = false;

    // Time-of-day entries: unparseable values yield null → entry skipped.
    for (const entry of times) {
        const occ = occurrencesOf(entry, timezone, now);
        if (!occ) continue;
        active = true;
        if (now - occ.prev <= durationSec) inWindow = true;
    }
    // Before-end entries: NaN and non-positives fail the > 0 gate → skipped.
    for (const entry of befores) {
        const beforeEndSec = Number(entry);
        if (!(beforeEndSec > 0)) continue;
        active = true;
        const start = Number(challenge.close_time) - beforeEndSec;
        if (now >= start && now - start <= durationSec) inWindow = true;
    }

    // `inWindow` can only have been set inside a loop that already set
    // `active`, so it never needs a separate guard here.
    return { active, inWindow };
};

/**
 * Scheduled-fill state for a challenge at `now`.
 *
 * Both triggers are LISTS (issue #26 follow-up): every scheduledFillTime
 * entry opens its own daily window and every scheduledFillBeforeEnd entry its
 * own one-shot window, all sharing scheduledFillWindowMinutes, all OR'd. See
 * _triggerWindowState for the entry semantics.
 *
 * The whole body is wrapped in try/catch returning the inactive state — the
 * same posture (and reason) as getExposureResolver in settings.js: a corrupt
 * hand-edited override must degrade this one challenge's scheduled fill to
 * "off" rather than take the whole evaluation down. The `replaces` read is
 * INSIDE the try for that same reason. The catch LOGS: the orchestrator's
 * per-challenge catch reports the errors it sees, so swallowing one silently
 * here would make this the least visible failure in the pass.
 *
 * @param {any} challenge
 * @param {string} challengeId
 * @param {number} now - Current time (Unix timestamp, seconds)
 * @returns {{active: boolean, inWindow: boolean, replaces: boolean}}
 */
const getScheduledFillState = (challenge, challengeId, now) => {
    const inactive = { active: false, inWindow: false, replaces: false };
    try {
        const state = _triggerWindowState(challenge, challengeId, now, {
            enabledKey: 'useScheduledFill',
            timesKey: 'scheduledFillTime',
            beforeEndKey: 'scheduledFillBeforeEnd',
            durationKey: 'scheduledFillWindowMinutes',
            defaultDurationMin: 60,
            onCorruptDuration: 'default',
            maxDurationMin: null,
        });
        if (!state.active) return inactive;
        return {
            ...state,
            replaces: settings.getEffectiveSetting('scheduledFillReplaces', challengeId) === true,
        };
    } catch (error) {
        logger
            .withCategory('voting')
            .warning(
                `Scheduled-fill evaluation failed for challenge ${oneLineId(challengeId)} — treating it as off`,
                error,
            );
        return inactive;
    }
};

/**
 * Voting-pause state for a challenge at `now` — the inverse of scheduled fill.
 *
 * Motivation: between the overnight match rounds almost nobody is voting, so
 * exposure filled at 03:00 buys far fewer votes than the same swipes spent
 * after the morning round opens. Each votingPauseTime entry opens a daily
 * pause and each votingPauseBeforeEnd entry a one-shot pause, both lasting
 * votingPauseDurationMinutes, all OR'd.
 *
 * Everything here fails OPEN — every degraded path returns "not paused", i.e.
 * keep voting. That direction is the whole safety argument: a broken pause
 * costs some votes at a bad hour, while a pause that failed CLOSED would
 * silently stop voting altogether, which looks exactly like the app being
 * broken. Hence the differences from getScheduledFillState:
 *   - a corrupt duration turns the pause OFF rather than substituting a
 *     default (`onCorruptDuration: 'off'`),
 *   - an over-range duration is CLAMPED, so no hand-edited value can open a
 *     window wide enough to swallow every future cycle (`maxDurationMin`),
 *   - a challenge with no usable close_time is never paused, because the
 *     last-minute rule that would otherwise rescue it also needs that value.
 * Every one of those paths logs; a silent pause is indistinguishable from a bug.
 *
 * @param {any} challenge
 * @param {string} challengeId
 * @param {number} now - Current time (Unix timestamp, seconds)
 * @returns {{active: boolean, inWindow: boolean}}
 */
const getVotingPauseState = (challenge, challengeId, now) => {
    const notPaused = { active: false, inWindow: false };
    try {
        // A non-finite close_time defeats the deadline rules (last-minute and
        // final-window both compare against it), so a pause must not apply
        // either — the time-of-day form doesn't read close_time at all and
        // would otherwise pause such a challenge with nothing left to rescue it.
        if (!Number.isFinite(Number(challenge?.close_time))) return notPaused;
        return _triggerWindowState(challenge, challengeId, now, {
            enabledKey: 'useVotingPause',
            timesKey: 'votingPauseTime',
            beforeEndKey: 'votingPauseBeforeEnd',
            durationKey: 'votingPauseDurationMinutes',
            defaultDurationMin: 240,
            onCorruptDuration: 'off',
            maxDurationMin: MAX_VOTING_PAUSE_MINUTES,
        });
    } catch (error) {
        logger
            .withCategory('voting')
            .warning(
                `Voting-pause evaluation failed for challenge ${oneLineId(challengeId)} — treating it as not paused`,
                error,
            );
        return notPaused;
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
 *   actually CHANGED the outcome: exposure was at/above the trigger but still
 *   below the target, so the vote happens anyway. False on every blocked path,
 *   once the target is met, and when the challenge was already eligible on its own.
 * @property {boolean} [preservesNewEntryTrigger] - Set on a blocked path that
 *   DEFERS rather than cancels: the orchestrator must keep any new-entry trigger
 *   armed instead of disarming it. Only the voting pause sets it.
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
 * @typedef {object} TurboDecision
 * @property {boolean} apply
 * @property {string|null} imageId
 * @property {boolean} fillNew
 * @property {string} reason
 */

/**
 * Check if a challenge is within its final window (the configurable stretch
 * before close during which the final-window exposure rule applies).
 * @param {number} closeTime - Challenge close time (Unix timestamp)
 * @param {number} now - Current time (Unix timestamp)
 * @param {number} [windowSec=3600] - Final-window duration in seconds
 *   (finalWindowDuration). Defaults to the legacy fixed hour.
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
 * comparison NaN-false, so the last-minute rule NEVER fires. That used to
 * merely demote the challenge to the normal threshold rule; now that the
 * voting pause sits above final-window it is the difference between "votes
 * late" and "never votes at all", because last-minute is the one rule a pause
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
 * Used by shouldApplyBoost (its emergency path) and describeDeadlineActions
 * (the boost/turbo entry-conflict flag).
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
 * Resolves how a boost should source its target entry for a challenge:
 * - `'always'`  — `boostFillNew` is on: always submit a fresh photo and boost it.
 * - `'conflict'` — `boostFillNewOnConflict` is on AND the only existing entry is
 *   already turboed (so Boost cannot be placed on any existing entry): submit a
 *   fresh photo purely to break that boost/turbo conflict.
 * - `'no'` — boost an existing entry the normal way.
 *
 * `boostFillNew` (always) takes precedence over `boostFillNewOnConflict`, and the
 * conflict mode only engages when the conflict actually exists — mirroring the
 * `!picked` branch in {@link shouldApplyTurbo}, where picker-null with at least
 * one entry means the single entry carries the other feature's flag.
 *
 * @param {any} challenge
 * @param {string} challengeId
 * @returns {'always'|'conflict'|'no'}
 */
const resolveBoostFillNewMode = (challenge, challengeId) => {
    if (settings.getEffectiveSetting('boostFillNew', challengeId) === true) return 'always';
    if (settings.getEffectiveSetting('boostFillNewOnConflict', challengeId) === true) {
        const entries = challenge?.member?.ranking?.entries;
        if (Array.isArray(entries) && entries.length >= 1 && pickBoostEntry(challenge, challengeId) === null) {
            return 'conflict';
        }
    }
    return 'no';
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
 *   of the useTurbo toggle or the turboTime window.
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
    // turboTime threshold below is also skipped in this case (the challenge is
    // about to close).
    //
    // Turbo does not wait for an open boost window: the two are independent, and
    // the only rule between them — never on the same entry — is enforced by the
    // entry pick below (pickEntryAvoidingConflict).
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
    }

    const fillNew = settings.getEffectiveSetting('turboFillNew', challengeId) === true;
    // Narrower opt-in: fill a fresh photo ONLY to break a boost/turbo conflict
    // (the single existing entry already has Boost, so Turbo cannot go there).
    // `turboFillNew` (always) takes precedence and is handled first below.
    const fillNewOnConflict = settings.getEffectiveSetting('turboFillNewOnConflict', challengeId) === true;

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
        if (fillNewOnConflict) {
            // Submit and Turbo a fresh entry instead. imageId stays null: there
            // is no safe fallback target (the only existing entry is boosted), so
            // if the fresh submit can't happen the turbo runner skips this cycle
            // rather than turboing the boosted entry.
            return { apply: true, imageId: null, fillNew: true, reason: 'eligible (fill-new on conflict)' };
        }
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
 * boosts apply inside their own `keyUnlockedBoostTime` closing window (default
 * 15m); timer-based boosts apply
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
const getBoostThresholdSec = (challenge, challengeId) =>
    boostApplyThreshold(challenge?.member?.boost, challenge?.close_time, {
        boostTimeSec: getEffectiveBoostTime(challengeId),
        keyUnlockedBoostTimeSec: getEffectiveKeyUnlockedBoostTime(challengeId),
    }).thresholdSec;

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
 *   - emergencyFill: its threshold is a fixed setting that never reflects live
 *     state, so defer to the runner's own evaluateEmergencyFill (no id, no free
 *     slot, or normal auto-fill already owning the fill). Shared code, not a
 *     copy, so the row cannot drift from what actually runs.
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

    // Boost/turbo conflict: a boost is available to place, there IS an entry to
    // place it on, but every candidate entry is already turboed. The
    // entries.length >= 1 guard is required — pickBoostEntry also returns null
    // when there are simply no entries yet (a freshly joined challenge before
    // auto-fill), which is NOT a conflict. Computed before the row gating below
    // so the boost row can be suppressed when it can't actually be placed —
    // otherwise the timeline would show a "Boost" row that directly contradicts
    // the conflict warning rendered right beside it.
    //
    // A fill-new mode (always or the narrower on-conflict) resolves the conflict
    // by boosting a freshly submitted photo instead — but only when there is a
    // free slot to submit into, so the warning still shows for a truly full,
    // conflicted challenge. The free-slot count comes from autoFill's own
    // getSlotsRemaining (this module already imports that module — there is no
    // cycle) so the fill paths and this view can never disagree on "full".
    const entries = challenge?.member?.ranking?.entries;
    const hasFreeSlot = getSlotsRemaining(challenge) > 0;
    const fillNewWillResolve = hasFreeSlot && resolveBoostFillNewMode(challenge, challengeId) !== 'no';
    const boostBlocked =
        isBoostWindowOpen(challenge, now) &&
        Array.isArray(entries) &&
        entries.length >= 1 &&
        pickBoostEntry(challenge, challengeId) === null &&
        !fillNewWillResolve;

    /**
     * @param {string} action
     * @param {number} thresholdSec
     * @returns {boolean}
     */
    const isVisible = (action, thresholdSec) => {
        if (!Number.isFinite(thresholdSec) || thresholdSec <= 0) return false;
        switch (action) {
            case 'turbo':
                return turboState === 'WON' && settings.getEffectiveSetting('useTurbo', challengeId) === true;
            case 'boost':
                if (settings.getEffectiveSetting('autoBoost', challengeId) !== true) return false;
                // A boost that can't be placed (only entry already turboed) must
                // not appear as an upcoming action — the conflict warning owns it.
                if (boostBlocked) return false;
                // Timer branch stays positive at boostTime=0 (off); key-unlocked
                // branch already resolves to 0 when off and is dropped above.
                if (boostTimerBranch && !(getEffectiveBoostTime(challengeId) > 0)) return false;
                return true;
            case 'autoFill':
                return settings.getEffectiveSetting('autoFill', challengeId) === true;
            case 'emergencyFill':
                // thresholdSec > 0 already means enabled (0 = off); the runner
                // owns the state-only stand-downs, so ask it rather than keeping
                // a second copy here that could drift from what actually runs.
                // The RAW id goes in, not the '' -normalised challengeId above:
                // the shared check treats undefined/null as "no id" exactly as
                // the runner does, and must not learn this view's normalisation.
                return !evaluateEmergencyFill(challenge, challenge?.id, settings).standDown;
            // Exhaustive-switch safety net: orderDeadlineActions emits only the four
            // cases above today, but an action added there without a matching case
            // here must stay hidden rather than be treated as visible.
            /* istanbul ignore next */
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

    return { actions, boostBlocked };
};

// Mirrors MAX_JOIN_PERCENT_ELAPSED in settings/schema.js (which this
// renderer-bundle-safe module cannot import) — change both together.
const MAX_REACHABLE_PERCENT_ELAPSED = 99;

/**
 * Collapse the two join-timing settings into the ONE window that governs a
 * candidate.
 *
 * A candidate is never gated by both at once. `autoJoinAfterPercentElapsed`
 * wins whenever it is set, because it is the more specific instruction: it
 * names a point in the challenge's own life, while the hours window names a
 * distance from the end that means different things for a 2h flash and a 515h
 * exhibition. With percent off, the hours window applies unchanged, so every
 * pre-existing configuration keeps its exact behavior.
 *
 * @param {number} joinWithinSec seconds before close_time to start joining (0 = off)
 * @param {number} percentElapsed percent of the challenge's lifetime that must have run (0 = off)
 * @returns {{mode: 'percent'|'hours'|'off', value: number}}
 */
const resolveJoinWindow = (joinWithinSec, percentElapsed) => {
    const percent = Number(percentElapsed);
    if (Number.isFinite(percent) && percent > 0) {
        // Clamp to the latest REACHABLE fraction. 100% is only true once
        // close_time has passed, and joinWindowRefusal rejects an already-closed
        // candidate before it reads the fraction at all — so a corrupted 100 (or
        // 1000) must degrade to "as late as possible", never to "never join".
        return { mode: 'percent', value: Math.min(percent, MAX_REACHABLE_PERCENT_ELAPSED) };
    }
    const withinSec = Number(joinWithinSec);
    if (Number.isFinite(withinSec) && withinSec > 0) {
        return { mode: 'hours', value: withinSec };
    }
    return { mode: 'off', value: 0 };
};

/**
 * The join-window half of the auto-join decision, split out so the main
 * decision reads as one list of vetoes.
 *
 * Returns the refusal reason, or null when the window does not veto — either
 * because no window is set (both sentinels 0 = off, the historical
 * join-on-sight behavior) or because the candidate is inside it.
 *
 * FAIL-CLOSED: a candidate that cannot prove it is inside the window (no
 * readable `close_time`, no readable clock, or already past its close) is
 * refused. "Join only near the end" must never degrade into "join now" on a
 * payload this could not read. Percent mode reads one field more —
 * `start_time`, to know how long the challenge runs — and is fail-closed on it
 * for the same reason: without a length, a percentage means nothing, and
 * guessing one would spend the entry at exactly the moment the setting exists
 * to avoid.
 *
 * @param {{close_time?: number, start_time?: number}} challenge
 * @param {number} joinWithinSec seconds before close_time to start joining (0 = off)
 * @param {number} nowSec current time in epoch SECONDS (close_time's unit)
 * @param {number} percentElapsed percent of the challenge's lifetime that must have run (0 = off)
 * @returns {string|null}
 */
const joinWindowRefusal = (challenge, joinWithinSec, nowSec, percentElapsed) => {
    const window = resolveJoinWindow(joinWithinSec, percentElapsed);
    if (window.mode === 'off') return null;

    const closeTime = Number(challenge?.close_time);
    const now = Number(nowSec);
    if (!Number.isFinite(closeTime) || closeTime <= 0 || !Number.isFinite(now) || now <= 0) {
        return 'close-time-unknown';
    }
    const secondsLeft = closeTime - now;
    // Already closed (a stale entry in the open list) — joining would burn a
    // submission on a dead challenge.
    if (secondsLeft <= 0) return 'already-closed';

    if (window.mode === 'percent') {
        const startTime = Number(challenge?.start_time);
        if (!Number.isFinite(startTime) || startTime <= 0) return 'start-time-unknown';
        const durationSec = closeTime - startTime;
        // A non-positive duration is a nonsensical payload (start at or after
        // close); there is no fraction to compute, so refuse rather than divide.
        if (durationSec <= 0) return 'start-time-unknown';
        // Clamp below at 0 so a challenge whose start_time is in the future
        // (clock skew) reads as 0% elapsed rather than negative.
        const elapsedPct = (Math.max(0, now - startTime) / durationSec) * 100;
        return elapsedPct < window.value ? 'too-early' : null;
    }

    return secondsLeft > window.value ? 'too-early' : null;
};

/**
 * Pure decision for whether to auto-join ONE un-joined challenge.
 *
 * No I/O: the caller resolves settings (by title-profile) and the live bankroll
 * first, then passes the results in. `join_coins` is read from the candidate
 * itself. COINS is the only join currency handled; a candidate whose cost is
 * non-positive is treated as free.
 *
 * Scope (once auto-join is enabled): the DEFAULT is join everything. An
 * `includeTypes` list, when non-empty, narrows to just those types.
 * `excludeTypes` subtracts. A title-profile match is a deliberate per-title
 * opt-in that bypasses both the exclude veto and any include narrowing, so a
 * profiled title still joins even if its type is excluded or not in the include
 * list. So "join all EXCEPT flash and exhibition" = exclude `flash,exhibition`
 * with no include list.
 *
 * Timing comes from two `0 = off` settings that resolve to ONE window
 * (`resolveJoinWindow`): `joinWithinSec` joins a candidate once it is within
 * that many seconds of its own `close_time`, while `joinAfterPercentElapsed`
 * joins it once that percentage of its own lifetime has run. Percent wins when
 * both are set. Either way entries land late in a challenge's life instead of
 * the moment it appears. Unlike the
 * type filters, a title match does NOT bypass this — the window is itself a
 * deliberate per-title instruction, so bypassing it would invert the user's
 * intent. It is a pure gate on WHEN: it never looks at cost, and the coin caps
 * below still decide whether a paid join happens at all.
 *
 * Timing is FAIL-CLOSED. A candidate that cannot prove it is inside the window
 * (`close_time` missing, unparseable, or already past) is not joined while a
 * window is set. "Join only near the end" must never degrade into "join now" on
 * a payload the caller could not read — that is precisely the spend the setting
 * exists to prevent. With `joinWithinSec` 0 the field is not read at all, so the
 * historical behavior is untouched.
 *
 * Fail-safe on money: a null `bankroll` (balance could not be read) blocks every
 * paid join but still allows free joins. Both coin caps use the `0 = off`
 * sentinel — paid joins require `maxCoins > 0` AND `remainingBudget >= cost`.
 *
 * @param {object} params
 * @param {{id?: string|number, type?: string, join_coins?: number, close_time?: number, tags?: string[]}} params.challenge
 * @param {{coins?: number}|null} params.bankroll live balance, or null if unread
 * @param {number} params.remainingBudget coins still spendable this cycle (0 = paid off)
 * @param {string[]} params.includeTypes normalized lowercase types from `autoJoinTypes`; EMPTY = all types
 * @param {string[]} params.excludeTypes normalized lowercase types from `autoJoinExcludeTypes`; a match vetoes the join (unless a title-profile matches)
 * @param {number} params.maxCoins per-challenge coin cap (0 = free only)
 * @param {boolean} params.hasProfileMatch a title rule/profile matched this title — a deliberate opt-in that bypasses the exclude veto and include narrowing
 * @param {string[]} [params.includeTags] normalized lowercase CHALLENGE tags from `autoJoinChallengeTags`; EMPTY = any
 * @param {string[]} [params.excludeTags] normalized lowercase CHALLENGE tags from `autoJoinExcludeChallengeTags`; any match vetoes the join
 * @param {number} [params.joinWithinSec] join only within this many seconds of `close_time` (0/absent = off)
 * @param {number} [params.nowSec] current time in epoch SECONDS (matches `close_time`'s unit); required when `joinWithinSec` > 0
 * @param {number} [params.joinAfterPercentElapsed] join only once this percent of the candidate's lifetime (`close_time` - `start_time`) has elapsed (0/absent = off); wins over `joinWithinSec` when both are set
 * @returns {{join: boolean, needsCoins: number, reason: string}}
 */
const shouldJoinChallenge = ({
    challenge,
    bankroll,
    remainingBudget,
    includeTypes,
    excludeTypes,
    maxCoins,
    hasProfileMatch,
    includeTags = [],
    excludeTags = [],
    joinWithinSec = 0,
    nowSec = 0,
    joinAfterPercentElapsed = 0,
}) => {
    const rawCost = Number(challenge?.join_coins);
    const needsCoins = Number.isFinite(rawCost) && rawCost > 0 ? rawCost : 0;

    const type = typeof challenge?.type === 'string' ? challenge.type.trim().toLowerCase() : '';
    const tags = Array.isArray(challenge?.tags)
        ? challenge.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.trim().toLowerCase())
        : [];
    // A saved title profile is a deliberate per-title opt-in and wins over the
    // general type/tag filters (bypasses exclude + include narrowing).
    // Otherwise: default is join everything; a non-empty include list narrows;
    // the exclude list always subtracts. Types and challenge tags are two
    // independent axes and BOTH must pass.
    if (hasProfileMatch !== true) {
        if (Array.isArray(excludeTypes) && type !== '' && excludeTypes.includes(type)) {
            return { join: false, needsCoins, reason: 'excluded-type' };
        }
        const hasIncludeFilter = Array.isArray(includeTypes) && includeTypes.length > 0;
        if (hasIncludeFilter && !(type !== '' && includeTypes.includes(type))) {
            return { join: false, needsCoins, reason: 'out-of-scope' };
        }
        if (Array.isArray(excludeTags) && excludeTags.some((tag) => tags.includes(tag))) {
            return { join: false, needsCoins, reason: 'excluded-tag' };
        }
        const hasTagFilter = Array.isArray(includeTags) && includeTags.length > 0;
        // A challenge with NO tags can never satisfy a require-list, the same
        // way a typeless one cannot satisfy an include-list.
        if (hasTagFilter && !includeTags.some((tag) => tags.includes(tag))) {
            return { join: false, needsCoins, reason: 'tag-out-of-scope' };
        }
    }

    // Timing window, after the scope filters (so an out-of-scope candidate still
    // reports WHY it is out of scope) and before the cost branch (timing gates
    // free and paid candidates identically). Deliberately NOT bypassed by
    // hasProfileMatch — see the header.
    const timingRefusal = joinWindowRefusal(challenge, joinWithinSec, nowSec, joinAfterPercentElapsed);
    if (timingRefusal) {
        return { join: false, needsCoins, reason: timingRefusal };
    }

    if (needsCoins <= 0) {
        return { join: true, needsCoins: 0, reason: 'free' };
    }

    // Paid from here down.
    if (!Number.isFinite(maxCoins) || maxCoins <= 0) {
        return { join: false, needsCoins, reason: 'paid-disabled' };
    }
    if (needsCoins > maxCoins) {
        return { join: false, needsCoins, reason: 'over-per-challenge-cap' };
    }
    // Fail-safe: unknown balance never spends.
    const coins = Number(bankroll?.coins);
    if (bankroll == null || !Number.isFinite(coins)) {
        return { join: false, needsCoins, reason: 'balance-unknown' };
    }
    if (coins < needsCoins) {
        return { join: false, needsCoins, reason: 'insufficient-coins' };
    }
    if (!Number.isFinite(remainingBudget) || needsCoins > remainingBudget) {
        return { join: false, needsCoins, reason: 'over-cycle-budget' };
    }
    return { join: true, needsCoins, reason: 'paid' };
};

module.exports = {
    shouldJoinChallenge,
    resolveJoinWindow,
    isWithinFinalWindow,
    isWithinLastMinuteThreshold,
    getEffectiveExposureThreshold,
    getEffectiveFinalWindowExposureThreshold,
    getEffectiveExposureTarget,
    getEffectiveFinalWindowExposureTarget,
    getScheduledFillState,
    getVotingPauseState,
    getBoostPrefillState,
    evaluateVotingDecision,
    evaluateManualVotingDecision,
    evaluateManualVotingToHundred,
    getEffectiveBoostTime,
    getEffectiveKeyUnlockedBoostTime,
    pickBoostEntry,
    resolveBoostFillNewMode,
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
