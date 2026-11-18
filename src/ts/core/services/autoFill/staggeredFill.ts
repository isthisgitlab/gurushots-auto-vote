/**
 * Auto-fill — the cycle-driven, schedule-based fill: at most one photo per
 * scheduler cycle, spaced by the user's autoSubmitSchedule.
 */

import { authorizeSubmit, lowerSubmitSchedule, submitCeiling, submitShift } from './schedule';
import { clockSec } from '../../simulationScope';
import { getEntries, getSlotsRemaining, reflectNewEntry, refreshChallengeState } from './challengeState';
import { runFillAttempt } from './pipeline';
import { finiteOr } from '../../numbers';
import { isManualPhotosOnly } from '../manualPhotosOnly';
import { effectiveTimezone } from '../../settings/uiDefaults';
import { getAutoSubmitClockWindowState } from '../../scheduling/autoSubmitWindow';
import { isCancelled } from '../../voting/cancellation';

import type { Challenge } from '../../types/gurushots';
import type { FillSettings, ResolvedSubmitSchedule, SettingsFillDeps } from '../../types/autoFill';

type AutoSubmitTrigger = {
    relativeTarget: number;
    clockTarget: number;
    desired: number;
    /**
     * The overall relative target when it is exactly known: null while an unsatisfied unknown row of a dynamic schedule
     * could still raise it. `relativeTarget` is the proved lower authorization.
     */
    exactTarget: number | null;
    /** The schedule the targets were read from, as resolved rows; callers reuse it instead of re-reading. */
    resolved: ResolvedSubmitSchedule;
    /** Whether there is a schedule to act on at all: rows of a phase's dynamic schedule, or a non-empty literal one. */
    hasSchedule: boolean;
    activeClockTimes: string[];
    nextClockStart: number | null;
    timezone: string;
};

type FinalAuthorization = {
    trigger: AutoSubmitTrigger;
    authorizer: 'clock' | 'relative' | 'both';
    resolved: ResolvedSubmitSchedule;
    desired: number;
    slotsRemaining: number;
};

/**
 * The submit schedule that applies to a challenge, as resolved rows: the one its scenario phase published (a dynamic
 * schedule replaces the literal setting for as long as the phase holds it), else the literal autoSubmitSchedule setting
 * lowered against the challenge's close time. A phase whose published settings cannot be read has no schedule: nothing is
 * authorized on it.
 */
const resolveSubmitSchedule = (
    challenge: Challenge,
    challengeId: string,
    settings: FillSettings,
): { resolved: ResolvedSubmitSchedule; hasSchedule: boolean } => {
    const phase = settings.getPhaseSchedules?.(challengeId);
    if (phase?.kind === 'unavailable') {
        return { resolved: { alignment: 'end', rows: [] }, hasSchedule: false };
    }
    if (phase?.kind === 'resolved' && phase.schedules.submit) {
        return { resolved: phase.schedules.submit, hasSchedule: true };
    }
    const schedule = settings.getEffectiveSetting('autoSubmitSchedule', challengeId);
    return {
        resolved: lowerSubmitSchedule(Array.isArray(schedule) ? schedule : [], Number(challenge.close_time)),
        hasSchedule: Array.isArray(schedule) && schedule.length > 0,
    };
};

/**
 * What the schedule and any active clock window demand for the challenge at
 * `now`: `desired` is the higher of the two targets, so both the staggered
 * fill and the emergency fill's schedule-progress check read one number. The
 * relative target is the largest count a known due row asks for (an unknown row
 * never raises it; `exactTarget` says when one could).
 * Reads only `settings` (not the whole deps) so callers that hold the facade
 * directly can reuse it.
 */
