// @ts-check
/**
 * GuruShots Auto Voter - Auto-Fill Service
 *
 * Decides when and how to submit photos into challenges that have
 * empty entry slots near their close time.
 *
 * Two entry points:
 *   - maybeAutoFillChallenge: cycle-driven, schedule-based. Fills at most
 *     one slot per call. The user-defined autoFillSchedule (rows of
 *     { count, seconds }) sets the target entry count for the time
 *     remaining: "have ≥ count entries once ≤ seconds remain". With the
 *     default schedule (2 @ 30m, 3 @ 20m, 4 @ 10m) fills land spaced out
 *     before close. Spacing matters because GuruShots' ranking algorithm
 *     dilutes votes per entry when several are submitted simultaneously;
 *     if the app starts behind schedule it catches up one photo per cycle.
 *   - fillChallengeNow: manual, batched. The GUI buttons call this and
 *     it ignores both the autoFill toggle and the schedule; manual
 *     means explicit user intent.
 *
 * API methods are injected so the scheduler (real API) and the IPC
 * handler (apiFactory strategy, may be mocked) can call the same logic
 * without entangling the modules.
 *
 * Facade — the only module callers import. It re-exports the public surface of
 * the internal ./autoFill/* modules:
 *
 *   staggeredFill.js   maybeAutoFillChallenge (cycle-driven, schedule-based)
 *   emergencyFill.js   maybeEmergencyFillChallenge + its shared stand-down check
 *   manualFill.js      fillChallengeNow (GUI "Fill Now")
 *   fillNew.js         submitNewEntryForAction (boost/turbo "fill new")
 *   pipeline.js        the shared fill pipeline and the submit-free ranking
 *   candidates.js      on-theme candidate fetch, ignore words, semantic scores
 *   memberIdentity.js  per-token member id cache for tag resolution
 *   fillLogging.js     submit-failure, fallback and popularity-pick explanations
 *   challengeState.js  entry/slot reads, local reflects, live state refresh
 *   schedule.js        schedule-row validation and threshold math
 */

import { maybeAutoFillChallenge } from './autoFill/staggeredFill';
import { evaluateEmergencyFill, maybeEmergencyFillChallenge } from './autoFill/emergencyFill';
import { fillChallengeNow } from './autoFill/manualFill';
import { submitNewEntryForAction } from './autoFill/fillNew';
import { rankCandidatesForChallenge } from './autoFill/pipeline';
import { resolveSemanticScores, resolveIgnoreWords, fetchCandidatesForChallenge } from './autoFill/candidates';
import { resolveMemberId, __resetMemberIdCache } from './autoFill/memberIdentity';
import { describeSubmitFailure } from './autoFill/fillLogging';
import { getSlotsRemaining, reflectNewEntry, reflectEntryFlag, refreshChallengeState } from './autoFill/challengeState';
import { getEffectiveScheduleRows, resolveScheduleTarget, getNextScheduleThresholdSec } from './autoFill/schedule';

export {
    maybeAutoFillChallenge,
    maybeEmergencyFillChallenge,
    fillChallengeNow,
    submitNewEntryForAction,
    reflectNewEntry,
    reflectEntryFlag,
    resolveScheduleTarget,
    getNextScheduleThresholdSec,
    // Shared with VotingLogic.describeDeadlineActions so the timeline/notify
    // view and this runner cannot drift on when emergency fill does nothing.
    evaluateEmergencyFill,
    // exported for tests
    getEffectiveScheduleRows,
    getSlotsRemaining,
    fetchCandidatesForChallenge,
    rankCandidatesForChallenge,
    resolveMemberId,
    __resetMemberIdCache,
    resolveSemanticScores,
    resolveIgnoreWords,
    describeSubmitFailure,
    refreshChallengeState,
};
