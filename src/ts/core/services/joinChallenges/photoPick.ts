/**
 * The entry photo pick for a join, reusing auto-fill's picker and its tag rules.
 */

import * as logger from '../../logger';
import * as settings from '../../settings';
import {
    clearChosenSkip,
    fetchCandidatesForChallenge,
    logChosenSkipOnce,
    logPoolBlockOnce,
    resolveChosenPhotos,
    resolveMissingChosen,
    resolveSemanticScores,
} from '../autoFill';
import { buildChosenCandidates, finalizePick, jointInputsOf } from '../photoPicker';
import { createStatsBudget, createVotesLoader } from '../photoStats';
import { rankVisually } from '../visionVerifier';
import type { Challenge } from '../../types/gurushots';
import type { PickerPhoto, TagOptions } from '../../types/photoPicker';
import type { PhotoPoolBlock } from '../../types/stores';
import { errorMessage } from '../../errorMessage';
import { cat } from './shared';
import type { JoinDeps } from './shared';
import { resolveJoinSetting } from './settingsResolution';

// Same shortlist length the fill path hands the visual re-rank.
const VISUAL_SHORTLIST = 12;

/**
 * What a join's photo pick came to: the photo, or why there is none —
 * 'no-photo' (the photos were read and nothing is eligible) versus
 * 'no-chosen' (Submit Only Chosen Photos is on and no chosen photo can be
 * entered, so nothing was picked on purpose), 'pool-unbound' / 'pool-exhausted' (the same, for the photo pool of the
 * phase the candidate's scenario is in: not saved on this account, or all given out) — and 'unreadable' when the photos could
 * not be read at all (a network or API error), which says nothing about the library.
 */
type JoinPick =
    | { id: string; reason: 'picked' }
    | { id: null; reason: 'no-photo' | 'no-chosen' | 'unreadable' | PhotoPoolBlock };

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
    const trace = { walkedUnfiltered: false, readFailed: false };
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
        if (trace.readFailed) {
            cat().warning(`could not read your photo library for ${challenge?.id}: its first page failed`, null);
            return null;
        }
        return { eligible, walkedUnfiltered: trace.walkedUnfiltered };
    } catch (error) {
        cat().warning(`could not read eligible photos for ${challenge?.id}: ${errorMessage(error) || error}`, null);
        // aislop-ignore-next-line ai-slop/hidden-fallback -- warned via the join logger above; null is the documented "unreadable" result
        return null;
    }
};

/**
 * The photo pool of the phase the candidate's scenario is in, or null: the scenario is the one its own override names, else
 * the one a title rule gives it (as the scenario runner resolves it for a candidate that is not joined yet), and its progress
 * record must be of that scenario. A candidate with none keeps the join's own settings.
 */
const joinPoolView = (challenge: Challenge) => {
    const own: unknown = settings.getChallengeOverride?.('scenario', String(challenge.id));
    const rule: unknown =
        typeof own === 'string' && own !== '' ? own : settings.resolveRuleSetting?.('scenario', challenge)?.value;
    return typeof rule === 'string' && rule !== '' ? (settings.getPoolViewFor?.(challenge.id, rule) ?? null) : null;
};

/**
 * The Chosen Photos settings for a join candidate. An un-joined challenge has no
 * id in the settings cache, so they resolve by rule and per-id override like
 * every other join setting. A candidate whose scenario phase draws from a photo pool takes the pool instead, as a fill
 * does: the photos it has left, `only` and `inOrder` as the phase says, and the pool's block.
 */
const resolveJoinChosen = (challenge: Challenge, pool: ReturnType<typeof joinPoolView>) =>
    pool
        ? resolveChosenPhotos({
              read: (key) =>
                  key === 'chosenPhotos' ? pool.ids : key === 'chosenPhotosOnly' ? pool.only : pool.inOrder,
              blocked: pool.block,
          })
        : resolveChosenPhotos({
              read: (key) => resolveJoinSetting(key, challenge),
          });

/**
 * The library photos GuruShots suggests for this un-joined challenge, as a
 * set. HONEST SCOPE: a weak tiebreak — it only orders photos already in the
 * fetched candidate pool (no extra fetch for the suggested ids), and the
 * visual re-rank of the shortlist may still reorder it. No dep wired in, or a
 * read that fails, means no suggestions: the pick is unaffected.
 */
const suggestedIdsFor = async (challenge: Challenge, token: string, deps: JoinDeps): Promise<ReadonlySet<string>> => {
    if (!deps.getSuggestedPhotoIds) return new Set();
    try {
        return new Set(await deps.getSuggestedPhotoIds(token, challenge.id));
    } catch (error) {
        cat().debug(`could not read the suggested photos for ${challenge?.id}: ${errorMessage(error) || error}`, null);
        return new Set();
    }
};

/**
 * Pick a single eligible entry photo for a candidate, honoring the same
 * must/should tag rules and picker as auto-fill. Tags are resolved by the
 * challenge object (title-aware); submitWithoutTagMatch by title profile.
 *
 * The user's chosen photos come first: when any can be entered the shortlist is
 * the chosen block alone, so the visual re-rank can only choose between chosen
 * photos — or, when the user asked for their order, the first usable photo in the
 * list is taken and nothing re-ranks it. With none usable, Submit Only Chosen
 * Photos prevents a pick unless a manual join or a previously paid join bypasses it.
 * An automatic pick with no usable chosen photo can be deferred when fallback
 * is off and the visual check abstains.
 * GuruShots' suggested photos for this un-joined challenge rank above equally
 * theme-matched ones — a weak tiebreak the visual re-rank may still reorder.
 */