const resolveAutoSubmitTrigger = (
    challenge: Challenge,
    challengeId: string,
    now: number,
    settings: FillSettings,
): AutoSubmitTrigger => {
    const { resolved, hasSchedule } = resolveSubmitSchedule(challenge, challengeId, settings);
    const { authorizedCount: relativeTarget, exactTarget } = authorizeSubmit(
        resolved,
        now,
        getEntries(challenge).length,
        challenge.max_photo_submits,
    );
    const clockTimes = settings.getEffectiveSetting('autoSubmitTime', challengeId);
    if (!Array.isArray(clockTimes) || clockTimes.length === 0) {
        return {
            relativeTarget,
            clockTarget: 0,
            desired: relativeTarget,
            exactTarget,
            resolved,
            hasSchedule,
            activeClockTimes: [],
            nextClockStart: null,
            timezone: 'UTC',
        };
    }
    const timezone = effectiveTimezone(settings.getSetting?.('timezone'));
    const clockState = getAutoSubmitClockWindowState(
        clockTimes,
        settings.getEffectiveSetting('autoSubmitWindowMinutes', challengeId),
        timezone,
        now,
    );
    const clockTarget = clockState.active ? finiteOr(challenge.max_photo_submits, 0) : 0;
    return {
        relativeTarget,
        clockTarget,
        desired: Math.max(relativeTarget, clockTarget),
        exactTarget,
        resolved,
        hasSchedule,
        activeClockTimes: clockState.activeTimes,
        nextClockStart: clockState.nextStart,
        timezone,
    };
};

const createFinalEligibility =
    (
        challenge: Challenge,
        challengeId: string,
        token: string,
        deps: SettingsFillDeps,
        finalAuthorization: FinalAuthorization,
    ) =>
    async (picked: readonly string[]) => {
        const refresh = await refreshChallengeState(challenge, token, deps, 'autoSubmit', true);
        if (refresh === 'gone' || refresh === 'invalid') return { standDown: true };
        const finalNow = deps.wallClockNow?.() ?? clockSec();
        if (
            isCancelled() ||
            deps.settings.getEffectiveSetting('autoSubmit', challengeId) !== true ||
            isManualPhotosOnly(deps.settings, challengeId) ||
            Number(challenge.close_time) <= finalNow ||
            getSlotsRemaining(challenge) <= 0
        ) {
            return { standDown: true };
        }
        const current = resolveAutoSubmitTrigger(challenge, challengeId, finalNow, deps.settings);
        const entryCount = getEntries(challenge).length;
        const enteredIds = new Set(
            getEntries(challenge)
                .filter((entry) => entry?.id !== undefined && entry.id !== null)
                .map((entry) => String(entry.id)),
        );
        if (picked.some((imageId) => enteredIds.has(String(imageId)))) return { standDown: true };
        // The trigger that starts an attempt does not have to be the one that authorizes the
        // submit: the check re-reads both at the final wall-clock time and any trigger that
        // still calls for another photo then authorizes it (and is recorded as the authorizer).
        // A clock window that ended during verification therefore cancels the submit only when
        // no relative target is due either.
        const relativeDue = entryCount < current.relativeTarget;
        const clockDue = entryCount < current.clockTarget;
        const clockAuthorizes = clockDue && refresh === 'refreshed';
        if (!relativeDue && !clockAuthorizes) {
            const message = clockDue
                ? `autoSubmit: clock window needs a fresh challenge state for ${deps.logger.challengeTag(challenge)}; standing down until a later cycle`
                : `autoSubmit: final eligibility check found ${entryCount} entries for ${deps.logger.challengeTag(challenge)}; no active trigger requires another photo`;
            deps.logger.withCategory('autoSubmit').info(message, null);
            return { standDown: true };
        }
        finalAuthorization.trigger = current;
        finalAuthorization.authorizer =
            relativeDue && clockAuthorizes ? 'both' : clockAuthorizes ? 'clock' : 'relative';
        finalAuthorization.resolved = current.resolved;
        finalAuthorization.desired =
            finalAuthorization.authorizer === 'clock' ? current.desired : current.relativeTarget;
        finalAuthorization.slotsRemaining = getSlotsRemaining(challenge);
        return null;
    };

