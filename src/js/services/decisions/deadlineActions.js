// @ts-check
/**
 * Per-challenge deadline actions (auto-fill, emergency fill, boost, turbo):
 * their seconds-before-close thresholds, the order they run in, and the
 * renderer-facing description of which will actually fire. Part of the
 * services/VotingLogic facade.
 */

// Cast to any at the boundary: the settings facade isn't `// @ts-check`ed yet,
// and its `challengeId = null` defaults make TS infer param types too narrow
// (null) to accept the string IDs passed here. Drop the cast once settings.js
// is typed.
const settings = /** @type {any} */ (require('../../settings'));
// Single source of truth for the auto-fill schedule threshold math (no import
// cycle: autoFill.js does not require VotingLogic). Cast for the same
// boundary reason as settings above — autoFill.js isn't `// @ts-check`ed yet.
const { getNextScheduleThresholdSec, evaluateEmergencyFill, getSlotsRemaining } = /** @type {any} */ (
    require('../autoFill')
);
const { boostApplyThreshold } = require('../../voting/boostWindow');
const { getEffectiveBoostTime, getEffectiveKeyUnlockedBoostTime, getEffectiveTurboTime } = require('./thresholds');
const { isBoostWindowOpen } = require('./boostTurbo');
const { pickBoostEntry, resolveBoostFillNewMode } = require('./entryPick');

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

module.exports = {
    getAutoFillThresholdSec,
    getEmergencyFillThresholdSec,
    getBoostThresholdSec,
    orderDeadlineActions,
    describeDeadlineActions,
};
