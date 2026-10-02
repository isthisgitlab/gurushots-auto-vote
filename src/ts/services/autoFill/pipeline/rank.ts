/**
 * Submit-free ranking of a challenge's candidate photos (the swap flow).
 */

import { finalizePick } from '../../photoPicker';
import type { Challenge } from '../../../types/gurushots';
import type { PickerPhoto } from '../../../types/photoPicker';
import type { FetchErrorResult, RankDeps } from '../../../types/autoFill';
import { loadFillCandidates, scoreFillCandidates } from './scoring';
import { verifyFillPick } from './verify';

/**
 * Ranks a challenge's candidate photos with the same pipeline a fill uses, but
 * submits nothing. Every id in `excludeIds` is removed BEFORE scoring and
 * enrichment — finalizePick truncates after sorting, so filtering afterwards
 * could discard every valid alternative when the top picks are excluded.
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
        fillWithoutTagMatch?: boolean;
    } = {},
): Promise<FetchErrorResult | { status: 'ranked'; picked: PickerPhoto[] }> => {
    const {
        label = 'rank',
        usage = 'submit',
        excludeIds = new Set(),
        wantCount = 1,
        mustIncludeTags = null,
        shouldIncludeTags = null,
        fillWithoutTagMatch = true,
    } = opts;
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
    const eligible = loaded.eligible.filter((photo) => photo && !excludeIds.has(String(photo.id)));
    const { scored } = await scoreFillCandidates({
        label,
        challenge,
        token,
        deps,
        eligible,
        semanticScores: loaded.semanticScores,
        ignoreWords: loaded.ignoreWords,
        wantCount,
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
    });
    const byId = new Map(eligible.map((photo) => [String(photo.id), photo]));
    const { picked: pickedIds } = await verifyFillPick(
        challenge,
        scored,
        eligible,
        finalizePick(scored, wantCount),
        loaded.ignoreWords,
        deps,
    );
    const picked = pickedIds.map((id) => byId.get(String(id))).filter(Boolean) as PickerPhoto[];
    return { status: 'ranked', picked };
};

export { rankCandidatesForChallenge };