const pickJoinPhoto = async (
    challenge: Challenge,
    token: string,
    deps: JoinDeps,
    { ignoreChosenOnly, manual }: { ignoreChosenOnly: boolean; manual: boolean },
): Promise<JoinPick> => {
    const mustIncludeTags = settings.getEffectiveTagSetting('mustIncludeTags', challenge);
    const shouldIncludeTags = settings.getEffectiveTagSetting('shouldIncludeTags', challenge);
    const submitWithoutTagMatch = resolveJoinSetting('submitWithoutTagMatch', challenge) === true;
    // Same list the fill path uses; resolved here because join does its own
    // fetch/score/pick rather than going through runFillAttempt.
    // Optional-chained like every other per-challenge settings read here: a
    // partial settings stub (or facade) must degrade to "no
    // list", never throw mid-join.
    const ignoreWords = settings.getEffectiveIgnoreTitleWords?.(challenge) ?? null;
    const pool = joinPoolView(challenge);
    const chosenSettings = resolveJoinChosen(challenge, pool);
    const enforceOnly = chosenSettings.only && !ignoreChosenOnly;
    // A photo pool with nothing to give, and Submit Only: nothing is picked and nothing is read or asked of GuruShots; the join
    // does not happen (so a paid one spends nothing). A previously paid join or a manual join bypasses Submit Only.
    // Either can still return no photo for another reason.
    if (enforceOnly && pool?.block) {
        logPoolBlockOnce(logger, challenge, 'join', pool.block, pool.name);
        return { id: null, reason: pool.block };
    }

    const loaded = await loadJoinCandidates(challenge, token, deps, {
        mustIncludeTags,
        shouldIncludeTags,
        ignoreWords,
    });
    if (loaded === null) return { id: null, reason: 'unreadable' };
    // A chosen photo the themed search missed may still be in the library.
    const missed = await resolveMissingChosen({
        challenge,
        token,
        ids: chosenSettings.ids,
        eligible: loaded.eligible,
        wantCount: 1,
        allowWalk: !loaded.walkedUnfiltered,
        inOrder: chosenSettings.inOrder,
        deps: { getEligiblePhotosWalk: deps.getEligiblePhotosWalk, logger },
        label: 'join',
    });
    const eligible = [...loaded.eligible, ...missed];
    const semanticScores = await resolveSemanticScores(challenge, eligible, { ignoreWords });
    // Suggestions exist only for an un-joined challenge, which is the only kind
    // a join pick sees; auto-fill of already-joined challenges gets none.
    const suggestedIds = await suggestedIdsFor(challenge, token, deps);
    // A shortlist, not one photo, so the visual re-rank a fill applies can
    // promote an on-theme alternative here too. The scored entries are kept:
    // the re-rank weighs their tier values together with the model's fit and the votes.
    // The candidates are library photo records, the shape the picker ranks.
    const chosen =
        chosenSettings.ids.length > 0
            ? { ids: chosenSettings.ids, only: enforceOnly, inOrder: chosenSettings.inOrder }
            : null;
    const { scored, chosenIds, orderedIds } = buildChosenCandidates(challenge, eligible as PickerPhoto[], {
        mustIncludeTags,
        shouldIncludeTags,
        submitWithoutTagMatch,
        semanticScores,
        ignoreWords,
        suggestedIds,
        chosen,
    });
    const ranked = finalizePick(scored, VISUAL_SHORTLIST, chosenIds, chosen?.inOrder ? orderedIds : null);
    if (ranked.length === 0) {
        if (!enforceOnly) return { id: null, reason: 'no-photo' };
        // With Submit Only the pool held nothing but chosen photos.
        logChosenSkipOnce(logger, challenge, 'join', 'none-usable');
        return { id: null, reason: 'no-chosen' };
    }
    clearChosenSkip(challenge);
    // The picker ranks the chosen photos first; when any can be entered the
    // shortlist is those alone, so the re-rank can only choose between them.
    const chosenSet = new Set(chosenSettings.ids);
    const chosenRanked = ranked.filter((id) => chosenSet.has(String(id)));
    const shortlist = chosenRanked.length > 0 ? chosenRanked : ranked;
    // A single chosen photo has nothing to be re-ranked against, and one the user put in order is
    // not re-ranked: the first usable photo in the list is the pick.
    const useFirstChosen = chosenSettings.inOrder ? chosenRanked.length > 0 : chosenRanked.length === 1;
    if (useFirstChosen) {
        return { id: chosenRanked[0], reason: 'picked' };
    }
    const [picked] = await (deps.rankVisually || rankVisually)(challenge, shortlist, eligible, 1, {
        logger,
        ignoreWords,
        skipOnAbstain: !submitWithoutTagMatch && !manual && chosenRanked.length === 0,
        jointInputs: jointInputsOf(scored),
        // The votes of the photos the model accepts, from this pick's own lookup budget so a join does not
        // drain the voting pass's; mock ids never reach the real stats cache.
        loadVotes: createVotesLoader(scored, token, {
            getImageData: deps.getImageData,
            logger,
            statsBudget: createStatsBudget(),
            persist: settings.getSetting('mock') !== true,
        }),
    });
    return picked ? { id: picked, reason: 'picked' } : { id: null, reason: 'no-photo' };
};

export type { JoinPick };
export { pickJoinPhoto };
