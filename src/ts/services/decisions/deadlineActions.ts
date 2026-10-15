import type { Challenge } from '../../types/gurushots';
/**
 * Per-challenge deadline actions (auto-fill, emergency fill, boost, turbo):
 * their seconds-before-close thresholds, the order they run in, and the
 * renderer-facing description of which will actually fire. Part of the
 * services/VotingLogic facade.
 */

import * as settings from '../../settings';
// Single source of truth for the auto-fill schedule threshold math (no import
// cycle: autoFill.ts does not require VotingLogic).
import { getNextScheduleThresholdSec, evaluateEmergencyFill, getSlotsRemaining } from '../autoFill';
import { boostApplyThreshold } from '../../voting/boostWindow';
import { getEffectiveBoostTime, getEffectiveKeyUnlockedBoostTime, getEffectiveTurboTime } from './thresholds';
import { isBoostWindowOpen } from './boostTurbo';
import {
    livePinnedId,
    pickBoostEntry,
    pickTurboEntry,
    pinReleaseAt,
    resolveBoostFillNewMode,
    resolveTurboFillNewMode,
} from './entryPick';
import { isManualPhotosOnly } from '../manualPhotosOnly';

const tieOrder: Record<string, number> = { autoSubmit: 0, emergencySubmit: 1, boost: 2, turbo: 3 };

/** Run order of two deadline actions: the larger threshold first, ties by `tieOrder`. */
const compareDeadlineActions = (
    a: { action: string; thresholdSec: number },
    b: { action: string; thresholdSec: number },
): number =>
    b.thresholdSec !== a.thresholdSec ? b.thresholdSec - a.thresholdSec : tieOrder[a.action] - tieOrder[b.action];

/**
 * Effective seconds-before-close at which the next auto-fill becomes due:
 * the largest autoSubmitSchedule threshold whose target count hasn't been met
 * yet, straight from autoFill.getNextScheduleThresholdSec (single source of
 * truth — it does the end-alignment shift for challenges allowing fewer
 * images than the schedule covers, plus the clamping and defensive parsing).
 * With every row satisfied, shifted/clamped away, or no schedule, the window
 * never opens (0).
 * Note: the entry count is read live, so this is a snapshot at call time
 * (orderDeadlineActions is called once per challenge before the runners
 * execute).
 */
const getAutoFillThresholdSec = (challenge: Challenge, challengeId: string): number => {
    const entries = challenge?.member?.ranking?.entries;
    const entryCount = Array.isArray(entries) ? entries.length : 0;
    const schedule = settings.getEffectiveSetting('autoSubmitSchedule', challengeId);
    return getNextScheduleThresholdSec(schedule, entryCount, challenge?.max_photo_submits);
};

/**
 * Effective seconds-before-close at which emergency fill activates (0 = off).
 */
