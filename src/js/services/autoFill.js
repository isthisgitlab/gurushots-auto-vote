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
 * Reflect a freshly submitted entry on the local challenge object so the rest of
 * this cycle sees the slot it consumed. Used by both the "fill-new" boost/turbo
 * path and the staggered/emergency auto-fill paths (which submit before a due
 * turbo/boost runs in timer order). The challenge isn't re-fetched mid-cycle, so
 * without this getSlotsRemaining would still count the just-used slot as free and
 * could over-submit, and a due turbo/boost couldn't act on the new entry. The
 * minimal shape carries the conflict flags that boost/turbo entry selection reads
 * (boosted/turbo).
 */
const reflectNewEntry = (challenge, imageId) => {
    const ranking = challenge?.member?.ranking;
    if (!ranking || !imageId) return;
    if (!Array.isArray(ranking.entries)) ranking.entries = [];
    // Coerce the server-supplied id to a string before it joins shared
    // challenge state (mirrors how _postBoost stringifies the image_id).
    ranking.entries.push({ id: String(imageId), turbo: false, boosted: false, boost: -1, boosting: false });
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
            // Reflect the consumed slot locally so a due turbo/boost later this
            // cycle (timer order) sees the new entry and correct slot count.
            reflectNewEntry(challenge, picked[0]);
            // `slotsRemaining` is the pre-reflect snapshot from above, so `- 1` is
            // the post-submit count — keep this log after the reflect, not before.
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
 * Emergency fill — a safety net for the two cases the staggered
 * auto-fill path deliberately leaves empty right up to the deadline:
 *   (a) auto-fill is off for the challenge, or
 *   (b) a Must Include Tags filter is set, nothing matches it, and
 *       fillWithoutTagMatch is off (so the slot would stay empty).
 *
 * When the challenge is within `emergencyFill` seconds of closing and in
 * one of those states, fill every remaining slot in a single submission,
 * relaxing the must-include hard filter (the whole point is "don't leave
 * slots empty at the buzzer"). There's no time to stagger this close to
 * the end, so unlike maybeAutoFillChallenge it batches all slots at once,
 * like the manual "fill all" button. Self-guarding: if auto-fill would
 * already handle the challenge, it returns 'skipped' so it never
 * double-fills.
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
const maybeEmergencyFillChallenge = async (challenge, token, now, deps) => {
    const { settings, logger, getEligiblePhotos, submitToChallenge } = deps;
    const challengeId = challenge?.id;
    if (challengeId === undefined || challengeId === null) return 'skipped';

    const emergencySeconds = settings.getEffectiveSetting('emergencyFill', String(challengeId));
    if (!Number.isFinite(emergencySeconds) || emergencySeconds <= 0) return 'disabled';

    const closeTime = Number(challenge.close_time);
    if (!Number.isFinite(closeTime)) return 'skipped';
    const secondsRemaining = closeTime - now;
    if (secondsRemaining <= 0) return 'skipped';
    if (secondsRemaining > emergencySeconds) return 'skipped'; // not in the emergency window yet

    const slotsRemaining = getSlotsRemaining(challenge);
    if (slotsRemaining <= 0) return 'skipped';

    const autoFillEnabled = settings.getEffectiveSetting('autoFill', String(challengeId)) === true;
    const mustIncludeTags = settings.getEffectiveSetting('mustIncludeTags', String(challengeId));
    const shouldIncludeTags = settings.getEffectiveSetting('shouldIncludeTags', String(challengeId));
    const fillWithoutTagMatch = settings.getEffectiveSetting('fillWithoutTagMatch', String(challengeId));

    // Stand down before any network call when normal auto-fill already owns
    // this challenge: auto-fill on with no must-include filter means the
    // staggered path fills the slots, so emergency fill has nothing to add.
    // This is the common configuration, so the early return avoids fetching
    // eligible photos every cycle just to discard them.
    const mustActive = Array.isArray(mustIncludeTags) && mustIncludeTags.length > 0;
    if (autoFillEnabled && !mustActive) return 'skipped';

    let eligible;
    try {
        eligible = await getEligiblePhotos(challengeId, token);
    } catch (error) {
        logger
            .withCategory('autoFill')
            .warning(
                `emergencyFill: failed to fetch eligible photos for ${logger.challengeTag(challenge)}: ${error.message || error}`,
                null,
            );
        return 'error';
    }

    // With auto-fill on and a must-include filter set, only step in if that
    // filter would leave the slot empty (a non-empty result means the normal
    // staggered path can still fill it, so stand down). With auto-fill off,
    // always step in — nothing else will fill the slot.
    if (autoFillEnabled) {
        const wouldPick = pickPhotosForChallenge(challenge, eligible, 1, {
            mustIncludeTags,
            shouldIncludeTags,
            fillWithoutTagMatch,
        });
        if (wouldPick.length > 0) return 'skipped';
    }

    // Fill every remaining slot. Keep the user's tag preferences (must
    // photos still win when they exist) but force fillWithoutTagMatch on so
    // a missing match never leaves a slot empty at the deadline — that
    // override is the whole point of emergency fill.
    const picked = pickPhotosForChallenge(challenge, eligible, slotsRemaining, {
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch: true,
    });
    if (picked.length === 0) {
        logger
            .withCategory('autoFill')
            .info(`emergencyFill: no eligible photos for ${logger.challengeTag(challenge)}`, null);
        return 'no-eligible-photos';
    }

    try {
        const result = await submitToChallenge(challengeId, picked, token);
        if (result && result.ok) {
            // Reflect every consumed slot locally so a due turbo/boost later this
            // cycle (timer order) sees the new entries and correct slot count.
            for (const id of picked) reflectNewEntry(challenge, id);
            logger
                .withCategory('autoFill')
                .success(
                    `emergencyFill: submitted ${picked.length} entr${picked.length === 1 ? 'y' : 'ies'} for ${logger.challengeTag(challenge)} near deadline`,
                    null,
                );
            return 'submitted';
        }
        logger
            .withCategory('autoFill')
            .warning(`emergencyFill: submit returned ok=false for ${logger.challengeTag(challenge)}`, null);
        return 'error';
    } catch (error) {
        logger
            .withCategory('autoFill')
            .warning(
                `emergencyFill: submit threw for ${logger.challengeTag(challenge)}: ${error.message || error}`,
                null,
            );
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

/**
 * Submit exactly one new photo into a challenge and return its id, so the
 * caller can immediately boost/turbo that fresh entry (the "fill new"
 * boost/turbo options). Unlike maybeAutoFillChallenge/fillChallengeNow this
 * returns the submitted photo id rather than a count — boost/turbo need the
 * id to act on. Photo selection reuses the same tag rules and picker as
 * auto-fill so "fill new" honors the user's Must/Should Include Tags config.
 *
 * Never submits when the challenge is already full (getSlotsRemaining guard),
 * so callers can safely fall back to acting on an existing entry.
 *
 * @param {object} challenge - challenge with member.ranking.entries
 * @param {string} token
 * @param {{
 *   settings: object,
 *   logger: object,
 *   getEligiblePhotos: function,
 *   submitToChallenge: function,
 * }} deps
 * @returns {Promise<{ok: boolean, imageId: string|null, reason: string}>}
 *   reason ∈ 'submitted'|'no-slots'|'no-eligible'|'fetch-error'|'submit-failed'|'invalid-challenge'
 */
const submitNewEntryForAction = async (challenge, token, deps) => {
    const { settings, logger, getEligiblePhotos, submitToChallenge } = deps;
    const challengeId = challenge?.id;
    if (challengeId === undefined || challengeId === null) {
        return { ok: false, imageId: null, reason: 'invalid-challenge' };
    }

    // Slots-full is guarded here so callers never submit beyond the limit;
    // they fall back to acting on an existing entry instead.
    if (getSlotsRemaining(challenge) <= 0) {
        return { ok: false, imageId: null, reason: 'no-slots' };
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
                `fillNew: failed to fetch eligible photos for ${logger.challengeTag(challenge)}: ${error.message || error}`,
                null,
            );
        return { ok: false, imageId: null, reason: 'fetch-error' };
    }

    const picked = pickPhotosForChallenge(challenge, eligible, 1, {
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
    });
    if (picked.length === 0) {
        logger.withCategory('autoFill').info(`fillNew: no eligible photos for ${logger.challengeTag(challenge)}`, null);
        return { ok: false, imageId: null, reason: 'no-eligible' };
    }

    const imageId = picked[0];
    if (!imageId) {
        // Defensive: pickPhotosForChallenge only returns truthy ids, but guard
        // so an empty value never propagates to the boost/turbo image_id —
        // applyBoostToEntry has no own null-guard (unlike applyTurbo).
        logger
            .withCategory('autoFill')
            .info(`fillNew: picked an empty photo id for ${logger.challengeTag(challenge)}`, null);
        return { ok: false, imageId: null, reason: 'no-eligible' };
    }
    try {
        const result = await submitToChallenge(challengeId, [imageId], token);
        if (result && result.ok) {
            logger
                .withCategory('autoFill')
                .success(`fillNew: submitted entry ${imageId} for ${logger.challengeTag(challenge)}`, null);
            return { ok: true, imageId, reason: 'submitted' };
        }
        logger
            .withCategory('autoFill')
            .warning(`fillNew: submit returned ok=false for ${logger.challengeTag(challenge)}`, null);
        return { ok: false, imageId: null, reason: 'submit-failed' };
    } catch (error) {
        logger
            .withCategory('autoFill')
            .warning(`fillNew: submit threw for ${logger.challengeTag(challenge)}: ${error.message || error}`, null);
        return { ok: false, imageId: null, reason: 'submit-failed' };
    }
};

module.exports = {
    maybeAutoFillChallenge,
    maybeEmergencyFillChallenge,
    fillChallengeNow,
    submitNewEntryForAction,
    reflectNewEntry,
    // exported for tests
    getSlotsRemaining,
};
