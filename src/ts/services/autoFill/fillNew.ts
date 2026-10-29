/**
 * Auto-fill — the boost/turbo "fill new" submit: one new photo whose id the
 * caller then acts on. submitNewEntryForAction lets the picker choose it;
 * submitPinnedEntry (the Boost-pinned submit) names the one photo to submit —
 * the photo pinned for Boost, found among the Chosen Photos.
 */

import { getSlotsRemaining } from './challengeState';
import { chosenWalkOutcome } from './chosenPhotos';
import { runFillAttempt } from './pipeline';

import type { Challenge } from '../../types/gurushots';
import type { PickerPhoto } from '../../types/photoPicker';
import type { SettingsFillDeps } from '../../types/autoFill';
import { oneLine } from '../../format/logSafe';

/** What one action submit answers: ok, the submitted photo, and why not when it failed. */
interface ActionSubmit {
    ok: boolean;
    imageId: string | null;
    reason: string;
}

/**
 * What the shared body of the two action submits answers: the guards and the
 * statuses they read identically, already mapped to their reason, and the ones
 * they word differently (`no-pick`, a rejected or unanswered submit, a
 * submitted photo) raw, for the caller's own mapping.
 */
type ActionSubmitOutcome =
    | { kind: 'mapped'; ok: boolean; imageId: string | null; reason: string }
    | { kind: 'no-pick' }
    | { kind: 'submit-rejected' }
    | { kind: 'submit-threw' }
    | { kind: 'submitted'; imageId: string };

/**
 * The guards, the tag settings reads, the fill attempt and the outcome mapping
 * the two action submits share. `attempt` carries what differs between them:
 * the explicit id pool and the empty-pool line of the Boost-pinned submit.
 */
