/**
 * GuruShots Auto Voter - Auto-Fill Service
 *
 * Decides when and how to submit photos into challenges that have
 * empty entry slots near their close time.
 *
 * Two entry points:
 *   - maybeAutoFillChallenge: cycle-driven, staggered. Fills at most one
 *     slot per call; the trigger condition `secondsRemaining <=
 *     slotsRemaining * intervalSec` ensures fills are spaced (e.g. with
 *     a 10-minute interval and 2 missing slots, fills land at T-20m and
 *     T-10m). Spacing matters because GuruShots' ranking algorithm
 *     dilutes votes per entry when several are submitted simultaneously.
 *   - fillChallengeNow: manual, batched. The GUI buttons call this and
 *     it ignores both the autoFill toggle and the spacing math; manual
 *     means explicit user intent.
 *
 * API methods are injected so the scheduler (real API) and the IPC
 * handler (apiFactory strategy, may be mocked) can call the same logic
 * without entangling the modules.
 */

const { pickPhotosForChallenge } = require('./photoPicker');

const getEntries = (challenge) => {
    const entries = challenge?.member?.ranking?.entries;
    return Array.isArray(entries) ? entries : [];
};

const getSlotsRemaining = (challenge) => {
    const max = Number.isFinite(challenge?.max_photo_submits) ? challenge.max_photo_submits : 0;
    return Math.max(0, max - getEntries(challenge).length);
};

/**
 * Cycle-driven, staggered auto-fill. Submits at most one photo per
 * call; the next call (next scheduler cycle) will see the updated
 * entries.length and either skip (still too early) or submit again.
 *
 * @param {object} challenge - challenge with member.ranking.entries
 * @param {string} token
 * @param {number} now - unix seconds
 * @param {{
 *   settings: object,
 *   logger: object,
 *   getEligiblePhotos: function,
 *   submitToChallenge: function,
 * }} deps
 * @returns {Promise<'submitted'|'skipped'|'disabled'|'no-eligible-photos'|'error'>}
 */
const maybeAutoFillChallenge = async (challenge, token, now, deps) => {
    const { settings, logger, getEligiblePhotos, submitToChallenge } = deps;
    const challengeId = challenge?.id;
    if (challengeId === undefined || challengeId === null) return 'skipped';

    const enabled = settings.getEffectiveSetting('autoFill', String(challengeId));
    if (enabled !== true) return 'disabled';

    const closeTime = Number(challenge.close_time);
    if (!Number.isFinite(closeTime)) return 'skipped';
    const secondsRemaining = closeTime - now;
    if (secondsRemaining <= 0) return 'skipped';

    const slotsRemaining = getSlotsRemaining(challenge);
    if (slotsRemaining <= 0) return 'skipped';

    const intervalMinutes = settings.getEffectiveSetting('autoFillIntervalMinutes', String(challengeId));
    const intervalSec = (Number.isFinite(intervalMinutes) ? intervalMinutes : 10) * 60;
    if (secondsRemaining > slotsRemaining * intervalSec) {
        return 'skipped';
    }

    const mustIncludeTags = settings.getEffectiveSetting('mustIncludeTags', String(challengeId));
    const shouldIncludeTags = settings.getEffectiveSetting('shouldIncludeTags', String(challengeId));
    const fillWithoutTagMatch = settings.getEffectiveSetting('fillWithoutTagMatch', String(challengeId));

    let eligible;
    try {
        eligible = await getEligiblePhotos(challengeId, token);
    } catch (error) {
        logger
            .withCategory('autoFill')
            .warning(
                `autoFill: failed to fetch eligible photos for ${logger.challengeTag(challenge)}: ${error.message || error}`,
                null,
            );
        return 'error';
    }

    const picked = pickPhotosForChallenge(challenge, eligible, 1, {
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
    });
    if (picked.length === 0) {
        logger
            .withCategory('autoFill')
            .info(`autoFill: no eligible photos for ${logger.challengeTag(challenge)}`, null);
        return 'no-eligible-photos';
    }

    try {
        const result = await submitToChallenge(challengeId, picked, token);
        if (result && result.ok) {
            logger
                .withCategory('autoFill')
                .success(
                    `autoFill: submitted 1 entry for ${logger.challengeTag(challenge)} (${slotsRemaining - 1} slots remain)`,
                    null,
                );
            return 'submitted';
        }
        logger
            .withCategory('autoFill')
            .warning(`autoFill: submit returned ok=false for ${logger.challengeTag(challenge)}`, null);
        return 'error';
    } catch (error) {
        logger
            .withCategory('autoFill')
            .warning(`autoFill: submit threw for ${logger.challengeTag(challenge)}: ${error.message || error}`, null);
        return 'error';
    }
};

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
 *   passes it); it is optional only so legacy failure-path unit tests can
 *   omit it, in which case tag rules degrade to "no filter".
 * @returns {Promise<{success: boolean, submitted: number, skipped: number, error?: string}>}
 */
