import type { Challenge } from '../../types/gurushots';
import type { EntryAgeLedger } from '../../types/stores';
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
import { boostApplyThreshold, boostDeadline } from '../../voting/boostWindow';
import { isKnownTurboMode } from '../../voting/turboMode';
import { getEffectiveBoostTime, getEffectiveKeyUnlockedBoostTime, getEffectiveTurboTime } from './thresholds';
import { isBoostWindowOpen } from './boostTurbo';
import {
    canSubmitBoostPin,
    livePinnedId,
    pickBoostEntry,
    pickTurboEntry,
    pinReleaseAt,
    resolveBoostFillNewMode,
    resolvePin,
    resolveTurboFillNewMode,
} from './entryPick';
import { isManualPhotosOnly } from '../manualPhotosOnly';
import { effectiveTimezone } from '../../settings/uiDefaults';
import { getAutoSubmitClockWindowState } from '../../scheduling/autoSubmitWindow';

const tieOrder: Record<string, number> = { autoSubmit: 0, emergencySubmit: 1, boost: 2, turbo: 3 };

// The latest instant a moved Boost row may point at: the boost's own deadline minus one last
// poll, mirroring BOOST_HOLD_MARGIN_SEC (decisions/boostTurbo) and PIN_WAIT_WAKE_GAP_SEC
// (votingOrchestrator/boost), so a fill scheduled after the boost dies never moves the row past
// its death.
const BOOST_ROW_LAST_CHANCE_SEC = 60;

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

const hasActiveClockAutoSubmit = (challenge: Challenge, challengeId: string, now: number): boolean => {
    if (settings.getEffectiveSetting('autoSubmit', challengeId) !== true) return false;
    if (getSlotsRemaining(challenge) <= 0) return false;
    const timezone = effectiveTimezone(settings.getSetting('timezone'));
    return getAutoSubmitClockWindowState(
        settings.getEffectiveSetting('autoSubmitTime', challengeId),
        settings.getEffectiveSetting('autoSubmitWindowMinutes', challengeId),
        timezone,
        now,
    ).active;
};

const autoSubmitDueAt = (challenge: Challenge, challengeId: string, now: number): number | null => {
    if (settings.getEffectiveSetting('autoSubmit', challengeId) !== true || isManualPhotosOnly(settings, challengeId))
        return null;
    if (getSlotsRemaining(challenge) <= 0) return null;
    const closeTime = Number(challenge.close_time);
    if (!Number.isFinite(closeTime) || closeTime <= now) return null;
    const clock = getAutoSubmitClockWindowState(
        settings.getEffectiveSetting('autoSubmitTime', challengeId),
        settings.getEffectiveSetting('autoSubmitWindowMinutes', challengeId),
        effectiveTimezone(settings.getSetting('timezone')),
        now,
    );
    const relativeThreshold = getAutoFillThresholdSec(challenge, challengeId);
    const relativeDueAt = relativeThreshold > 0 ? closeTime - relativeThreshold : null;
    const clockDueAt = clock.active
        ? now
        : clock.nextStart !== null && clock.nextStart < closeTime
          ? clock.nextStart
          : null;
    return (
        [relativeDueAt, clockDueAt].filter((dueAt): dueAt is number => dueAt !== null).sort((a, b) => a - b)[0] ?? null
    );
};

