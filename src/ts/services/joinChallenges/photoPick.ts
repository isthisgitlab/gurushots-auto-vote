/**
 * The entry photo pick for a join, reusing auto-fill's picker and its tag rules.
 */

import * as logger from '../../logger';
import * as settings from '../../settings';
import { fetchCandidatesForChallenge, resolveSemanticScores } from '../autoFill';
import { pickPhotosForChallenge } from '../photoPicker';
import { rankVisually } from '../visionVerifier';
import type { Challenge } from '../../types/gurushots';
import type { PickerPhoto } from '../../types/photoPicker';
import { errorMessage } from '../../errorMessage';
import { cat } from './shared';
import type { JoinDeps } from './shared';
import { resolveJoinSetting } from './settingsResolution';

// Same shortlist length the fill path hands the visual re-rank.
const VISUAL_SHORTLIST = 12;

/**
 * Pick a single eligible entry photo for a candidate, honoring the same
 * must/should tag rules and picker as auto-fill. Tags are resolved by the
 * challenge object (title-aware); fillWithoutTagMatch by title profile.
 * @returns the photo id, or null when none is eligible.
 */
const pickJoinPhoto = async (challenge: Challenge, token: string, deps: JoinDeps): Promise<string | null> => {
    const mustIncludeTags = settings.getEffectiveTagSetting('mustIncludeTags', challenge);
    const shouldIncludeTags = settings.getEffectiveTagSetting('shouldIncludeTags', challenge);
    const fillWithoutTagMatch = resolveJoinSetting('fillWithoutTagMatch', challenge) === true;
    // Same list the fill path uses; resolved here because join does its own
    // fetch/score/pick rather than going through runFillAttempt.
    // Optional-chained like every other per-challenge settings read here: a
    // partial settings stub (or facade) must degrade to "no
    // list", never throw mid-join.
    const ignoreWords = settings.getEffectiveIgnoreTitleWords?.(challenge) ?? null;

    let eligible;
    try {
        eligible = await fetchCandidatesForChallenge(
            challenge,
            token,
            {
                mustIncludeTags,
                shouldIncludeTags,
                ignoreWords,
            },
            // logLabel 'join' so photo-library warnings are attributed to the join
            // flow, not auto-fill (the picker is shared).
            {
                getEligiblePhotos: deps.getEligiblePhotos,
                logger,
                logLabel: 'join',
                // Passed through so a join narrows to on-theme photos the same
                // way a fill does — the picker is shared, so the candidate set
                // has to be too.
                searchTagAutocomplete: deps.searchTagAutocomplete,
                getCurrentMemberProfile: deps.getCurrentMemberProfile,
            },
        );
    } catch (error) {
        cat().warning(`could not read eligible photos for ${challenge?.id}: ${errorMessage(error) || error}`, null);
        return null;
    }
    const semanticScores = await resolveSemanticScores(challenge, eligible, { ignoreWords });
    // A shortlist, not one photo, so the visual re-rank a fill applies can
    // promote an on-theme alternative here too.
    // The candidates are library photo records, the shape the picker ranks.
    const shortlist = pickPhotosForChallenge(challenge, eligible as PickerPhoto[], VISUAL_SHORTLIST, {
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
        semanticScores,
        ignoreWords,
    });
    if (!shortlist || shortlist.length === 0) return null;
    const [picked] = await (deps.rankVisually || rankVisually)(challenge, shortlist, eligible, 1, {
        logger,
        ignoreWords,
    });
    return picked;
};

export { pickJoinPhoto };
