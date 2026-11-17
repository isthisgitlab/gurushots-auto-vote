/**
 * Auto-fill — the near-deadline safety net that fills every remaining slot in
 * one batch, and the state-only stand-down check it shares with the deadline view.
 */

import { pickPhotosForChallenge } from '../photoPicker';
import { getEntries, getSlotsRemaining, reflectNewEntry } from './challengeState';
import { resolveScheduleTarget } from './schedule';
import { resolveAutoSubmitTrigger } from './staggeredFill';
import { runFillAttempt } from './pipeline';
import { isManualPhotosOnly } from '../manualPhotosOnly';
import { finiteOr } from '../../numbers';

import type { Challenge } from '../../types/gurushots';
import type { FillSettings, SettingsFillDeps } from '../../types/autoFill';

/** The state-only verdict `evaluateEmergencyFill` hands the runner and the deadline view. */
type EmergencyFillGate = {
    standDown: boolean;
    autoSubmitEnabled: boolean;
    mustIncludeTags: string[] | null;
    probeApplies: boolean;
    /** What the schedule and any active clock window demand at `now`; 0 while auto-submit is off. */
    desired: number;
    /** The schedule-aware no-filter path acted — the runner names the cleared shortfall in its success log. */
    scheduleCatchUp: boolean;
};

/**
 * Whether Submit Only Chosen Photos is on for a challenge with a non-empty list.
 * Only read where it can change the verdict (auto-fill on, no must-include
 * filter): every other path is settled without it.
 */
const onlyChosenActive = (settings: FillSettings, challengeId: string | number): boolean => {
    const list = settings.getEffectiveSetting('chosenPhotos', String(challengeId));
    return (
        Array.isArray(list) &&
        list.length > 0 &&
        settings.getEffectiveSetting('chosenPhotosOnly', String(challengeId)) === true
    );
};

/**
 * Whether emergency fill stands down on LIVE STATE alone, independent of timing.
 * Owned here, beside the runner that enforces it, and exported so the read-only
 * renderer view (VotingLogic.describeDeadlineActions, which drives the deadline
 * timeline and the desktop notifications) decides row visibility from the very
 * same code instead of a second copy that can silently drift.
 *
 * Covers the state-only stand-downs maybeEmergencyFillChallenge takes
 * before any network call:
 *   - no challenge id (`undefined`/`null`, exactly the runner's own guard — an
 *     empty-string id is NOT one of them, so callers that normalise a missing id
 *     to '' must pass the raw id instead),
 *   - Manual Only on for the challenge (it never submits by itself),
 *   - no free slot left to fill, and
 *   - "auto-submit owns this challenge": auto-submit on with no must-include
 *     filter AND its schedule caught up — entries at or above what the
 *     schedule and any active clock window demand (`resolveAutoSubmitTrigger`'s
 *     `desired`) — the common configuration, in which the staggered path fills
 *     the slots and emergency fill has nothing to add. Two schedule-progress
 *     states hand the challenge back: behind schedule (the app slept through
 *     cycles, so one pick per cycle cannot clear the shortfall inside the
 *     window) and a schedule that tops out below what the challenge allows
 *     (the warning in resolveAutoSubmitDue already promises those slots to
 *     emergency fill). A no-schedule opt-out stays a stand-down: with nothing
 *     demanding entries `desired` is 0, so neither state applies. Submit Only
 *     Chosen Photos with a non-empty list does NOT count as owning it: the
 *     staggered path may then skip the challenge (no usable chosen photo) and
 *     emergency fill ignores that setting, so — like a must-include filter —
 *     it is "may fill" here and the runner's probe decides. Read from the
 *     saved settings only; whether the list belongs to the signed-in account
 *     is a network lookup only the runner can make.
 *
 * Deliberately NOT covered — the caller owns these:
 *   - the timing/enabled checks (`emergencySubmit` seconds, close_time, whether
 *     `now` is inside the window), because the view expresses them as a
 *     threshold and a due instant rather than a boolean, and
 *   - the runner's final stand-down, a dry-run probe of whether the
 *     must-include filter would actually leave the slot empty. That needs the
 *     eligible-photo list over the network, so a read-only caller must treat
 *     "filter set" as "may fill" rather than "will fill".
 *
 * `probeApplies` answers whether the runner's probe is worth running: the
 * probe models "the staggered path can still pick a photo", which only
 * argues for standing down when the schedule is caught up — when the
 * challenge is behind or the schedule topped out, one pick per cycle cannot
 * clear the shortfall inside the window, so the probe must not apply and the
 * batch fills directly. With a must-include filter or Submit Only Chosen
 * Photos the probe is the only decider, so it applies whenever auto-submit
 * is on and the schedule is caught up.
 *
 * Returns the two settings it resolved alongside the verdict — plus `desired`
 * and `scheduleCatchUp`, the figures the runner's success log names when the
 * schedule-aware path acted — so nothing downstream re-reads settings: every
 * `getEffectiveSetting` is an uncached `readFileSync` +
 * merge + migrate (settings/storage.ts readRaw), so re-reading them would add
 * real synchronous I/O to a path that runs seconds before a deadline. Nothing is
 * read until after the id and free-slot checks, keeping the stand-down paths
 * cheaper than a caller that resolved them up front. `settings` is a parameter
 * because this module takes the facade via `deps` while VotingLogic requires it
 * directly.
 *
 * @param challengeId raw id; do not normalise it
 * @param now unix seconds, the instant the schedule progress is measured at
 *   standDown true = would do nothing, so never advertise it as upcoming
 */