const isVisibleDeadlineAction = ({
    action,
    thresholdSec,
    fillInstant,
    challenge,
    challengeId,
    boostRowHidden,
    turboRowHidden,
}: {
    action: string;
    thresholdSec: number;
    fillInstant: number | null;
    challenge: Challenge;
    challengeId: string;
    boostRowHidden: boolean;
    turboRowHidden: boolean;
}): boolean => {
    if (action === 'autoSubmit') return fillInstant !== null;
    if (!Number.isFinite(thresholdSec) || thresholdSec <= 0) return false;
    switch (action) {
        case 'turbo':
            return (
                challenge?.member?.turbo?.state === 'WON' &&
                isKnownTurboMode(challenge?.member?.turbo) &&
                settings.getEffectiveSetting('useTurbo', challengeId) === true &&
                !turboRowHidden
            );
        case 'boost': {
            if (settings.getEffectiveSetting('autoBoost', challengeId) !== true || boostRowHidden) return false;
            const boost = challenge?.member?.boost;
            const timerBoost = boost?.state === 'AVAILABLE' && typeof boost.timeout === 'number' && boost.timeout > 0;
            return !timerBoost || getEffectiveBoostTime(challengeId) > 0;
        }
        case 'emergencySubmit':
            return !evaluateEmergencyFill(challenge, challenge?.id, settings).standDown;
        /* istanbul ignore next */
        default:
            return false;
    }
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
    now: number,
): Array<{ action: 'autoSubmit' | 'turbo' | 'emergencySubmit' | 'boost'; thresholdSec: number }> => {
    const challengeId = challenge?.id?.toString?.() || '';
    const actions: Array<{ action: 'autoSubmit' | 'turbo' | 'emergencySubmit' | 'boost'; thresholdSec: number }> = [
        { action: 'autoSubmit', thresholdSec: getAutoFillThresholdSec(challenge, challengeId) },
        { action: 'turbo', thresholdSec: getEffectiveTurboTime(challengeId) },
        { action: 'emergencySubmit', thresholdSec: getEmergencyFillThresholdSec(challengeId) },
        { action: 'boost', thresholdSec: getBoostThresholdSec(challenge, challengeId) },
    ];
    const autoSubmit = actions[0]!;
    const ordered = actions.sort(compareDeadlineActions);
    if (!hasActiveClockAutoSubmit(challenge, challengeId, now)) return ordered;
    // A clock window asks to submit every remaining slot, so landing its first
    // photo before Boost/Turbo lets later deadline actions use that new entry.
    return [autoSubmit, ...ordered.filter(({ action }) => action !== 'autoSubmit')];
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
 * slot — nor the Boost-pinned submit with a free slot — resolves it. The runner reaches the
 * Boost-pinned submit before any slot pick, so it also places a Boost whose pin is gone. The
 * deadline view and the sleep boost share this one rule.
 *
 * @param now - Unix timestamp in seconds
 */
const isBoostBlocked = (
    challenge: Challenge,
    challengeId: string,
    now: number,
    entryAges: EntryAgeLedger | null,
): boolean => {
    const entries = challenge?.member?.ranking?.entries;
    const hasEntries = Array.isArray(entries) && entries.length >= 1;
    const hasFreeSlot = getSlotsRemaining(challenge) > 0;
    return (
        isBoostWindowOpen(challenge, now) &&
        hasEntries &&
        pickBoostEntry(challenge, challengeId, now) === null &&
        !(
            hasFreeSlot &&
            (resolveBoostFillNewMode(challenge, challengeId) !== 'no' ||
                canSubmitBoostPin(challenge, challengeId, entryAges) !== null)
        )
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
 * With Manual Only on a pin-caused block is not a block: the card's Boost and Turbo buttons send
 * the photo the user clicked straight to the apply path and never consult a pin, so a pin only
 * steers the automatic spends, which do not run. A flag block is real for manual play too.
 *
 * @param now - Unix timestamp in seconds
 */
const describeConflicts = (
    challenge: Challenge,
    challengeId: string,
    now: number,
    manualOnly: boolean,
    entryAges: EntryAgeLedger | null,
): Conflicts => {
    const entries = challenge?.member?.ranking?.entries;
    const hasEntries = Array.isArray(entries) && entries.length >= 1;
    const hasFreeSlot = getSlotsRemaining(challenge) > 0;
    const rawBoostBlocked = isBoostBlocked(challenge, challengeId, now, entryAges);
    const rawTurboBlocked =
        challenge?.member?.turbo?.state === 'WON' &&
        isKnownTurboMode(challenge.member.turbo) &&
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
    const rawBoostBy = causeOf(rawBoostBlocked, 'turbo');
    const rawTurboBy = causeOf(rawTurboBlocked, 'boost');
    const boostBlocked = rawBoostBlocked && !(manualOnly && rawBoostBy === 'pin');
    const turboBlocked = rawTurboBlocked && !(manualOnly && rawTurboBy === 'pin');
    return {
        boostBlocked,
        turboBlocked,
        boostBlockedBy: boostBlocked ? rawBoostBy : null,
        turboBlockedBy: turboBlocked ? rawTurboBy : null,
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
 *   - a pin on the feature's own photo is absolute: `conflict` (the photo carries the other
 *     feature) hides the row, and `gone` (the photo is not in the challenge) moves it past the
 *     fill instant — or hides it when no fill will plausibly run (autoSubmit off, or no
 *     schedule threshold ahead). A gone Boost pin is exempt from both while the Boost-pinned
 *     submit is eligible (boostPinSubmits): the runner submits that photo at the next
 *     Auto-Submit, or when the boost is due if that comes first, so the boost row keeps its
 *     own time.
 *   - autoSubmit: gate on the autoSubmit toggle (a schedule can imply a threshold
 *     while auto-fill is disabled).
 *   - emergencySubmit: its threshold is a fixed setting that never reflects live
 *     state, so defer to the runner's own evaluateEmergencyFill (no id, no free
 *     slot, or normal auto-fill already owning the fill). Shared code, not a
 *     copy, so the row cannot drift from what actually runs.
 *   - a threshold of 0 / -Infinity means off/n-a (auto-fill satisfied,
 *     emergency-fill off, key-unlocked boost off) — always omitted.
 *
 * Manual Only: the app does nothing by itself on the challenge, so `actions` is empty (the conflict
 * flags stay, see describeConflicts). This one function also feeds the sleep boost, the quit guard,
 * deadline notifications and the card timeline.
 *
 * Purely reads the passed challenge object (never mutates it, never calls an
 * apply path), so it cannot perturb a concurrent sequential voting pass. The
 * entry count is read at call time, so this is a snapshot that can drift from
 * what the runner later sees after a mid-cycle fill — callers must present it
 * as advisory.
 *
 * @param now - Unix timestamp in seconds
 * @param entryAges - the ledger the runner writes, so the Boost-pinned submit's failure latch is
 *   honoured here exactly as the runner reads it (the mode-aware selector apiFactory.getEntryAgeLedger)
 */
const describeDeadlineActions = (
    challenge: Challenge,
    now: number,
    entryAges: EntryAgeLedger | null,
): {
    actions: Array<{ action: string; thresholdSec: number; dueAt: number | null }>;
    boostPinSubmits: boolean;
} & Conflicts => {
    const challengeId = challenge?.id?.toString?.() || '';
    const closeTime = Number(challenge?.close_time);
    const manualOnly = isManualPhotosOnly(settings, challengeId);
    const conflicts = describeConflicts(challenge, challengeId, now, manualOnly, entryAges);
    // The Boost-pinned submit can place the boost on its gone pin right now; while it can, the
    // gone pin neither hides the boost row for a missing fill nor moves the row to the fill
    // instant — the photo goes in at the next Auto-Submit, or at the boost row's own time
    // when that comes first.
    const boostPinSubmitActive = canSubmitBoostPin(challenge, challengeId, entryAges) !== null;
    const { boostBlocked, turboBlocked, boostReleaseAt, turboReleaseAt } = conflicts;
    // The pin on a feature's own photo is absolute, so the row must not promise a spend the
    // runner will not make: `conflict` (the photo carries the other feature) never fires, and
    // `gone` (the photo is not in the challenge) waits for the scheduled fill — which never runs
    // when the autoSubmit toggle is off or no schedule threshold is ahead. The emergency fill is
    // excluded on purpose: it can still submit the photo at the buzzer with autoSubmit off, and
    // the row then reappears the moment the pin hits, so the hide names only the scheduled fill.
    // The pin banner owns both explanations.
    const fillInstant = autoSubmitDueAt(challenge, challengeId, now);
    const boostPinState = resolvePin(challenge, challengeId, 'boost').state;
    const turboPinState = resolvePin(challenge, challengeId, 'turbo').state;
    const ownPinHidesRow = (kind: 'boost' | 'turbo', state: typeof boostPinState) =>
        state === 'conflict' ||
        (state === 'gone' && fillInstant === null && !(kind === 'boost' && boostPinSubmitActive));
    // A blocked spend whose pin will give way is still coming, just later: its row stays.
    const boostRowHidden = (boostBlocked && boostReleaseAt === null) || ownPinHidesRow('boost', boostPinState);
    const turboRowHidden = (turboBlocked && turboReleaseAt === null) || ownPinHidesRow('turbo', turboPinState);

    // Manual Only: nothing runs by itself, so the action list is empty and the flag is false with
    // it (canSubmitBoostPin already answers null under Manual Only).
    if (manualOnly) return { actions: [], boostPinSubmits: false, ...conflicts };

    const actions = orderDeadlineActions(challenge, now)
        .filter(({ action, thresholdSec }) =>
            isVisibleDeadlineAction({
                action,
                thresholdSec,
                fillInstant,
                challenge,
                challengeId,
                boostRowHidden,
                turboRowHidden,
            }),
        )
        .map(({ action, thresholdSec }) => {
            const dueAt =
                action === 'autoSubmit' ? fillInstant : Number.isFinite(closeTime) ? closeTime - thresholdSec : null;
            const ownReleaseAt = action === 'boost' ? boostReleaseAt : action === 'turbo' ? turboReleaseAt : null;
            // Only the feature's own pin moves its row: a gone Boost pin moves the boost row, a
            // gone Turbo pin the turbo row, and the fill rows (autoSubmit, emergencySubmit) keep
            // their own thresholds — the runner fires them on their own windows regardless of pins.
            // A gone Boost pin with the pinned submit eligible is exempt: the photo goes in at the
            // next Auto-Submit or when the boost is due, so the row keeps its own time.
            const ownPinState = action === 'boost' ? boostPinState : action === 'turbo' ? turboPinState : null;
            const waitsForFill = ownPinState === 'gone' && !(action === 'boost' && boostPinSubmitActive);
            // A Boost row never moves past its own deadline's last chance: a fill landing after
            // the boost dies shows the last poll (boostDeadline − 60, mirroring the wake clamp in
            // armPinWaitWake) instead of promising a spend past its death. A Turbo's deadline is
            // the close, which no fill instant can pass, so its row needs no clamp.
            const waitInstant =
                action === 'boost' && fillInstant !== null
                    ? Math.min(fillInstant, boostDeadline(challenge) - BOOST_ROW_LAST_CHANCE_SEC)
                    : fillInstant;
            const releaseAt =
                waitsForFill && waitInstant !== null
                    ? ownReleaseAt === null
                        ? waitInstant
                        : Math.max(ownReleaseAt, waitInstant)
                    : ownReleaseAt;
            // A held-back spend is due once its pin has given way, if that is later than its own time.
            return releaseAt === null || dueAt === null
                ? { action, thresholdSec, dueAt }
                : {
                      action,
                      thresholdSec: Math.min(thresholdSec, closeTime - releaseAt),
                      dueAt: Math.max(dueAt, releaseAt),
                  };
        })
        // A clock-only row has threshold 0 but can be due now, so timeline order
        // follows its actual instant; the established threshold/tie order resolves
        // equal instants without changing the transport shape.
        .sort((a, b) => {
            if (a.dueAt === null || b.dueAt === null) return compareDeadlineActions(a, b);
            return a.dueAt !== b.dueAt ? a.dueAt - b.dueAt : compareDeadlineActions(a, b);
        });

    // The banner flag follows the Boost row: the pinned submit is only promised when it is
    // eligible AND the boost row made the action list — Auto Boost off, Boost Time 0 (or a
    // key-unlocked window of 0) and no available Boost all leave the row out, and the runner
    // then has no due boost to submit the photo for.
    return {
        actions,
        boostPinSubmits: boostPinSubmitActive && actions.some(({ action }) => action === 'boost'),
        ...conflicts,
    };
};

export { getAutoFillThresholdSec, getBoostThresholdSec, isBoostBlocked, orderDeadlineActions, describeDeadlineActions };
