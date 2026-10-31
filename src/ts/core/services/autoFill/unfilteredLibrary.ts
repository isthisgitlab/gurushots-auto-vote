/**
 * Auto-fill — the unfiltered-library read: the vote-ordered walk, then the
 * API's default order when that holds nothing eligible.
 */

import type { PickerPhoto } from '../../types/photoPicker';
import type { RankDeps } from '../../types/autoFill';

/** Whether a candidate list holds a photo the challenge allows. */
const hasEligible = (list: PickerPhoto[]) =>
    list.some((p) => p && p.permission && p.permission.allowed === true && p.id);

/**
 * The unfiltered library read: the vote-ordered walk, then the API's default order when that holds nothing
 * eligible. A caller that started `trace.readFailed` at false is told when both reads failed on their first page.
 */
const readUnfilteredLibrary = async (
    challengeId: string | number,
    token: string,
    getEligiblePhotos: RankDeps['getEligiblePhotos'],
    {
        logLabel,
        usageOpt,
        trace,
    }: { logLabel: string; usageOpt: { usage?: string }; trace?: { walkedUnfiltered: boolean; readFailed?: boolean } },
): Promise<PickerPhoto[]> => {
    // Only a caller that asked (by starting `readFailed` at false) gets the read tracked.
    const byVotesRead = { firstPageFailed: false };
    const defaultRead = { firstPageFailed: false };
    const tracked = (readState: typeof byVotesRead) => (trace?.readFailed === undefined ? {} : { readState });
    const byVotes = await getEligiblePhotos(challengeId, token, {
        paginate: true,
        logLabel,
        ...tracked(byVotesRead),
        ...usageOpt,
    });
    if (hasEligible(byVotes)) return byVotes;
    const byDefault = await getEligiblePhotos(challengeId, token, {
        order: 'default',
        logLabel,
        ...tracked(defaultRead),
        ...usageOpt,
    });
    if (trace && byVotesRead.firstPageFailed && defaultRead.firstPageFailed) trace.readFailed = true;
    return byDefault;
};

export { hasEligible, readUnfilteredLibrary };