const runForAction = async (
    challenge: Challenge,
    token: string,
    deps: SettingsFillDeps,
    attempt: { onlyIds?: readonly string[]; onEmptyPick?: ((eligible: PickerPhoto[]) => string) | null },
): Promise<ActionSubmitOutcome> => {
    const { settings, logger } = deps;
    const challengeId = challenge?.id;
    if (challengeId === undefined || challengeId === null) {
        return { kind: 'mapped', ok: false, imageId: null, reason: 'invalid-challenge' };
    }

    // Slots-full is guarded here so callers never submit beyond the limit;
    // they fall back to acting on an existing entry instead.
    if (getSlotsRemaining(challenge) <= 0) {
        return { kind: 'mapped', ok: false, imageId: null, reason: 'no-slots' };
    }

    const mustIncludeTags = settings.getEffectiveTagSetting('mustIncludeTags', challenge);
    const shouldIncludeTags = settings.getEffectiveTagSetting('shouldIncludeTags', challenge);
    const submitWithoutTagMatch = settings.getEffectiveSetting('submitWithoutTagMatch', String(challengeId));

    const attemptResult = await runFillAttempt({
        label: 'fillNew',
        challenge,
        token,
        deps,
        wantCount: 1,
        mustIncludeTags,
        shouldIncludeTags,
        submitWithoutTagMatch,
        // Live re-check just before consuming a slot: an entry added outside
        // this run (e.g. a manual submission) may have filled the challenge
        // since the pass-start snapshot; callers fall back to acting on an
        // existing entry.
        onRefreshed: () => {
            if (getSlotsRemaining(challenge) <= 0) {
                logger
                    .withCategory('autoSubmit')
                    .info(
                        `fillNew: live re-check shows ${logger.challengeTag(challenge)} has no free slots — an entry was added outside this run (e.g. a manual submission); not submitting a new photo`,
                        null,
                    );
                return { standDown: true };
            }
            return null;
        },
        onlyIds: attempt.onlyIds,
        onEmptyPick: attempt.onEmptyPick,
    });
    if (attemptResult.status === 'fetch-error') {
        return { kind: 'mapped', ok: false, imageId: null, reason: 'fetch-error' };
    }
    // Submit Only Chosen Photos: nothing chosen can be entered, so no photo was picked on purpose.
    if (attemptResult.status === 'no-chosen') return { kind: 'mapped', ok: false, imageId: null, reason: 'no-chosen' };
    if (attemptResult.status === 'gone') return { kind: 'mapped', ok: false, imageId: null, reason: 'challenge-gone' };
    // The live re-read cannot be trusted (a prune-unsafe read dropped elements): distinct from "gone",
    // the challenge may still be active — callers read it as "no photo was entered, the data is unreadable".
    if (attemptResult.status === 'invalid') {
        return { kind: 'mapped', ok: false, imageId: null, reason: 'data-incomplete' };
    }
    if (attemptResult.status === 'refresh-stand-down') {
        return { kind: 'mapped', ok: false, imageId: null, reason: 'no-slots' };
    }
    if (attemptResult.status === 'no-pick') return { kind: 'no-pick' };
    if (attemptResult.status === 'submit-rejected') return { kind: 'submit-rejected' };
    if (attemptResult.status === 'submit-threw') return { kind: 'submit-threw' };
    // No probe is passed here — a stand-down on this path is the live re-check above — so the
    // attempt cannot end as probe-stand-down; the arm keeps the union total.
    /* istanbul ignore if */
    if (attemptResult.status === 'probe-stand-down') {
        return { kind: 'mapped', ok: false, imageId: null, reason: 'submit-failed' };
    }

    // No reflectNewEntry here — on purpose. The orchestrator callers reflect
    // the returned id themselves (autoFill.reflectNewEntry(challenge,
    // filled.imageId) after a successful return); reflecting here too would
    // duplicate the entry. See runFillAttempt's header.
    //
    // Always a truthy id: buildScoredCandidates drops every photo without one
    // before scoring, so finalizePick can only return real ids — which matters
    // because applyBoostToEntry has no null-guard of its own.
    return { kind: 'submitted', imageId: attemptResult.picked[0] };
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
 * @param challenge - challenge with member.ranking.entries
 * @param deps - getActiveChallenges enables the pre-submit live re-check; when
 *   absent the fill proceeds on pass-start data.
 *   reason ∈ 'submitted'|'no-slots'|'challenge-gone'|'data-incomplete'|'no-eligible'|'no-chosen'|'fetch-error'|'submit-failed'|'invalid-challenge'
 */
const submitNewEntryForAction = async (
    challenge: Challenge,
    token: string,
    deps: SettingsFillDeps,
): Promise<ActionSubmit> => {
    const { logger } = deps;
    const outcome = await runForAction(challenge, token, deps, {});
    if (outcome.kind === 'no-pick') return { ok: false, imageId: null, reason: 'no-eligible' };
    if (outcome.kind === 'submit-rejected' || outcome.kind === 'submit-threw') {
        return { ok: false, imageId: null, reason: 'submit-failed' };
    }
    if (outcome.kind === 'submitted') {
        logger
            .withCategory('autoSubmit')
            .success(`fillNew: submitted entry ${outcome.imageId} for ${logger.challengeTag(challenge)}`, null);
        return { ok: true, imageId: outcome.imageId, reason: 'submitted' };
    }
    return { ok: outcome.ok, imageId: outcome.imageId, reason: outcome.reason };
};

/**
 * Submit the photo pinned for Boost (the Boost-pinned submit): `imageId` is the
 * pinned photo found among the user's Chosen Photos; the pick is restricted to
 * it alone (see FillAttemptParams.onlyIds) and the Boost lands on it once the
 * caller has waited out Wait Before Boosting a New Photo.
 *
 * The reasons split definitive from transient failures so the runner can latch
 * the definitive ones for this Boost window and retry the transient ones:
 *   - 'submitted'         — the photo went in; the caller applies the Boost.
 *   - 'no-slots'          — the free-slot guard, or the live re-check stood down. Transient.
 *   - 'challenge-gone'    — the attempt found the challenge gone.
 *   - 'data-incomplete'   — the pre-submit re-read cannot be trusted. Transient.
 *   - 'fetch-error'       — the candidate fetch failed. Transient.
 *   - 'submit-unanswered' — the submit threw. Transient.
 *   - 'submit-rejected'   — the server answered with a refusal. Definitive.
 *   - 'pin-refused'       — the library walk saw the photo refused here. Definitive.
 *   - 'pin-not-found'     — a completed walk did not find it in the library. Definitive.
 *   - 'pin-filtered'      — it was offered but a tag or permission filter kept it out of the pick. Definitive.
 *   - 'walk-incomplete'   — the walk has no answer (not run, cut short, threw, or backing off). Transient.
 *   - 'invalid-challenge' — the challenge has no id.
 *
 * @param deps - getActiveChallenges enables the pre-submit live re-check; when
 *   absent the fill proceeds on pass-start data.
 */
const submitPinnedEntry = async (
    challenge: Challenge,
    token: string,
    deps: SettingsFillDeps,
    imageId: string,
): Promise<ActionSubmit> => {
    const { logger } = deps;
    // Whether the candidate fetch offered the pinned photo: recorded by the
    // empty-pool hook, the one place a no-pick explains itself.
    let offered = false;
    const outcome = await runForAction(challenge, token, deps, {
        onlyIds: [imageId],
        onEmptyPick: (eligible) => {
            offered = eligible.some((photo) => String(photo.id) === imageId);
            const line = `fillNew: the photo pinned for Boost (${oneLine(imageId)}) cannot be submitted — not offered, not allowed here, or filtered out`;
            logger.withCategory('autoSubmit').info(line, null);
            return line;
        },
    });
    if (outcome.kind === 'submitted') return { ok: true, imageId: outcome.imageId, reason: 'submitted' };
    if (outcome.kind === 'submit-rejected') return { ok: false, imageId: null, reason: 'submit-rejected' };
    if (outcome.kind === 'submit-threw') return { ok: false, imageId: null, reason: 'submit-unanswered' };
    if (outcome.kind === 'no-pick') {
        // The chosen-photo walk ran inside the pipeline, before the pick; its
        // memo now says why the pinned photo could not go in — when it has an
        // answer at all.
        const walk = chosenWalkOutcome(challenge, imageId);
        if (walk === 'refused') return { ok: false, imageId: null, reason: 'pin-refused' };
        if (walk === 'not-found') return { ok: false, imageId: null, reason: 'pin-not-found' };
        if (offered) return { ok: false, imageId: null, reason: 'pin-filtered' };
        return { ok: false, imageId: null, reason: 'walk-incomplete' };
    }
    return { ok: outcome.ok, imageId: outcome.imageId, reason: outcome.reason };
};

export { submitNewEntryForAction, submitPinnedEntry };
