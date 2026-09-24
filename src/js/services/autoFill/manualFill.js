/**
 * Auto-fill — the manual "Fill Now" path: one or all missing slots in a single
 * request, ignoring the autoFill toggle and the schedule.
 */

const { resetPassState: resetPhotoStatsPassState } = require('../photoStats');
const { getSlotsRemaining } = require('./challengeState');
const { runFillAttempt } = require('./pipeline');

/**
 * Manual fill (GUI button). Submits one or all missing slots in a
 * single request. Ignores the autoFill toggle and the spacing math,
 * but still honors mustIncludeTags / shouldIncludeTags so the tag
 * rules mean the same thing whether triggered by the user or the
 * scheduler.
 *
 * @param {object} challenge
 * @param {string} token
 * @param {'one'|'all'} mode
 * @param {{
 *   settings?: object,
 *   logger: object,
 *   getEligiblePhotos: function,
 *   submitToChallenge: function,
 * }} deps - settings is required in production (the IPC handler always
 *   passes it); it is optional only so failure-path unit tests can omit it,
 *   in which case tag rules degrade to "no filter".
 * @returns {Promise<{success: boolean, submitted: number, skipped: number, error?: string}>}
 */
const fillChallengeNow = async (challenge, token, mode, deps) => {
    const { settings, logger } = deps;
    const challengeId = challenge?.id;
    if (challengeId === undefined || challengeId === null) {
        return { success: false, submitted: 0, skipped: 0, error: 'Invalid challenge' };
    }

    const slotsRemaining = getSlotsRemaining(challenge);
    if (slotsRemaining <= 0) {
        return { success: true, submitted: 0, skipped: 0 };
    }

    // Manual "Fill Now" is its own operation, not part of a voting pass, so it
    // gets a fresh photo-stats budget and failure breaker. Without this an
    // earlier background pass that tripped the breaker would silently deny stat
    // enrichment to every manual fill until the next pass happened to reset it.
    resetPhotoStatsPassState();

    // settings is optional for fillChallengeNow — unit tests for failure
    // paths invoke without it. The production IPC handler always
    // passes settings, so this branch firing in real runs would mean a
    // caller forgot to wire deps; emit a debug line so it's observable.
    let mustIncludeTags = null;
    let shouldIncludeTags = null;
    let fillWithoutTagMatch; // undefined → picker treats as default (true)
    if (settings) {
        mustIncludeTags = settings.getEffectiveTagSetting('mustIncludeTags', challenge);
        shouldIncludeTags = settings.getEffectiveTagSetting('shouldIncludeTags', challenge);
        fillWithoutTagMatch = settings.getEffectiveSetting('fillWithoutTagMatch', String(challengeId));
    } else {
        logger
            .withCategory('autoFill')
            .debug(
                `manualFill: settings module not provided to fillChallengeNow for ${logger.challengeTag(challenge)}; tag rules will not apply`,
                null,
            );
    }

    const attempt = await runFillAttempt({
        label: 'manualFill',
        challenge,
        token,
        deps,
        wantCount: mode === 'all' ? slotsRemaining : 1,
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
        // No onRefreshed hook: manual fill is explicit user intent acting on
        // the state the user is looking at — it never ran the pre-submit live
        // re-check, and keeps not running it.
        onEmptyPick: (eligible) => {
            // When the "must include" filter is active and there were photos to
            // consider, it's the most likely reason nothing was picked — say so,
            // otherwise the user sees a generic message and can't tell their own
            // tag filter is the cause.
            const mustActive = Array.isArray(mustIncludeTags) && mustIncludeTags.length > 0;
            const hadCandidates = Array.isArray(eligible) && eligible.length > 0;
            const error =
                mustActive && hadCandidates
                    ? 'No photos matched the Must Include Tags filter'
                    : 'No eligible photos found';
            logger
                .withCategory('autoFill')
                .info(`manualFill: ${error.toLowerCase()} for ${logger.challengeTag(challenge)}`, null);
            return error;
        },
    });
    if (attempt.status === 'fetch-error') {
        return {
            success: false,
            submitted: 0,
            skipped: slotsRemaining,
            error: attempt.error.message || 'Failed to fetch photos',
        };
    }
    if (attempt.status === 'no-pick') {
        return { success: false, submitted: 0, skipped: slotsRemaining, error: attempt.detail };
    }
    if (attempt.status === 'submit-rejected') {
        return {
            success: false,
            submitted: 0,
            skipped: slotsRemaining,
            error: `Submit rejected: ${attempt.reason}`,
        };
    }
    if (attempt.status !== 'submitted') {
        // Only 'submit-threw' can reach here — manual fill wires no probe,
        // pick-guard, or refresh hook, so those statuses cannot occur.
        return {
            success: false,
            submitted: 0,
            skipped: slotsRemaining,
            error: attempt.error.message || 'Submit failed',
        };
    }

    // No reflectNewEntry here: manual fill has always left the local challenge
    // object untouched (the GUI re-fetches state after the IPC call returns).
    logger
        .withCategory('autoFill')
        .success(`manualFill: submitted ${attempt.picked.length} entries for ${logger.challengeTag(challenge)}`, null);
    return {
        success: true,
        submitted: attempt.picked.length,
        skipped: Math.max(0, slotsRemaining - attempt.picked.length),
    };
};

module.exports = {
    fillChallengeNow,
};
