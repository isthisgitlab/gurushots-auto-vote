/**
 * Submit-free ranking of a challenge's candidate photos (the swap flow). It reads the Chosen Photos
 * settings like the scheduled fill: the chosen photos rank first, a chosen photo the themed search
 * did not return is looked up in the library, and (only when the caller asks) Submit Only Chosen
 * Photos limits the pick to them.
 */

import { finalizePick } from '../../photoPicker';
import type { Challenge } from '../../../types/gurushots';
import type { PickerPhoto } from '../../../types/photoPicker';
import type { FetchErrorResult, RankDeps } from '../../../types/autoFill';
import { addMissedChosen, planChosen } from './attempt';
import { loadFillCandidates, scoreFillCandidates } from './scoring';
import { verifyFillPick } from './verify';

/**
 * What a ranking came to. `noChosenLeft`: Submit Only Chosen Photos was enforced and no chosen
 * photo can go in, so `picked` is empty by that rule rather than for lack of photos.
 */
type RankResult = FetchErrorResult | { status: 'ranked'; picked: PickerPhoto[]; noChosenLeft?: true };

/**
 * Ranks a challenge's candidate photos with the same pipeline a fill uses, but
 * submits nothing. Every id in `excludeIds` is removed BEFORE scoring and
 * enrichment — finalizePick truncates after sorting, so filtering afterwards
 * could discard every valid alternative when the top picks are excluded. The
 * excluded ids also leave the chosen list before the library lookup, so an
 * excluded chosen photo never stands in for one that is still missing.
 *
 * `enforceChosenOnly` applies Submit Only Chosen Photos: with it on in the settings, only chosen
 * photos are picked, and with none usable the pick is empty (`noChosenLeft`). Without it the
 * chosen photos still rank first, and the pick is topped up from the rest.
 *
 * @param deps - same shape as the fill deps
 *   picked: the top `wantCount` candidate photo records (with id + member_id), best first
 */
const rankCandidatesForChallenge = async (
    challenge: Challenge,
    token: string,
    deps: RankDeps,
    opts: {
        label?: string;
        usage?: 'submit' | 'swap';
        excludeIds?: Set<string>;
        wantCount?: number;
        mustIncludeTags?: readonly string[] | null;
        shouldIncludeTags?: readonly string[] | null;
        submitWithoutTagMatch?: boolean;
        enforceChosenOnly?: boolean;
    } = {},
): Promise<RankResult> => {
    const {
        label = 'rank',
        usage = 'submit',
        excludeIds = new Set(),
        wantCount = 1,
        mustIncludeTags = null,
        shouldIncludeTags = null,
        submitWithoutTagMatch = true,
        enforceChosenOnly = false,
    } = opts;
    const plan = planChosen({ label: 'swap', challenge, token, deps, ignoreOnly: !enforceChosenOnly });
    const { enforceOnly } = plan;
    const { inOrder } = plan.settings;
    const unentered = plan.unentered.filter((id) => !excludeIds.has(id));
    const chosen = plan.chosen && { ...plan.chosen, excludeIds };
    const none: RankResult = { status: 'ranked', picked: [], noChosenLeft: true };
    if (enforceOnly && unentered.length === 0) return none;

    const loaded = await loadFillCandidates({
        label,
        challenge,
        token,
        deps,
        mustIncludeTags,
        shouldIncludeTags,
        usage,
    });
    if (loaded.status === 'fetch-error') {
        return loaded;
    }
    const { ignoreWords } = loaded;
    const withMissed = await addMissedChosen({
        label: 'swap',
        challenge,
        token,
        deps,
        wantCount,
        unentered,
        inOrder,
        loaded,
        usage,
    });
    const eligible = withMissed.eligible.filter((photo) => photo && !excludeIds.has(String(photo.id)));
    const { scored, chosenIds, orderedIds } = await scoreFillCandidates({
        label,
        challenge,
        token,
        deps,
        eligible,
        semanticScores: withMissed.semanticScores,
        ignoreWords,
        wantCount,
        mustIncludeTags,
        shouldIncludeTags,
        submitWithoutTagMatch,
        chosen,
    });
    const pick = finalizePick(scored, wantCount, chosenIds, inOrder ? orderedIds : null);
    // The visual check only reorders a pick, so an empty pick here is the final answer.
    if (enforceOnly && pick.length === 0) return none;
    const byId = new Map(eligible.map((photo) => [String(photo.id), photo]));
    const { picked: pickedIds } = await verifyFillPick(
        challenge,
        scored,
        eligible,
        pick,
        ignoreWords,
        deps,
        chosenIds,
        inOrder,
    );
    const picked = pickedIds.map((id) => byId.get(String(id))).filter(Boolean) as PickerPhoto[];
    return { status: 'ranked', picked };
};

export { rankCandidatesForChallenge };
