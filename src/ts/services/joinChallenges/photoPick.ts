/**
 * The entry photo pick for a join, reusing auto-fill's picker and its tag rules.
 */

import * as logger from '../../logger';
import * as settings from '../../settings';
import {
    clearChosenSkip,
    fetchCandidatesForChallenge,
    logChosenSkipOnce,
    resolveChosenPhotos,
    resolveMissingChosen,
    resolveSemanticScores,
} from '../autoFill';
import { pickPhotosForChallenge } from '../photoPicker';
import { rankVisually } from '../visionVerifier';
import type { Challenge } from '../../types/gurushots';
import type { PickerPhoto, TagOptions } from '../../types/photoPicker';
import { errorMessage } from '../../errorMessage';
import { cat } from './shared';
import type { JoinDeps } from './shared';
import { resolveJoinSetting } from './settingsResolution';

// Same shortlist length the fill path hands the visual re-rank.
const VISUAL_SHORTLIST = 12;

/**
 * What a join's photo pick came to: the photo, or why there is none —
 * 'no-photo' (nothing eligible, or the candidates could not be read) versus
 * 'no-chosen' (Submit Only Chosen Photos is on and no chosen photo can be
 * entered, so nothing was picked on purpose).
 */
type JoinPick = { id: string; reason: 'picked' } | { id: null; reason: 'no-photo' | 'no-chosen' };

/**
 * The photos a join can choose from, or null when they could not be read. The
 * fetch is the one a fill uses (the picker is shared), attributed to 'join' in
 * the logs; `walkedUnfiltered` says it already read the whole library.
 */
const loadJoinCandidates = async (
    challenge: Challenge,
    token: string,
    deps: JoinDeps,
    tagOpts: TagOptions,
): Promise<{ eligible: PickerPhoto[]; walkedUnfiltered: boolean } | null> => {
    const trace = { walkedUnfiltered: false };
    try {
        const eligible = await fetchCandidatesForChallenge(challenge, token, tagOpts, {
            getEligiblePhotos: deps.getEligiblePhotos,
            logger,
            logLabel: 'join',
            // Passed through so a join narrows to on-theme photos the same
            // way a fill does — the picker is shared, so the candidate set
            // has to be too.
            searchTagAutocomplete: deps.searchTagAutocomplete,
            getCurrentMemberProfile: deps.getCurrentMemberProfile,
            trace,
        });
        return { eligible, walkedUnfiltered: trace.walkedUnfiltered };
    } catch (error) {
        cat().warning(`could not read eligible photos for ${challenge?.id}: ${errorMessage(error) || error}`, null);
        return null;
    }
};

/**
 * The Chosen Photos settings for a join candidate. An un-joined challenge has no
 * id in the settings cache, so they resolve by rule and per-id override like
 * every other join setting.
 */
const resolveJoinChosen = (challenge: Challenge, token: string, deps: JoinDeps) =>
    resolveChosenPhotos({
        read: (key) =>
            key === 'chosenPhotosMemberId' ? settings.getSetting?.(key) : resolveJoinSetting(key, challenge),
        token,
        getCurrentMemberProfile: deps.getCurrentMemberProfile,
        logger,
        label: 'join',
    });

/**
 * Pick a single eligible entry photo for a candidate, honoring the same
 * must/should tag rules and picker as auto-fill. Tags are resolved by the
 * challenge object (title-aware); fillWithoutTagMatch by title profile.
 *
 * The user's chosen photos come first: when any can be entered the shortlist is
 * the chosen block alone, so the visual re-rank can only choose between chosen
 * photos. With none usable the join picks as it always did — or, with Submit
 * Only Chosen Photos on, picks nothing (`ignoreChosenOnly` lifts that: a paid
 * join whose coins are already spent must still submit something).
 */
const pickJoinPhoto = async (
    challenge: Challenge,
    token: string,
    deps: JoinDeps,
    { ignoreChosenOnly }: { ignoreChosenOnly: boolean },
): Promise<JoinPick> => {
    const mustIncludeTags = settings.getEffectiveTagSetting('mustIncludeTags', challenge);
    const shouldIncludeTags = settings.getEffectiveTagSetting('shouldIncludeTags', challenge);
    const fillWithoutTagMatch = resolveJoinSetting('fillWithoutTagMatch', challenge) === true;
    // Same list the fill path uses; resolved here because join does its own
    // fetch/score/pick rather than going through runFillAttempt.
    // Optional-chained like every other per-challenge settings read here: a
    // partial settings stub (or facade) must degrade to "no
    // list", never throw mid-join.
    const ignoreWords = settings.getEffectiveIgnoreTitleWords?.(challenge) ?? null;
    const chosenSettings = await resolveJoinChosen(challenge, token, deps);
    const enforceOnly = chosenSettings.only && !ignoreChosenOnly;

    const loaded = await loadJoinCandidates(challenge, token, deps, {
        mustIncludeTags,
        shouldIncludeTags,
        ignoreWords,
    });
    if (loaded === null) return { id: null, reason: 'no-photo' };
    // A chosen photo the themed search missed may still be in the library.
    const missed = await resolveMissingChosen({
        challenge,
        token,
        ids: chosenSettings.ids,
        eligible: loaded.eligible,
        wantCount: 1,
        allowWalk: !loaded.walkedUnfiltered,
        deps: { getEligiblePhotosWalk: deps.getEligiblePhotosWalk, logger },
        label: 'join',
    });
    const eligible = [...loaded.eligible, ...missed];
    const semanticScores = await resolveSemanticScores(challenge, eligible, { ignoreWords });
    // A shortlist, not one photo, so the visual re-rank a fill applies can
    // promote an on-theme alternative here too.
    // The candidates are library photo records, the shape the picker ranks.
    const ranked = pickPhotosForChallenge(challenge, eligible as PickerPhoto[], VISUAL_SHORTLIST, {
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
        semanticScores,
        ignoreWords,
        chosen: chosenSettings.ids.length > 0 ? { ids: chosenSettings.ids, only: enforceOnly } : null,
    });
    if (!ranked || ranked.length === 0) {
        if (!enforceOnly) return { id: null, reason: 'no-photo' };
        // With Submit Only the pool held nothing but chosen photos.
        logChosenSkipOnce(logger, challenge, 'join', 'none-usable');
        return { id: null, reason: 'no-chosen' };
    }
    clearChosenSkip(challenge);
    // The picker ranks the chosen photos first; when any can be entered the
    // shortlist is those alone, so the re-rank can only choose between them.
    const chosenIds = new Set(chosenSettings.ids);
    const chosenRanked = ranked.filter((id) => chosenIds.has(String(id)));
    const shortlist = chosenRanked.length > 0 ? chosenRanked : ranked;
    // A single chosen photo has nothing to be re-ranked against.
    if (chosenRanked.length === 1) return { id: chosenRanked[0], reason: 'picked' };
    const [picked] = await (deps.rankVisually || rankVisually)(challenge, shortlist, eligible, 1, {
        logger,
        ignoreWords,
    });
    return { id: picked, reason: 'picked' };
};

export { pickJoinPhoto };
