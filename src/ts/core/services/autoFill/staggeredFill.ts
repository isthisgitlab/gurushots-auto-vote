/**
 * Auto-fill — the cycle-driven, schedule-based fill: at most one photo per
 * scheduler cycle, spaced by the user's autoSubmitSchedule.
 */

import { getScheduleShift } from '../scheduleRemap';
import { resolveScheduleTarget } from './schedule';
import { getEntries, getSlotsRemaining, reflectNewEntry, refreshChallengeState } from './challengeState';
import { runFillAttempt } from './pipeline';
import { finiteOr } from '../../numbers';
import { isManualPhotosOnly } from '../manualPhotosOnly';
import { effectiveTimezone } from '../../settings/uiDefaults';
import { getAutoSubmitClockWindowState } from '../../scheduling/autoSubmitWindow';
import { isCancelled } from '../../voting/cancellation';

import type { Challenge } from '../../types/gurushots';
import type { SettingsFillDeps } from '../../types/autoFill';

type AutoSubmitTrigger = {
    relativeTarget: number;
    clockTarget: number;
    desired: number;
    activeClockTimes: string[];
    nextClockStart: number | null;
    timezone: string;
};

type FinalAuthorization = {
    trigger: AutoSubmitTrigger;
    authorizer: 'clock' | 'relative' | 'both';
    schedule: Parameters<typeof getScheduleShift>[0];
    desired: number;
    slotsRemaining: number;
};

const resolveAutoSubmitTrigger = (
    challenge: Challenge,
    challengeId: string,
    now: number,
    deps: SettingsFillDeps,
): AutoSubmitTrigger => {
    const schedule = deps.settings.getEffectiveSetting('autoSubmitSchedule', challengeId);
    const closeTime = Number(challenge.close_time);
    const relativeTarget =
        Array.isArray(schedule) && Number.isFinite(closeTime)
            ? resolveScheduleTarget(schedule, closeTime - now, challenge.max_photo_submits)
            : 0;
    const clockTimes = deps.settings.getEffectiveSetting('autoSubmitTime', challengeId);
    if (!Array.isArray(clockTimes) || clockTimes.length === 0) {
        return {
            relativeTarget,
            clockTarget: 0,
            desired: relativeTarget,
            activeClockTimes: [],
            nextClockStart: null,
            timezone: 'UTC',
        };
    }
    const timezone = effectiveTimezone(deps.settings.getSetting?.('timezone'));
    const clockState = getAutoSubmitClockWindowState(
        clockTimes,
        deps.settings.getEffectiveSetting('autoSubmitWindowMinutes', challengeId),
        timezone,
        now,
    );
    const clockTarget = clockState.active ? finiteOr(challenge.max_photo_submits, 0) : 0;
    return {
        relativeTarget,
        clockTarget,
        desired: Math.max(relativeTarget, clockTarget),
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
        const finalNow = deps.wallClockNow?.() ?? Math.floor(Date.now() / 1000);
        if (
            isCancelled() ||
            deps.settings.getEffectiveSetting('autoSubmit', challengeId) !== true ||
            isManualPhotosOnly(deps.settings, challengeId) ||
            Number(challenge.close_time) <= finalNow ||
            getSlotsRemaining(challenge) <= 0
        ) {
            return { standDown: true };
        }
        const current = resolveAutoSubmitTrigger(challenge, challengeId, finalNow, deps);
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
        finalAuthorization.schedule = deps.settings.getEffectiveSetting('autoSubmitSchedule', challengeId);
        finalAuthorization.desired =
            finalAuthorization.authorizer === 'clock' ? current.desired : current.relativeTarget;
        finalAuthorization.slotsRemaining = getSlotsRemaining(challenge);
        return null;
    };

const logAutoSubmitSuccess = ({
    challenge,
    schedule,
    desired,
    slotsRemaining,
    finalAuthorization,
    logger,
}: {
    challenge: Challenge;
    schedule: Parameters<typeof getScheduleShift>[0];
    desired: number;
    slotsRemaining: number;
    finalAuthorization: FinalAuthorization;
    logger: SettingsFillDeps['logger'];
}): void => {
    const maxSubmits = challenge.max_photo_submits;
    const shift = getScheduleShift(schedule, maxSubmits);
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

    const schedule = settings.getEffectiveSetting('autoSubmitSchedule', String(challengeId));
    // Distinct from 'disabled' (toggle off): the toggle is on but there is no
    // schedule to act on — a deliberate opt-out state the GUI editor warns about.
    const trigger = resolveAutoSubmitTrigger(challenge, String(challengeId), now, deps);
    if ((!Array.isArray(schedule) || schedule.length === 0) && trigger.clockTarget === 0) {
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
        // Highest target the schedule can ever demand = the target as time
        // runs out (secondsRemaining → 0 matches every row), so reuse
        // resolveScheduleTarget instead of re-deriving the clamp-and-max here.
        const maxTarget = resolveScheduleTarget(schedule, 0, max);
        if (
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
    return { due: true, authorization: { trigger, authorizer: 'relative', schedule, desired, slotsRemaining } };
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
            const refreshedTrigger = resolveAutoSubmitTrigger(challenge, String(challengeId), now, deps);
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
        schedule: finalAuthorization.schedule,
        desired: finalAuthorization.desired,
        slotsRemaining: finalAuthorization.slotsRemaining,
        finalAuthorization,
        logger,
    });
    return 'submitted';
};

export { maybeAutoFillChallenge, resolveAutoSubmitDue, createFinalEligibility };
