/**
 * Submit-free photo suggestions: the pick half of a scheduled fill, answered as a ranking.
 */

import { finalizePick } from '../../photoPicker';
import { createStatsBudget, statsBudgetLimited } from '../../photoStats';
import { enteredIds } from '../chosenPhotos';
import type { Challenge } from '../../../types/gurushots';
import type { PickerPhoto } from '../../../types/photoPicker';
import type { FetchErrorResult, RankDeps } from '../../../types/autoFill';
import { addMissedChosen, planChosen } from './attempt';
import { loadFillCandidates, scoreFillCandidates } from './scoring';
import { verifyFillPick } from './verify';

/** How many photos a suggestion run ranks and answers. */
const SUGGEST_COUNT = 5;

/** What a suggestion run came to. */
type SuggestResult =
    | FetchErrorResult
    /** `photos` best first; `statsLimited`: the run's photo-stat lookups kept failing, or its budget stopped one it still needed (it ranked on what was known). */
    | { status: 'suggested'; photos: PickerPhoto[]; statsLimited: boolean }
    /** Submit Only Chosen Photos is on and every chosen photo is already entered. */
    | { status: 'no-chosen-entered' }
    /** Submit Only Chosen Photos is on and none of the chosen photos can go in. */
    | { status: 'no-chosen-unusable' }
    /** The Must Include Tags filter was active, there were photos to consider, and none matched. */
    | { status: 'no-match' }
    | { status: 'no-eligible' };

/**
 * Ranks a challenge's photos the way the scheduled auto-fill picks (tag rules, Chosen Photos and Submit Only,
 * semantic score, popularity stats, the local image check) and answers the top `count`, best first. Nothing
 * is submitted, and the dependencies carry no submitter.
 *
 * Side effects, by design: the chosen-photo walk memo and its retry timer (resolveMissingChosen), the
 * photo-stats cache, and `suggest:` log lines that name the challenge and counts, never a photo. It
 * never writes the entry ledger or the chosen-photo skip and refusal memory, and it spends its own
 * photo-stats budget, so a voting pass running meanwhile keeps its own.
 *
 * It is a ranking under the fill's rules, not a replay of the next fill: that one picks a single photo, and
 * both the stats lookups and the image check depend on how many photos are being picked.
 *
 * @param deps - settings is optional only so failure-path unit tests can omit it, in which case tag rules
 *   degrade to "no filter".
 */
const suggestFillPhotos = async (
    challenge: Challenge,
    token: string,
    deps: RankDeps,
    count: number = SUGGEST_COUNT,
): Promise<SuggestResult> => {
    const { settings, logger } = deps;
    const label = 'suggest';
    const log = logger.withCategory('autoFill');
    const tag = logger.challengeTag(challenge);
    const statsBudget = createStatsBudget();
    const runDeps: RankDeps = { ...deps, statsBudget };

    const mustIncludeTags = settings?.getEffectiveTagSetting('mustIncludeTags', challenge) ?? null;
    const shouldIncludeTags = settings?.getEffectiveTagSetting('shouldIncludeTags', challenge) ?? null;
    const fillWithoutTagMatch = settings?.getEffectiveSetting('fillWithoutTagMatch', String(challenge.id));

    const {
        settings: chosenSettings,
        enforceOnly,
        unentered,
        chosen,
    } = await planChosen({ label, challenge, token, deps: runDeps });
    if (enforceOnly && unentered.length === 0) {
        log.info(`${label}: every chosen photo is already entered in ${tag}, and Submit Only is on`, null);
        return { status: 'no-chosen-entered' };
    }

    const loaded = await loadFillCandidates({
        label,
        challenge,
        token,
        deps: runDeps,
        mustIncludeTags,
        shouldIncludeTags,
    });
    if (loaded.status === 'fetch-error') return loaded;
    const { ignoreWords } = loaded;
    const inOrder = chosenSettings.inOrder;
    const { eligible, semanticScores } = await addMissedChosen({
        label,
        challenge,
        token,
        deps: runDeps,
        wantCount: count,
        unentered,
        inOrder,
        loaded,
    });

    // Photos already entered are removed BEFORE scoring and enrichment: finalizePick truncates after
    // sorting, so filtering afterwards could leave fewer than `count` when the top photos are entered.
    const entered = enteredIds(challenge);
    const pool = eligible.filter((photo) => !entered.has(String(photo.id)));
    const { scored, chosenIds, orderedIds } = await scoreFillCandidates({
        label,
        challenge,
        token,
        deps: runDeps,
        eligible: pool,
        semanticScores,
        ignoreWords,
        wantCount: count,
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
        chosen,
    });
    if (enforceOnly && scored.length === 0) {
        log.info(`${label}: none of the chosen photos can be submitted to ${tag}, and Submit Only is on`, null);
        return { status: 'no-chosen-unusable' };
    }

    const pickedIds = finalizePick(scored, count, chosenIds, inOrder ? orderedIds : null);
    if (pickedIds.length === 0) {
        const mustActive = Array.isArray(mustIncludeTags) && mustIncludeTags.length > 0;
        const noMatch = mustActive && pool.length > 0;
        log.info(
            `${label}: ${noMatch ? 'no photos matched the Must Include Tags' : 'no eligible photos'} for ${tag}`,
            null,
        );
        return { status: noMatch ? 'no-match' : 'no-eligible' };
    }

    const verified = await verifyFillPick(challenge, scored, pool, pickedIds, ignoreWords, runDeps, chosenIds, inOrder);
    const byId = new Map(pool.map((photo) => [String(photo.id), photo]));
    const photos = verified.picked
        .map((id) => byId.get(String(id)))
        .filter((photo): photo is PickerPhoto => photo !== undefined);
    const statsLimited = statsBudgetLimited(statsBudget);
    log.info(
        `${label}: ranked ${photos.length} photos for ${tag}${statsLimited ? ' (photo-stat lookups were cut short)' : ''}`,
        null,
    );
    return { status: 'suggested', photos, statsLimited };
};

export { suggestFillPhotos, SUGGEST_COUNT };
export type { SuggestResult };