const logAutoSubmitSuccess = ({
    challenge,
    resolved,
    desired,
    slotsRemaining,
    finalAuthorization,
    logger,
}: {
    challenge: Challenge;
    resolved: ResolvedSubmitSchedule;
    desired: number;
    slotsRemaining: number;
    finalAuthorization: FinalAuthorization;
    logger: SettingsFillDeps['logger'];
}): void => {
    const maxSubmits = challenge.max_photo_submits;
    const shift = submitShift(resolved, maxSubmits);
    const shiftNote =
        (finalAuthorization.authorizer === 'relative' || finalAuthorization.authorizer === 'both') && shift > 0
            ? `; ${maxSubmits}-image challenge — the target of ${desired} entries follows the Image ${desired + shift} time`
            : '';
    const authorizationNote =
        finalAuthorization.authorizer === 'relative'
            ? '; the relative schedule authorized this submission'
            : `; clock ${finalAuthorization.trigger?.activeClockTimes.join(', ')} (${finalAuthorization.trigger?.timezone})${
                  finalAuthorization.authorizer === 'both' ? ' and the relative schedule' : ''
              } authorized this submission`;
    logger
        .withCategory('autoSubmit')
        .success(
            `autoSubmit: submitted 1 entry for ${logger.challengeTag(challenge)} (${slotsRemaining - 1} slots remain${shiftNote}${authorizationNote})`,
            null,
        );
};

type AutoSubmitDue =
    | { due: false; status: 'skipped' | 'disabled' | 'no-schedule' }
    | { due: true; authorization: FinalAuthorization };

/**
 * Whether a scheduled Auto-Submit is due for the challenge right now: the id,
 * Manual Only, the autoSubmit toggle, the close time, a free slot, and a
 * schedule or clock window whose target exceeds the entries. A target that is
 * met while free slots remain and no later row raises it logs the top-out
 * warning. Reads only; the caller acts on the answer.
 *
 * @param now - unix seconds
 * @returns `due: false` with the status `maybeAutoFillChallenge` reports, or
 *   `due: true` with the authorization (the trigger, schedule, target and free
 *   slots) the attempt starts from; the final eligibility check updates that
 *   same object when it authorizes the submit
 */
const resolveAutoSubmitDue = (challenge: Challenge, now: number, deps: SettingsFillDeps): AutoSubmitDue => {
    const { settings, logger } = deps;
    const challengeId = challenge?.id;
    if (challengeId === undefined || challengeId === null) return { due: false, status: 'skipped' };
    if (isManualPhotosOnly(settings, challengeId)) return { due: false, status: 'disabled' };

    const enabled = settings.getEffectiveSetting('autoSubmit', String(challengeId));
    if (enabled !== true) return { due: false, status: 'disabled' };

    const closeTime = Number(challenge.close_time);
    if (!Number.isFinite(closeTime)) return { due: false, status: 'skipped' };
    const secondsRemaining = closeTime - now;
    if (secondsRemaining <= 0) return { due: false, status: 'skipped' };

    const slotsRemaining = getSlotsRemaining(challenge);
    if (slotsRemaining <= 0) return { due: false, status: 'skipped' };

    // Distinct from 'disabled' (toggle off): the toggle is on but there is no
    // schedule to act on — a deliberate opt-out state the GUI editor warns about.
    // The trigger carries the schedule it read, so nothing here re-reads it.
    const trigger = resolveAutoSubmitTrigger(challenge, String(challengeId), now, settings);
    const { resolved } = trigger;
    if (!trigger.hasSchedule && trigger.clockTarget === 0) {
        return { due: false, status: 'no-schedule' };
    }

    const desired = trigger.desired;
    if (getEntries(challenge).length >= desired) {
        // Schedule satisfied but free slots remain and no further row will ever
        // raise the target — the schedule tops out below what the challenge
        // allows. WARNING (not debug/info, which are compiled out of packaged
        // builds — see makeFallbackLogger) so a real user has a trace for why
        // those slots stay empty until emergency fill.
        const max = finiteOr(challenge.max_photo_submits, 0);
        // Highest target the schedule can ever demand, over its resolved rows. A schedule with an unknown row left to satisfy
        // is not known to top out: that row could still raise the target.
        const maxTarget = submitCeiling(resolved, max);
        if (
            trigger.exactTarget !== null &&
            trigger.relativeTarget >= trigger.clockTarget &&
            desired > 0 &&
            desired === maxTarget &&
            maxTarget < max &&
            (trigger.nextClockStart === null || trigger.nextClockStart >= closeTime)
        ) {
            logger
                .withCategory('autoSubmit')
                .warning(
                    `autoSubmit: schedule tops out at ${maxTarget} entries but ${logger.challengeTag(challenge)} allows ${max} — remaining slots are left to emergency fill`,
                    null,
                );
        }
        return { due: false, status: 'skipped' };
    }
    return { due: true, authorization: { trigger, authorizer: 'relative', resolved, desired, slotsRemaining } };
};

