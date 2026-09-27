/**
 * Voting Logic Service
 *
 * Centralized business logic for voting decisions.
 * The one home of the voting rules, shared by strategies/real, mock/strategy.js
 * and the Electron main process.
 *
 * Facade — the only module callers import. It re-exports the public surface
 * of the internal ./decisions/* modules:
 *
 *   thresholds.ts       exposure triggers/targets, final-window and last-minute
 *                       windows, boost/turbo timing windows
 *   triggerWindows.ts   scheduled-fill and voting-pause window state
 *   boostPrefill.ts     pre-boost fill window state
 *   ruleEngine.ts       the shared rule engine (_runVotingRules)
 *   voteDecisions.ts    auto/manual vote evaluators
 *   entryPick.ts        boost/turbo entry selection and boost fill-new mode
 *   boostTurbo.ts       boost/turbo apply decisions, Emergency Fill override
 *   deadlineActions.ts  deadline-action thresholds, ordering and description
 *   joinDecision.ts     pure auto-join decision
 */

import { resolveEntryIndex } from '../voting/entrySlot';
import * as thresholds from './decisions/thresholds';
import { getScheduledFillState, getVotingPauseState } from './decisions/triggerWindows';
import { getBoostPrefillState } from './decisions/boostPrefill';
import * as voteDecisions from './decisions/voteDecisions';
import * as entryPick from './decisions/entryPick';
import * as boostTurbo from './decisions/boostTurbo';
import * as deadlineActions from './decisions/deadlineActions';
import { shouldJoinChallenge } from './decisions/joinDecision';

/** @typedef {import('./decisions/ruleEngine').VotingRuleResult} VotingRuleResult */
/** @typedef {import('./decisions/voteDecisions').AutoVoteDecision} AutoVoteDecision */
/** @typedef {import('./decisions/voteDecisions').ManualVoteDecision} ManualVoteDecision */
/** @typedef {import('./decisions/boostTurbo').TurboDecision} TurboDecision */

export const isWithinFinalWindow = thresholds.isWithinFinalWindow;
export const isWithinLastMinuteThreshold = thresholds.isWithinLastMinuteThreshold;
export const getEffectiveExposureTarget = thresholds.getEffectiveExposureTarget;
export const getEffectiveFinalWindowExposureTarget = thresholds.getEffectiveFinalWindowExposureTarget;
export const evaluateVotingDecision = voteDecisions.evaluateVotingDecision;
export const evaluateManualVotingDecision = voteDecisions.evaluateManualVotingDecision;
export const evaluateManualVotingToHundred = voteDecisions.evaluateManualVotingToHundred;
export const getEffectiveBoostTime = thresholds.getEffectiveBoostTime;
export const getEffectiveKeyUnlockedBoostTime = thresholds.getEffectiveKeyUnlockedBoostTime;
export const pickBoostEntry = entryPick.pickBoostEntry;
export const resolveBoostFillNewMode = entryPick.resolveBoostFillNewMode;
export const isWithinEmergencyWindow = boostTurbo.isWithinEmergencyWindow;
export const shouldApplyBoost = boostTurbo.shouldApplyBoost;
export const getBoostHoldUntil = boostTurbo.getBoostHoldUntil;
export const shouldPlayAutoTurbo = boostTurbo.shouldPlayAutoTurbo;
export const isTurboEarnSaved = boostTurbo.isTurboEarnSaved;
export const shouldApplyTurbo = boostTurbo.shouldApplyTurbo;
export const pickEntryAvoidingConflict = entryPick.pickEntryAvoidingConflict;
export const getAutoFillThresholdSec = deadlineActions.getAutoFillThresholdSec;
export const getBoostThresholdSec = deadlineActions.getBoostThresholdSec;
export const orderDeadlineActions = deadlineActions.orderDeadlineActions;
export const describeDeadlineActions = deadlineActions.describeDeadlineActions;
export { shouldJoinChallenge, getScheduledFillState, getVotingPauseState, getBoostPrefillState, resolveEntryIndex };