const evaluateEmergencyFill = (
    challenge: Challenge,
    challengeId: string | number | null | undefined,
    settings: FillSettings,
    now: number,
): EmergencyFillGate => {
    const inert: EmergencyFillGate = {
        standDown: true,
        autoSubmitEnabled: false,
        mustIncludeTags: null,
        probeApplies: false,
        desired: 0,
        scheduleCatchUp: false,
    };
    if (challengeId === undefined || challengeId === null) return inert;
    if (getSlotsRemaining(challenge) <= 0) return inert;
    // Manual Only: nothing is submitted by itself, so the deadline view drops the row too.
    if (isManualPhotosOnly(settings, challengeId)) return inert;

    const mustIncludeTags = settings.getEffectiveTagSetting('mustIncludeTags', challenge);
    const autoSubmitEnabled = settings.getEffectiveSetting('autoSubmit', String(challengeId)) === true;
    const mustActive = Array.isArray(mustIncludeTags) && mustIncludeTags.length > 0;

    // Schedule progress only matters while auto-submit is on: with it off,
    // emergency fill is the only filler, and the probe never applies.
    let behind = false;
    let toppedOut = false;
    let desired = 0;
    let onlyChosen = false;
    if (autoSubmitEnabled) {
        const trigger = resolveAutoSubmitTrigger(challenge, String(challengeId), now, settings);
        desired = trigger.desired;
        const max = finiteOr(challenge.max_photo_submits, 0);
        // Highest target the schedule can ever demand = the target as time runs
        // out (secondsRemaining → 0 matches every row) — the same figure the
        // top-out warning in resolveAutoSubmitDue uses, over the schedule the
        // trigger already read.
        const maxTarget = resolveScheduleTarget(trigger.schedule, 0, max);
        behind = getEntries(challenge).length < desired;
        // Mirrors the top-out warning's condition: the schedule is met but no
        // later row or clock window will ever raise the target, so the slots
        // above it stay empty unless emergency fill takes them. `>=` is safe
        // where the warning uses `===`: desired can only exceed maxTarget while
        // an active clock window demands every slot, and then entries < desired
        // (behind) until the challenge is full — which is inert above — so this
        // flag can only decide a verdict in the same state the warning names.
        toppedOut =
            desired > 0 &&
            desired >= maxTarget &&
            maxTarget < max &&
            (trigger.nextClockStart === null || trigger.nextClockStart >= Number(challenge.close_time));
        // The chosen list is only read where it can change the verdict — the
        // same short-circuit the stand-down below expresses.
        if (!mustActive) onlyChosen = onlyChosenActive(settings, challengeId);
    }
    const probeApplies = autoSubmitEnabled && !behind && !toppedOut;
    const standDown = autoSubmitEnabled && !mustActive && !onlyChosen && !behind && !toppedOut;
    const scheduleCatchUp = autoSubmitEnabled && !mustActive && !onlyChosen && !probeApplies;
    return { standDown, autoSubmitEnabled, mustIncludeTags, probeApplies, desired, scheduleCatchUp };
};