const fillChallengeNow = async (challenge, token, mode, deps) => {
    const { settings, logger, getEligiblePhotos, submitToChallenge } = deps;
    const challengeId = challenge?.id;
    if (challengeId === undefined || challengeId === null) {
        return { success: false, submitted: 0, skipped: 0, error: 'Invalid challenge' };
    }

    const slotsRemaining = getSlotsRemaining(challenge);
    if (slotsRemaining <= 0) {
        return { success: true, submitted: 0, skipped: 0 };
    }

    // settings is optional for fillChallengeNow — unit tests for legacy
    // failure paths invoke without it. The production IPC handler always
    // passes settings, so this branch firing in real runs would mean a
    // caller forgot to wire deps; emit a debug line so it's observable.
    let mustIncludeTags = null;
    let shouldIncludeTags = null;
    let fillWithoutTagMatch; // undefined → picker treats as default (true)
    if (settings) {
        mustIncludeTags = settings.getEffectiveSetting('mustIncludeTags', String(challengeId));
        shouldIncludeTags = settings.getEffectiveSetting('shouldIncludeTags', String(challengeId));
        fillWithoutTagMatch = settings.getEffectiveSetting('fillWithoutTagMatch', String(challengeId));
    } else {
        logger
            .withCategory('autoFill')
            .debug(
                `manualFill: settings module not provided to fillChallengeNow for ${logger.challengeTag(challenge)}; tag rules will not apply`,
                null,
            );
    }

    let eligible;
    try {
        eligible = await getEligiblePhotos(challengeId, token);
    } catch (error) {
        logger
            .withCategory('autoFill')
            .warning(
                `manualFill: failed to fetch eligible photos for ${logger.challengeTag(challenge)}: ${error.message || error}`,
                null,
            );
        return {
            success: false,
            submitted: 0,
            skipped: slotsRemaining,
            error: error.message || 'Failed to fetch photos',
        };
    }

    const wantCount = mode === 'all' ? slotsRemaining : 1;
    const picked = pickPhotosForChallenge(challenge, eligible, wantCount, {
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
    });
    if (picked.length === 0) {
        // When the "must include" filter is active and there were photos to
        // consider, it's the most likely reason nothing was picked — say so,
        // otherwise the user sees a generic message and can't tell their own
        // tag filter is the cause.
        const mustActive = Array.isArray(mustIncludeTags) && mustIncludeTags.length > 0;
        const hadCandidates = Array.isArray(eligible) && eligible.length > 0;
        const error =
            mustActive && hadCandidates ? 'No photos matched the Must Include Tags filter' : 'No eligible photos found';
        logger
            .withCategory('autoFill')
            .info(`manualFill: ${error.toLowerCase()} for ${logger.challengeTag(challenge)}`, null);
        return { success: false, submitted: 0, skipped: slotsRemaining, error };
    }

    try {
        const result = await submitToChallenge(challengeId, picked, token);
        if (result && result.ok) {
            logger
                .withCategory('autoFill')
                .success(`manualFill: submitted ${picked.length} entries for ${logger.challengeTag(challenge)}`, null);
            return {
                success: true,
                submitted: picked.length,
                skipped: Math.max(0, slotsRemaining - picked.length),
            };
        }
        logger
            .withCategory('autoFill')
            .warning(`manualFill: submit returned ok=false for ${logger.challengeTag(challenge)}`, null);
        return {
            success: false,
            submitted: 0,
            skipped: slotsRemaining,
            error: 'Submit failed',
        };
    } catch (error) {
        logger
            .withCategory('autoFill')
            .warning(`manualFill: submit threw for ${logger.challengeTag(challenge)}: ${error.message || error}`, null);
        return {
            success: false,
            submitted: 0,
            skipped: slotsRemaining,
            error: error.message || 'Submit failed',
        };
    }
};

module.exports = {
    maybeAutoFillChallenge,
    fillChallengeNow,
    // exported for tests
    getSlotsRemaining,
};