const getEmergencyFillThresholdSec = (challengeId: string): number => {
    const seconds = settings.getEffectiveSetting('emergencySubmit', challengeId);
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
 */
const getBoostThresholdSec = (challenge: Challenge, challengeId: string): number =>
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
 * defaults (turboTime 7200, autoSubmit's top row 1800, emergencySubmit 300) the real
 * order is turbo → autoSubmit → emergencySubmit → boost — the numbers, not the code
 * order, decide.
 *
 * Note this sorts turbo on its configured window even when no turbo is held or
 * Auto-Apply Turbo is off — the runner then no-ops. That keeps the ordering a pure
 * function of the settings rather than of live challenge state.
 *
 * Tie-break (stable): autoSubmit → emergencySubmit → boost → turbo, so fills and
 * boost precede turbo and a freshly filled (and locally reflected) entry is
 * available when turbo runs on a tie.
 */
const orderDeadlineActions = (
    challenge: Challenge,
): Array<{ action: 'autoSubmit' | 'turbo' | 'emergencySubmit' | 'boost'; thresholdSec: number }> => {
    const challengeId = challenge?.id?.toString?.() || '';
    const actions: Array<{ action: 'autoSubmit' | 'turbo' | 'emergencySubmit' | 'boost'; thresholdSec: number }> = [
        { action: 'autoSubmit', thresholdSec: getAutoFillThresholdSec(challenge, challengeId) },
        { action: 'turbo', thresholdSec: getEffectiveTurboTime(challengeId) },
        { action: 'emergencySubmit', thresholdSec: getEmergencyFillThresholdSec(challengeId) },
        { action: 'boost', thresholdSec: getBoostThresholdSec(challenge, challengeId) },
    ];
    return actions.sort(compareDeadlineActions);
};

/**
 * The boost/turbo conflict flags, what blocks each, and when a blocking pin gives way.
 */
type Conflicts = {
    boostBlocked: boolean;
    turboBlocked: boolean;
    /** `flag`: every entry carries the other feature; `pin`: the photo pinned for it is in the way. */
    boostBlockedBy: 'flag' | 'pin' | null;
    turboBlockedBy: 'flag' | 'pin' | null;
    /** Unix seconds the blocking pin gives way; null when not blocked or the block never gives way. */
    boostReleaseAt: number | null;
    turboReleaseAt: number | null;
};

/**
 * Whether a Boost is blocked at `now`: it is available to place, there is an entry to place it on,
 * every candidate carries Turbo or is the photo pinned for Turbo, and no fill-new mode with a free
 * slot resolves it. The deadline view and the sleep boost share this one rule.
 *
 * @param now - Unix timestamp in seconds
 */
const isBoostBlocked = (challenge: Challenge, challengeId: string, now: number): boolean => {
    const entries = challenge?.member?.ranking?.entries;
    const hasEntries = Array.isArray(entries) && entries.length >= 1;
    const hasFreeSlot = getSlotsRemaining(challenge) > 0;
    return (
        isBoostWindowOpen(challenge, now) &&
        hasEntries &&
        pickBoostEntry(challenge, challengeId, now) === null &&
        !(hasFreeSlot && resolveBoostFillNewMode(challenge, challengeId) !== 'no')
    );
};

/**
 * The boost/turbo conflict flags and the instant a blocking pin gives way.
 *
 * Boost/turbo conflict: a boost is available to place, there IS an entry to
 * place it on, but every candidate entry already carries turbo or is the photo
 * pinned for Turbo. The entries.length >= 1 guard is required — pickBoostEntry
 * also returns null when there are simply no entries yet (a freshly joined
 * challenge before auto-fill), which is NOT a conflict. The caller computes it
 * before the row gating so the boost row can be suppressed when it can't actually
 * be placed — otherwise the timeline would show a "Boost" row that directly
 * contradicts the conflict warning rendered right beside it. turboBlocked is
 * the mirror: a won Turbo with every entry boosted or pinned for Boost.
 *
 * A fill-new mode (always or the narrower on-conflict) resolves the conflict
 * by using a freshly submitted photo instead — but only when there is a
 * free slot to submit into, so the warning still shows for a truly full,
 * conflicted challenge. The free-slot count comes from autoFill's own
 * getSlotsRemaining (this module already imports that module — there is no
 * cycle) so the fill paths and this view can never disagree on "full".
 *
 * A pin blocks only until the blocked spend nears its deadline, and nothing else
 * the renderer fingerprints moves then — so the view carries the instant for each
 * block (`boostReleaseAt` / `turboReleaseAt`, null when the block never gives way).
 * A block with no pin in it is a flag: the warning differs, because unpinning cannot help.
 *
 * @param now - Unix timestamp in seconds
 */
const describeConflicts = (challenge: Challenge, challengeId: string, now: number): Conflicts => {
    const entries = challenge?.member?.ranking?.entries;
    const hasEntries = Array.isArray(entries) && entries.length >= 1;
    const hasFreeSlot = getSlotsRemaining(challenge) > 0;
    const boostBlocked = isBoostBlocked(challenge, challengeId, now);
    const turboBlocked =
        challenge?.member?.turbo?.state === 'WON' &&
        hasEntries &&
        pickTurboEntry(challenge, challengeId, now) === null &&
        !(hasFreeSlot && resolveTurboFillNewMode(challenge, challengeId) !== 'no');
    // A Boost is blocked by the photo pinned for Turbo, and a Turbo by the one pinned for Boost.
    const causeOf = (blocked: boolean, blocker: 'boost' | 'turbo') =>
        blocked
            ? livePinnedId(challenge, challengeId, blocker) !== null
                ? ('pin' as const)
                : ('flag' as const)
            : null;
    return {
        boostBlocked,
        turboBlocked,
        boostBlockedBy: causeOf(boostBlocked, 'turbo'),
        turboBlockedBy: causeOf(turboBlocked, 'boost'),
        boostReleaseAt: boostBlocked ? pinReleaseAt(challenge, challengeId, 'turbo', now) : null,
        turboReleaseAt: turboBlocked ? pinReleaseAt(challenge, challengeId, 'boost', now) : null,
    };
};

/**
 * Read-only, renderer-facing description of a challenge's upcoming deadline
 * actions: the ordered actions that will ACTUALLY fire (gated on the same
 * conditions the runner uses, not merely on a positive threshold) plus each
 * one's absolute due instant, the boost/turbo conflict flags (and their cause), and when a blocking pin gives way.
 *
 * Gating matters because several threshold getters stay positive even when the
 * feature is off or the resource isn't held:
 *   - turbo: getEffectiveTurboTime defaults to 7200 even with no turbo — show
 *     only when a turbo is WON and Auto-Apply Turbo is on.
 *   - boost: getBoostThresholdSec's timer branch stays positive when
 *     boostTime=0 ("off") — re-check that, and honour the autoBoost toggle.
 *   - autoSubmit: gate on the autoSubmit toggle (a schedule can imply a threshold
 *     while auto-fill is disabled).
 *   - emergencySubmit: its threshold is a fixed setting that never reflects live
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
 * @param now - Unix timestamp in seconds
 */
const describeDeadlineActions = (
    challenge: Challenge,
    now: number,
): { actions: Array<{ action: string; thresholdSec: number; dueAt: number | null }> } & Conflicts => {
    const challengeId = challenge?.id?.toString?.() || '';
    const closeTime = Number(challenge?.close_time);
    const boost = challenge?.member?.boost || {};
    const boostHasTimeout = typeof boost.timeout === 'number' && boost.timeout > 0;
    const boostTimerBranch = boost.state === 'AVAILABLE' && boostHasTimeout;
    const turboState = challenge?.member?.turbo?.state;

    const conflicts = describeConflicts(challenge, challengeId, now);
    const { boostBlocked, turboBlocked, boostReleaseAt, turboReleaseAt } = conflicts;
    // A blocked spend whose pin will give way is still coming, just later: its row stays.
    const boostRowHidden = boostBlocked && boostReleaseAt === null;
    const turboRowHidden = turboBlocked && turboReleaseAt === null;

    const isVisible = (action: string, thresholdSec: number): boolean => {
        if (!Number.isFinite(thresholdSec) || thresholdSec <= 0) return false;
        switch (action) {
            case 'turbo':
                // A turbo that can't be placed must not appear as an upcoming action either.
                return (
                    turboState === 'WON' &&
                    settings.getEffectiveSetting('useTurbo', challengeId) === true &&
                    !turboRowHidden
                );
            case 'boost':
                if (settings.getEffectiveSetting('autoBoost', challengeId) !== true) return false;
                // A boost that can't be placed (every entry turboed or pinned for
                // Turbo, the pin never giving way) must not appear as an upcoming
                // action — the conflict warning owns it.
                if (boostRowHidden) return false;
                // Timer branch stays positive at boostTime=0 (off); key-unlocked
                // branch already resolves to 0 when off and is dropped above.
                if (boostTimerBranch && !(getEffectiveBoostTime(challengeId) > 0)) return false;
                return true;
            case 'autoSubmit':
                return (
                    settings.getEffectiveSetting('autoSubmit', challengeId) === true &&
                    !isManualPhotosOnly(settings, challengeId)
                );
            case 'emergencySubmit':
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
        .map(({ action, thresholdSec }) => {
            const dueAt = Number.isFinite(closeTime) ? closeTime - thresholdSec : null;
            const releaseAt = action === 'boost' ? boostReleaseAt : action === 'turbo' ? turboReleaseAt : null;
            // A held-back spend is due once its pin has given way, if that is later than its own time.
            return releaseAt === null || dueAt === null
                ? { action, thresholdSec, dueAt }
                : {
                      action,
                      thresholdSec: Math.min(thresholdSec, closeTime - releaseAt),
                      dueAt: Math.max(dueAt, releaseAt),
                  };
        })
        // A moved row can now sit out of order; order it by its adjusted threshold.
        .sort(compareDeadlineActions);

    return { actions, ...conflicts };
};

export { getAutoFillThresholdSec, getBoostThresholdSec, isBoostBlocked, orderDeadlineActions, describeDeadlineActions };