/**
 * Emergency fill — a safety net for the slots the staggered
 * auto-fill path would leave empty right up to the deadline:
 *   (a) auto-fill is off for the challenge,
 *   (b) a Must Include Tags filter is set, nothing matches it, and
 *       submitWithoutTagMatch is off (so the slot would stay empty),
 *   (c) the auto-submit schedule is behind (the app missed cycles, so one
 *       pick per cycle cannot catch up inside the window), or
 *   (d) the schedule tops out below what the challenge allows and slots
 *       above its highest target would stay empty.
 *
 * When the challenge is within `emergencySubmit` seconds of closing and in
 * one of those states, fill every remaining slot in a single submission,
 * relaxing the must-include hard filter (the whole point is "don't leave
 * slots empty at the buzzer"). There's no time to stagger this close to
 * the end, so unlike maybeAutoFillChallenge it batches all slots at once,
 * like the manual "fill all" button. Self-guarding: if auto-fill is caught
 * up on its schedule and would already handle the challenge, it returns
 * 'skipped' so it never double-fills.
 *
 * @param challenge - challenge with member.ranking.entries
 * @param now - unix seconds
 * @param deps - getActiveChallenges enables the pre-submit live re-check; when
 *   absent the fill proceeds on pass-start data.
 */
const maybeEmergencyFillChallenge = async (
    challenge: Challenge,
    token: string,
    now: number,
    deps: SettingsFillDeps,
): Promise<'submitted' | 'skipped' | 'disabled' | 'no-eligible-photos' | 'error'> => {
    const { settings, logger } = deps;
    const challengeId = challenge?.id;
    if (challengeId === undefined || challengeId === null) return 'skipped';

    const emergencySeconds = settings.getEffectiveSetting('emergencySubmit', String(challengeId));
    if (!Number.isFinite(emergencySeconds) || emergencySeconds <= 0) return 'disabled';

    const closeTime = Number(challenge.close_time);
    if (!Number.isFinite(closeTime)) return 'skipped';
    const secondsRemaining = closeTime - now;
    if (secondsRemaining <= 0) return 'skipped';
    if (secondsRemaining > emergencySeconds) return 'skipped'; // not in the emergency window yet

    // Stand down before any network call on the state-only conditions: no free
    // slot, and auto-submit already owning this challenge (auto-submit on with
    // no must-include filter AND its schedule caught up — the common
    // configuration, where the early return avoids fetching eligible photos
    // every cycle just to discard them; behind schedule or a topped-out
    // schedule is exactly what emergency fill is for). Shared with the
    // read-only timeline view so the two cannot drift; it hands back the
    // settings it resolved so nothing below re-reads them.
    const gate = evaluateEmergencyFill(challenge, challengeId, settings, now);
    if (gate.standDown) return 'skipped';
    const { mustIncludeTags, probeApplies } = gate;

    // Pre-submit entry count, for the schedule-progress note in the success log.
    const entriesBefore = getEntries(challenge).length;

    let slotsRemaining = getSlotsRemaining(challenge);
    const shouldIncludeTags = settings.getEffectiveTagSetting('shouldIncludeTags', challenge);
    const submitWithoutTagMatch = settings.getEffectiveSetting('submitWithoutTagMatch', String(challengeId));

    const attempt = await runFillAttempt({
        label: 'emergencySubmit',
        challenge,
        token,
        deps,
        // Fill every remaining slot. Keep the user's tag preferences (must
        // photos still win when they exist) but force submitWithoutTagMatch on so
        // a missing match never leaves a slot empty at the deadline — that
        // override is the whole point of emergency fill.
        wantCount: slotsRemaining,
        mustIncludeTags,
        shouldIncludeTags,
        submitWithoutTagMatch: true,
        // With auto-submit caught up on its schedule and a must-include filter
        // or Submit Only Chosen Photos set, only step in if that filter would
        // leave the slot empty (a non-empty result means the normal staggered
        // path can still fill it, so stand down). With auto-submit off, or the
        // schedule behind or topped out, the probe never applies — nothing the
        // staggered path can still do will clear the shortfall inside the
        // window, so the batch fills directly. Dry-run probe: no onFallback,
        // and the user's real submitWithoutTagMatch setting applies. The probe
        // models the staggered path, so it sees the chosen photos the way that
        // path would: with Submit Only on and none usable it would skip, which
        // is exactly when emergency fill must step in.
        probeStandDown: probeApplies
            ? ({ eligible, semanticScores, chosen }) =>
                  pickPhotosForChallenge(challenge, eligible, 1, {
                      mustIncludeTags,
                      shouldIncludeTags,
                      submitWithoutTagMatch,
                      semanticScores,
                      chosen,
                  }).length > 0
            : null,
        // Live re-check just before the batch submit: an entry added outside
        // this run (e.g. a manual submission) shrinks the free-slot count, and
        // the batch must never over-fill past it.
        onRefreshed: (picked) => {
            slotsRemaining = getSlotsRemaining(challenge);
            if (slotsRemaining <= 0) {
                logger
                    .withCategory('autoSubmit')
                    .info(
                        `emergencySubmit: live re-check shows ${logger.challengeTag(challenge)} has no free slots — an entry was added outside this run (e.g. a manual submission); standing down`,
                        null,
                    );
                return { standDown: true };
            }
            if (picked.length > slotsRemaining) {
                return { picked: picked.slice(0, slotsRemaining) };
            }
            return null;
        },
    });
    if (attempt.status === 'no-pick') return 'no-eligible-photos';
    // Emergency fill ignores Submit Only Chosen Photos, so it never answers 'no-chosen'.
    if (
        attempt.status === 'probe-stand-down' ||
        attempt.status === 'gone' ||
        attempt.status === 'invalid' ||
        attempt.status === 'refresh-stand-down'
    ) {
        return 'skipped';
    }
    if (attempt.status !== 'submitted') return 'error';

    // Reflect every consumed slot locally so a due turbo/boost later this
    // cycle (timer order) sees the new entries and correct slot count.
    for (const id of attempt.picked) reflectNewEntry(challenge, id);
    // When the schedule-aware path acted (auto-submit on, no filter, the
    // schedule behind or topped out), name the shortfall the batch cleared —
    // the filter path's log already explains itself through the probe. Both
    // figures come from the gate, so the log re-reads nothing.
    const scheduleNote = gate.scheduleCatchUp ? ` (${entriesBefore} of ${gate.desired} target entries in)` : '';
    logger
        .withCategory('autoSubmit')
        .success(
            `emergencySubmit: submitted ${attempt.picked.length} entr${attempt.picked.length === 1 ? 'y' : 'ies'} for ${logger.challengeTag(challenge)} near deadline${scheduleNote}`,
            null,
        );
    return 'submitted';
};

export { evaluateEmergencyFill, maybeEmergencyFillChallenge };