/**
 * Cycle-driven, schedule-based auto-fill. Submits at most one photo per
 * call; the next call (next scheduler cycle) will see the updated
 * entries.length and either skip (target met) or submit again — so a
 * challenge behind schedule catches up one photo per cycle.
 *
 * @param challenge - challenge with member.ranking.entries
 * @param now - unix seconds
 * @param deps - getActiveChallenges enables the pre-submit live re-check; when
 *   absent the fill proceeds on pass-start data.
 */
const maybeAutoFillChallenge = async (
    challenge: Challenge,
    token: string,
    now: number,
    deps: SettingsFillDeps,
): Promise<'submitted' | 'skipped' | 'disabled' | 'no-schedule' | 'no-eligible-photos' | 'error'> => {
    const { settings, logger } = deps;
    const due = resolveAutoSubmitDue(challenge, now, deps);
    if (!due.due) return due.status;
    const finalAuthorization = due.authorization;
    let { slotsRemaining } = finalAuthorization;
    const challengeId = challenge.id;

    const mustIncludeTags = settings.getEffectiveTagSetting('mustIncludeTags', challenge);
    const shouldIncludeTags = settings.getEffectiveTagSetting('shouldIncludeTags', challenge);
    const submitWithoutTagMatch = settings.getEffectiveSetting('submitWithoutTagMatch', String(challengeId));

    // Relative-only submission retains its established refresh policy. A
    // clock-triggered attempt needs a final wall-clock and live-state check,
    // because candidate verification can outlast the clock window.
    const finalEligibility = createFinalEligibility(challenge, String(challengeId), token, deps, finalAuthorization);
    const attempt = await runFillAttempt({
        label: 'autoSubmit',
        challenge,
        token,
        deps,
        wantCount: 1,
        mustIncludeTags,
        shouldIncludeTags,
        submitWithoutTagMatch,
        onRefreshed: () => {
            slotsRemaining = getSlotsRemaining(challenge);
            const entryCount = getEntries(challenge).length;
            const refreshedTrigger = resolveAutoSubmitTrigger(challenge, String(challengeId), now, deps.settings);
            if (slotsRemaining <= 0 || entryCount >= refreshedTrigger.desired) {
                logger
                    .withCategory('autoSubmit')
                    .info(
                        `autoSubmit: live re-check shows ${logger.challengeTag(challenge)} already has ${entryCount} entries (target ${refreshedTrigger.desired}) — an entry was added outside this run (e.g. a manual submission); standing down`,
                        null,
                    );
                return { standDown: true };
            }
            return null;
        },
        finalEligibility,
    });
    if (attempt.status === 'no-pick') return 'no-eligible-photos';
    // 'no-chosen': Submit Only Chosen Photos left the challenge alone (already explained in the log).
    if (
        attempt.status === 'gone' ||
        attempt.status === 'invalid' ||
        attempt.status === 'refresh-stand-down' ||
        attempt.status === 'no-chosen'
    ) {
        return 'skipped';
    }
    if (attempt.status !== 'submitted') return 'error';

    // Reflect the consumed slot locally so a due turbo/boost later this
    // cycle (timer order) sees the new entry and correct slot count.
    reflectNewEntry(challenge, attempt.picked[0]);
    logAutoSubmitSuccess({
        challenge,
        resolved: finalAuthorization.resolved,
        desired: finalAuthorization.desired,
        slotsRemaining: finalAuthorization.slotsRemaining,
        finalAuthorization,
        logger,
    });
    return 'submitted';
};

export { maybeAutoFillChallenge, resolveAutoSubmitDue, createFinalEligibility, resolveAutoSubmitTrigger };
