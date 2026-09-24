/**
 * Auto-fill — the cycle-driven, schedule-based fill: at most one photo per
 * scheduler cycle, spaced by the user's autoFillSchedule.
 */

const { getScheduleShift } = require('../scheduleRemap');
const { getValidScheduleRows, resolveScheduleTarget } = require('./schedule');
const { getEntries, getSlotsRemaining, reflectNewEntry } = require('./challengeState');
const { runFillAttempt } = require('./pipeline');

/**
 * Cycle-driven, schedule-based auto-fill. Submits at most one photo per
 * call; the next call (next scheduler cycle) will see the updated
 * entries.length and either skip (target met) or submit again — so a
 * challenge behind schedule catches up one photo per cycle.
 *
 * @param {object} challenge - challenge with member.ranking.entries
 * @param {string} token
 * @param {number} now - unix seconds
 * @param {{
 *   settings: object,
 *   logger: object,
 *   getEligiblePhotos: function,
 *   submitToChallenge: function,
 *   getActiveChallenges?: function,
 * }} deps - getActiveChallenges enables the pre-submit live re-check; when
 *   absent the fill proceeds on pass-start data (legacy behavior).
 * @returns {Promise<'submitted'|'skipped'|'disabled'|'no-schedule'|'no-eligible-photos'|'error'>}
 */
const maybeAutoFillChallenge = async (challenge, token, now, deps) => {
    const { settings, logger } = deps;
    const challengeId = challenge?.id;
    if (challengeId === undefined || challengeId === null) return 'skipped';

    const enabled = settings.getEffectiveSetting('autoFill', String(challengeId));
    if (enabled !== true) return 'disabled';

    const closeTime = Number(challenge.close_time);
    if (!Number.isFinite(closeTime)) return 'skipped';
    const secondsRemaining = closeTime - now;
    if (secondsRemaining <= 0) return 'skipped';

    let slotsRemaining = getSlotsRemaining(challenge);
    if (slotsRemaining <= 0) return 'skipped';

    const schedule = settings.getEffectiveSetting('autoFillSchedule', String(challengeId));
    // Distinct from 'disabled' (toggle off): the toggle is on but there is no
    // schedule to act on — a deliberate opt-out state the GUI editor warns about.
    if (!Array.isArray(schedule) || schedule.length === 0) return 'no-schedule';

    const desired = resolveScheduleTarget(schedule, secondsRemaining, challenge.max_photo_submits);
    if (getEntries(challenge).length >= desired) {
        // Schedule satisfied but free slots remain and no further row will ever
        // raise the target — the schedule tops out below what the challenge
        // allows. WARNING (not debug/info, which are compiled out of packaged
        // builds — see makeFallbackLogger) so a real user has a trace for why
        // those slots stay empty until emergency fill.
        // Finite: the slotsRemaining > 0 guard above is false for a non-finite max.
        const max = challenge.max_photo_submits;
        // Highest target the schedule can ever demand = the target as time
        // runs out (secondsRemaining → 0 matches every row), so reuse
        // resolveScheduleTarget instead of re-deriving the clamp-and-max here.
        const maxTarget = resolveScheduleTarget(schedule, 0, max);
        if (desired > 0 && desired === maxTarget && maxTarget < max) {
            logger
                .withCategory('autoFill')
                .warning(
                    `autoFill: schedule tops out at ${maxTarget} entries but ${logger.challengeTag(challenge)} allows ${max} — remaining slots are left to emergency fill`,
                    null,
                );
        }
        return 'skipped';
    }

    const mustIncludeTags = settings.getEffectiveTagSetting('mustIncludeTags', challenge);
    const shouldIncludeTags = settings.getEffectiveTagSetting('shouldIncludeTags', challenge);
    const fillWithoutTagMatch = settings.getEffectiveSetting('fillWithoutTagMatch', String(challengeId));

    const attempt = await runFillAttempt({
        label: 'autoFill',
        challenge,
        token,
        deps,
        wantCount: 1,
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
        onRefreshed: () => {
            slotsRemaining = getSlotsRemaining(challenge);
            const entryCount = getEntries(challenge).length;
            if (slotsRemaining <= 0 || entryCount >= desired) {
                logger
                    .withCategory('autoFill')
                    .info(
                        `autoFill: live re-check shows ${logger.challengeTag(challenge)} already has ${entryCount} entries (target ${desired}) — an entry was added outside this run (e.g. a manual submission); standing down`,
                        null,
                    );
                return { standDown: true };
            }
            return null;
        },
    });
    if (attempt.status === 'no-pick') return 'no-eligible-photos';
    if (attempt.status === 'gone' || attempt.status === 'refresh-stand-down') return 'skipped';
    if (attempt.status !== 'submitted') return 'error';

    // Reflect the consumed slot locally so a due turbo/boost later this
    // cycle (timer order) sees the new entry and correct slot count.
    reflectNewEntry(challenge, attempt.picked[0]);
    // When the schedule was end-aligned (challenge allows fewer images
    // than the schedule's span), say which row's time governed this fill
    // — the resolved mapping, not a bare shift count. Success-level on
    // purpose: `debug` is compiled out of packaged builds (it is gated on
    // isSourceCode() in logger.js; `info`, `success` and `warning` are NOT),
    // and the remapped timing is exactly what a user checking "why did it fill
    // now?" needs to see. Attribute the TARGET's row (`desired + shift`
    // maps back to the original image number that set the current
    // target), not the entry number: during catch-up the entry being
    // submitted may sit on an off row and was never scheduled itself.
    // Safe to interpolate into the log line: the slotsRemaining > 0 guard at
    // the top already proved max_photo_submits is a finite number (a malformed
    // value — e.g. a string with newlines — returns 'skipped' there).
    const maxSubmits = challenge.max_photo_submits;
    const shift = getScheduleShift(getValidScheduleRows(schedule), maxSubmits);
    const shiftNote =
        shift > 0
            ? `; ${maxSubmits}-image challenge — the target of ${desired} entries follows the Image ${desired + shift} time`
            : '';
    // `slotsRemaining` is the pre-reflect snapshot (updated by onRefreshed when
    // the live re-check merged fresh state), so `- 1` is the post-submit count
    // — keep this log after the reflect, not before.
    logger
        .withCategory('autoFill')
        .success(
            `autoFill: submitted 1 entry for ${logger.challengeTag(challenge)} (${slotsRemaining - 1} slots remain${shiftNote})`,
            null,
        );
    return 'submitted';
};

module.exports = {
    maybeAutoFillChallenge,
};
