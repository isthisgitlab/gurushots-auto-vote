/**
 * Auto-fill — the unfiltered-library read: the vote-ordered walk, then the
 * API's default order when that holds nothing eligible.
 */

import type { PickerPhoto } from '../../types/photoPicker';
import type { RankDeps } from '../../types/autoFill';

/**
 * Whether a candidate list holds a photo the challenge allows. `excludeIds`
 * names the photos the challenge's swap history took out; a list holding only
 * those counts as empty, so the caller falls back rather than returning photos
 * the fill would filter away anyway.
 */
const hasEligible = (list: PickerPhoto[], excludeIds?: Set<string> | null) =>
    list.some((p) => p && p.permission && p.permission.allowed === true && p.id && !excludeIds?.has(String(p.id)));

/** Dedupe a photo list by raw id, first occurrence winning. */
const dedupById = (photos: PickerPhoto[]): PickerPhoto[] => [
    ...new Map(photos.map((photo) => [photo.id, photo])).values(),
];

/**
 * The unfiltered library read: the vote-ordered walk, then the API's default order when that holds nothing
 * eligible. `excludeIds` (photos the swap history took out) makes a page count as empty when it holds only
 * those. A caller that started `trace.readFailed` at false is told when both reads failed on their first page.
 */
const readUnfilteredLibrary = async (
    challengeId: string | number,
    token: string,
    getEligiblePhotos: RankDeps['getEligiblePhotos'],
    {
        logLabel,
        usageOpt,
        trace,
        excludeIds,
    }: {
        logLabel: string;
        usageOpt: { usage?: string };
        trace?: { walkedUnfiltered: boolean; readFailed?: boolean; truncated?: boolean };
        excludeIds?: Set<string> | null;
    },
): Promise<PickerPhoto[]> => {
    // Only a caller that asked (by starting `readFailed` or `truncated` at false) gets the read tracked.
    const asked = trace?.readFailed !== undefined || trace?.truncated !== undefined;
    const readStateOf = (): { firstPageFailed: boolean; truncated?: boolean } =>
        trace?.truncated === undefined ? { firstPageFailed: false } : { firstPageFailed: false, truncated: false };
    const byVotesRead = readStateOf();
    const defaultRead = readStateOf();
    const tracked = (readState: typeof byVotesRead) => (asked ? { readState } : {});
    const byVotes = await getEligiblePhotos(challengeId, token, {
        paginate: true,
        logLabel,
        ...tracked(byVotesRead),
        ...usageOpt,
    });
    // Either way out, the walk that was just read may have stopped early.
    const noteTruncated = () => {
        if (trace?.truncated !== undefined && (byVotesRead.truncated === true || defaultRead.truncated === true)) {
            trace.truncated = true;
        }
    };
    if (hasEligible(byVotes, excludeIds)) {
        noteTruncated();
        return byVotes;
    }
    const byDefault = await getEligiblePhotos(challengeId, token, {
        order: 'default',
        logLabel,
        ...tracked(defaultRead),
        ...usageOpt,
    });
    if (trace && byVotesRead.firstPageFailed && defaultRead.firstPageFailed) trace.readFailed = true;
    noteTruncated();
    // Merge, don't discard — symmetric with the themed merge in candidates.ts:
    // the default-order page leads, the vote-ordered page trails, deduped by
    // id. The trailing photos may be swap-history removals the caller's filter
    // re-allows for chosen ids, or photos the server disallowed (which every
    // consumer's allowed filter drops), and a byDefault read that failed
    // (empty) must not lose them either.
    return dedupById([...byDefault, ...byVotes]);
};

export { hasEligible, dedupById, readUnfilteredLibrary };
