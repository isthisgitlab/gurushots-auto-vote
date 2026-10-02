import * as logger from '../../logger';
import * as settings from '../../settings';

import type { Challenge } from '../../types/gurushots';
import type { VotingPassApi, VotingPassResult, ScenarioDeps } from '../../types/votingPass';
import type { CurrencyPassDeps } from '../currencyAuto';
import type { EntryTracker } from '../newEntryTracker';
import type { EntryAgeLedger } from '../../types/stores';
import type { MissionNeeds } from '../missions';

/**
 * Per-challenge context threaded to every deadline-action runner. All of a
 * runner's per-pass state comes through here explicitly — module-scope
 * imports (logger, settings, votingLogic, autoFill, formatDuration) are the
 * only other things they touch.
 */
export type ActionContext = {
    challenge: Challenge;
    token: string;
    now: number;
    api: VotingPassApi;
    fillDeps: FillDeps;
    entryAges: EntryAgeLedger | null;
};

/**
 * Shared dependency bundle for every auto-fill entry point this pass
 * (fill-new on boost/turbo, staggered auto-fill, emergency fill).
 */
export const buildFillDeps = (api: VotingPassApi, entryAges: EntryAgeLedger | null) => ({
    settings,
    logger,
    getEligiblePhotos: api.getEligiblePhotos,
    getImageData: api.getImageData,
    submitToChallenge: api.submitToChallenge,
    entryAges,
    getActiveChallenges: api.getActiveChallenges,
    // Enables tag resolution on the themed-search miss path; without the
    // pair the themed search skips tag resolution.
    searchTagAutocomplete: api.searchTagAutocomplete,
    getCurrentMemberProfile: api.getCurrentMemberProfile,
});

/**
 * Per-pass context threaded to every per-challenge phase below.
 */
export type PassContext = {
    token: string;
    api: VotingPassApi;
    fillDeps: FillDeps;
    interChallengeDelay: () => number;
    entryTracker: EntryTracker | null;
    entryAges: EntryAgeLedger | null;
    currency: CurrencyPassDeps | null;
    scenarios: ScenarioDeps | null;
    missions: MissionNeeds | null;
    refreshMissionNeeds: (() => Promise<MissionNeeds | null>) | null;
    /** Photos each eligible challenge votes on this cycle for a vote mission; 0 = none. */
    missionVoteQuota: number;
    allChallenges: Challenge[];
    turboSnapshot: number;
};

type FillDeps = ReturnType<typeof buildFillDeps>;

/**
 * Standard cancelled-pass exit shared by every cancellation checkpoint: one
 * warn, close the operation, surface the full active list.
 */
export const cancelPass = (
    allChallenges: Challenge[],
    warning: string = '🛑 Voting cancelled by user',
): VotingPassResult => {
    logger.withCategory('voting').warning(warning, null);
    logger.withCategory('voting').endOperation('voting-process', null, 'Voting cancelled by user');
    return { success: false, message: 'Voting cancelled by user', challenges: allChallenges };
};
