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

const {pickPhotosForChallenge} = require('./photoPicker');

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
    const {settings, logger, getEligiblePhotos, submitToChallenge} = deps;
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

    let eligible;
    try {
        eligible = await getEligiblePhotos(challengeId, token);
    } catch (error) {
        logger.withCategory('autoFill').warning(
            `autoFill: failed to fetch eligible photos for challenge ${challengeId}: ${error.message || error}`,
            null,
        );
        return 'error';
    }

    const picked = pickPhotosForChallenge(challenge, eligible, 1);
    if (picked.length === 0) {
        logger.withCategory('autoFill').info(
            `autoFill: no eligible photos for challenge ${challengeId}`,
            null,
        );
        return 'no-eligible-photos';
    }

    try {
        const result = await submitToChallenge(challengeId, picked, token);
        if (result && result.ok) {
            logger.withCategory('autoFill').success(
                `autoFill: submitted 1 entry for challenge ${challengeId} (${slotsRemaining - 1} slots remain)`,
                null,
            );
            return 'submitted';
        }
        logger.withCategory('autoFill').warning(
            `autoFill: submit returned ok=false for challenge ${challengeId}`,
            null,
        );
        return 'error';
    } catch (error) {
        logger.withCategory('autoFill').warning(
            `autoFill: submit threw for challenge ${challengeId}: ${error.message || error}`,
            null,
        );
        return 'error';
    }
};

/**
 * Manual fill (GUI button). Submits one or all missing slots in a
 * single request. Ignores the autoFill toggle and the spacing math.
 *
 * @param {object} challenge
 * @param {string} token
 * @param {'one'|'all'} mode
 * @param {{
 *   logger: object,
 *   getEligiblePhotos: function,
 *   submitToChallenge: function,
 * }} deps
 * @returns {Promise<{success: boolean, submitted: number, skipped: number, error?: string}>}
 */
const fillChallengeNow = async (challenge, token, mode, deps) => {
    const {logger, getEligiblePhotos, submitToChallenge} = deps;
    const challengeId = challenge?.id;
    if (challengeId === undefined || challengeId === null) {
        return {success: false, submitted: 0, skipped: 0, error: 'Invalid challenge'};
    }

    const slotsRemaining = getSlotsRemaining(challenge);
    if (slotsRemaining <= 0) {
        return {success: true, submitted: 0, skipped: 0};
    }

    let eligible;
    try {
        eligible = await getEligiblePhotos(challengeId, token);
    } catch (error) {
        logger.withCategory('autoFill').warning(
            `manualFill: failed to fetch eligible photos for challenge ${challengeId}: ${error.message || error}`,
            null,
        );
        return {success: false, submitted: 0, skipped: slotsRemaining, error: error.message || 'Failed to fetch photos'};
    }

    const wantCount = mode === 'all' ? slotsRemaining : 1;
    const picked = pickPhotosForChallenge(challenge, eligible, wantCount);
    if (picked.length === 0) {
        logger.withCategory('autoFill').info(
            `manualFill: no eligible photos for challenge ${challengeId}`,
            null,
        );
        return {success: false, submitted: 0, skipped: slotsRemaining, error: 'No eligible photos found'};
    }

    try {
        const result = await submitToChallenge(challengeId, picked, token);
        if (result && result.ok) {
            logger.withCategory('autoFill').success(
                `manualFill: submitted ${picked.length} entries for challenge ${challengeId}`,
                null,
            );
            return {
                success: true,
                submitted: picked.length,
                skipped: Math.max(0, slotsRemaining - picked.length),
            };
        }
        logger.withCategory('autoFill').warning(
            `manualFill: submit returned ok=false for challenge ${challengeId}`,
            null,
        );
        return {
            success: false,
            submitted: 0,
            skipped: slotsRemaining,
            error: 'Submit failed',
        };
    } catch (error) {
        logger.withCategory('autoFill').warning(
            `manualFill: submit threw for challenge ${challengeId}: ${error.message || error}`,
            null,
        );
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
