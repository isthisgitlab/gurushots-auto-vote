/**
 * Auto-fill — the near-deadline safety net that fills every remaining slot in
 * one batch, and the state-only stand-down check it shares with the deadline view.
 */

const { pickPhotosForChallenge } = require('../photoPicker');
const { getSlotsRemaining, reflectNewEntry } = require('./challengeState');
const { runFillAttempt } = require('./pipeline');

/**
 * Whether emergency fill stands down on LIVE STATE alone, independent of timing.
 * Owned here, beside the runner that enforces it, and exported so the read-only
 * renderer view (VotingLogic.describeDeadlineActions, which drives the deadline
 * timeline and the desktop notifications) decides row visibility from the very
 * same code instead of a second copy that can silently drift.
 *
 * Covers the three state-only stand-downs maybeEmergencyFillChallenge takes
 * before any network call:
 *   - no challenge id (`undefined`/`null`, exactly the runner's own guard — an
 *     empty-string id is NOT one of them, so callers that normalise a missing id
 *     to '' must pass the raw id instead),
 *   - no free slot left to fill, and
 *   - "normal auto-fill already owns this challenge": auto-fill on with no
 *     must-include filter, the common configuration, in which the staggered
 *     path fills the slots and emergency fill has nothing to add.
 *
 * Deliberately NOT covered — the caller owns these:
 *   - the timing/enabled checks (`emergencyFill` seconds, close_time, whether
 *     `now` is inside the window), because the view expresses them as a
 *     threshold and a due instant rather than a boolean, and
 *   - the runner's final stand-down, a dry-run probe of whether the
 *     must-include filter would actually leave the slot empty. That needs the
 *     eligible-photo list over the network, so a read-only caller must treat
 *     "filter set" as "may fill" rather than "will fill".
 *
 * Returns the two settings it resolved alongside the verdict so the runner can
 * reuse them: every `getEffectiveSetting` is an uncached `readFileSync` +
 * merge + migrate (settings/storage.js readRaw), so re-reading them would add
 * real synchronous I/O to a path that runs seconds before a deadline. Nothing is
 * read until after the id and free-slot checks, keeping the stand-down paths
 * cheaper than a caller that resolved them up front. `settings` is a parameter
 * because this module takes the facade via `deps` while VotingLogic requires it
 * directly.
 *
 * @param {object} challenge
 * @param {string|number|null|undefined} challengeId raw id; do not normalise it
 * @param {{getEffectiveSetting: function, getEffectiveTagSetting: function}} settings
 * @returns {{standDown: boolean, autoFillEnabled: boolean, mustIncludeTags: unknown}}
 *   standDown true = would do nothing, so never advertise it as upcoming
 */
const evaluateEmergencyFill = (challenge, challengeId, settings) => {
    const inert = { standDown: true, autoFillEnabled: false, mustIncludeTags: null };
    if (challengeId === undefined || challengeId === null) return inert;
    if (getSlotsRemaining(challenge) <= 0) return inert;

    const mustIncludeTags = settings.getEffectiveTagSetting('mustIncludeTags', challenge);
    const autoFillEnabled = settings.getEffectiveSetting('autoFill', String(challengeId)) === true;
    const mustActive = Array.isArray(mustIncludeTags) && mustIncludeTags.length > 0;
    return { standDown: autoFillEnabled && !mustActive, autoFillEnabled, mustIncludeTags };
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
 *   getActiveChallenges?: function,
 * }} deps - getActiveChallenges enables the pre-submit live re-check; when
 *   absent the fill proceeds on pass-start data (legacy behavior).
 * @returns {Promise<'submitted'|'skipped'|'disabled'|'no-eligible-photos'|'error'>}
 */
const maybeEmergencyFillChallenge = async (challenge, token, now, deps) => {
    const { settings, logger } = deps;
    const challengeId = challenge?.id;
    if (challengeId === undefined || challengeId === null) return 'skipped';

    const emergencySeconds = settings.getEffectiveSetting('emergencyFill', String(challengeId));
    if (!Number.isFinite(emergencySeconds) || emergencySeconds <= 0) return 'disabled';

    const closeTime = Number(challenge.close_time);
    if (!Number.isFinite(closeTime)) return 'skipped';
    const secondsRemaining = closeTime - now;
    if (secondsRemaining <= 0) return 'skipped';
    if (secondsRemaining > emergencySeconds) return 'skipped'; // not in the emergency window yet

    // Stand down before any network call on the state-only conditions: no free
    // slot, and normal auto-fill already owning this challenge (auto-fill on
    // with no must-include filter — the common configuration, where the early
    // return avoids fetching eligible photos every cycle just to discard them).
    // Shared with the read-only timeline view so the two cannot drift; it hands
    // back the settings it resolved so nothing below re-reads them.
    const gate = evaluateEmergencyFill(challenge, challengeId, settings);
    if (gate.standDown) return 'skipped';
    const { autoFillEnabled, mustIncludeTags } = gate;

    let slotsRemaining = getSlotsRemaining(challenge);
    const shouldIncludeTags = settings.getEffectiveTagSetting('shouldIncludeTags', challenge);
    const fillWithoutTagMatch = settings.getEffectiveSetting('fillWithoutTagMatch', String(challengeId));

    const attempt = await runFillAttempt({
        label: 'emergencyFill',
        challenge,
        token,
        deps,
        // Fill every remaining slot. Keep the user's tag preferences (must
        // photos still win when they exist) but force fillWithoutTagMatch on so
        // a missing match never leaves a slot empty at the deadline — that
        // override is the whole point of emergency fill.
        wantCount: slotsRemaining,
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch: true,
        // With auto-fill on and a must-include filter set, only step in if that
        // filter would leave the slot empty (a non-empty result means the normal
        // staggered path can still fill it, so stand down). With auto-fill off,
        // always step in — nothing else will fill the slot. Dry-run probe: no
        // onFallback, and the user's real fillWithoutTagMatch setting applies.
        probeStandDown: autoFillEnabled
            ? ({ eligible, semanticScores }) =>
                  pickPhotosForChallenge(challenge, eligible, 1, {
                      mustIncludeTags,
                      shouldIncludeTags,
                      fillWithoutTagMatch,
                      semanticScores,
                  }).length > 0
            : null,
        // Live re-check just before the batch submit: an entry added outside
        // this run (e.g. a manual submission) shrinks the free-slot count, and
        // the batch must never over-fill past it.
        onRefreshed: (picked) => {
            slotsRemaining = getSlotsRemaining(challenge);
            if (slotsRemaining <= 0) {
                logger
                    .withCategory('autoFill')
                    .info(
                        `emergencyFill: live re-check shows ${logger.challengeTag(challenge)} has no free slots — an entry was added outside this run (e.g. a manual submission); standing down`,
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
    if (attempt.status === 'probe-stand-down' || attempt.status === 'gone' || attempt.status === 'refresh-stand-down') {
        return 'skipped';
    }
    if (attempt.status !== 'submitted') return 'error';

    // Reflect every consumed slot locally so a due turbo/boost later this
    // cycle (timer order) sees the new entries and correct slot count.
    for (const id of attempt.picked) reflectNewEntry(challenge, id);
    logger
        .withCategory('autoFill')
        .success(
            `emergencyFill: submitted ${attempt.picked.length} entr${attempt.picked.length === 1 ? 'y' : 'ies'} for ${logger.challengeTag(challenge)} near deadline`,
            null,
        );
    return 'submitted';
};

module.exports = {
    evaluateEmergencyFill,
    maybeEmergencyFillChallenge,
};
