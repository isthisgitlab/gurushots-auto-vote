/**
 * Auto-fill — the boost/turbo "fill new" submit: one new photo whose id the
 * caller then acts on.
 */

const { getSlotsRemaining } = require('./challengeState');
const { runFillAttempt } = require('./pipeline');

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
 *   getActiveChallenges?: function,
 * }} deps - getActiveChallenges enables the pre-submit live re-check; when
 *   absent the fill proceeds on pass-start data.
 * @returns {Promise<{ok: boolean, imageId: string|null, reason: string}>}
 *   reason ∈ 'submitted'|'no-slots'|'challenge-gone'|'no-eligible'|'fetch-error'|'submit-failed'|'invalid-challenge'
 */
const submitNewEntryForAction = async (challenge, token, deps) => {
    const { settings, logger } = deps;
    const challengeId = challenge?.id;
    if (challengeId === undefined || challengeId === null) {
        return { ok: false, imageId: null, reason: 'invalid-challenge' };
    }

    // Slots-full is guarded here so callers never submit beyond the limit;
    // they fall back to acting on an existing entry instead.
    if (getSlotsRemaining(challenge) <= 0) {
        return { ok: false, imageId: null, reason: 'no-slots' };
    }

    const mustIncludeTags = settings.getEffectiveTagSetting('mustIncludeTags', challenge);
    const shouldIncludeTags = settings.getEffectiveTagSetting('shouldIncludeTags', challenge);
    const fillWithoutTagMatch = settings.getEffectiveSetting('fillWithoutTagMatch', String(challengeId));

    const attempt = await runFillAttempt({
        label: 'fillNew',
        challenge,
        token,
        deps,
        wantCount: 1,
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
        // Live re-check just before consuming a slot: an entry added outside
        // this run (e.g. a manual submission) may have filled the challenge
        // since the pass-start snapshot; callers fall back to acting on an
        // existing entry.
        onRefreshed: () => {
            if (getSlotsRemaining(challenge) <= 0) {
                logger
                    .withCategory('autoFill')
                    .info(
                        `fillNew: live re-check shows ${logger.challengeTag(challenge)} has no free slots — an entry was added outside this run (e.g. a manual submission); not submitting a new photo`,
                        null,
                    );
                return { standDown: true };
            }
            return null;
        },
    });
    if (attempt.status === 'fetch-error') return { ok: false, imageId: null, reason: 'fetch-error' };
    if (attempt.status === 'no-pick') {
        return { ok: false, imageId: null, reason: 'no-eligible' };
    }
    if (attempt.status === 'gone') return { ok: false, imageId: null, reason: 'challenge-gone' };
    if (attempt.status === 'refresh-stand-down') return { ok: false, imageId: null, reason: 'no-slots' };
    if (attempt.status !== 'submitted') return { ok: false, imageId: null, reason: 'submit-failed' };

    // No reflectNewEntry here — on purpose. The orchestrator callers reflect
    // the returned id themselves (autoFill.reflectNewEntry(challenge,
    // filled.imageId) after a successful return); reflecting here too would
    // duplicate the entry. See runFillAttempt's header.
    //
    // Always a truthy id: buildScoredCandidates drops every photo without one
    // before scoring, so finalizePick can only return real ids — which matters
    // because applyBoostToEntry has no null-guard of its own.
    const imageId = attempt.picked[0];
    logger
        .withCategory('autoFill')
        .success(`fillNew: submitted entry ${imageId} for ${logger.challengeTag(challenge)}`, null);
    return { ok: true, imageId, reason: 'submitted' };
};

module.exports = {
    submitNewEntryForAction,
};
