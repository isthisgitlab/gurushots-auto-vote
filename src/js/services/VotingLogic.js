// @ts-check
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
 *   thresholds.js       exposure triggers/targets, final-window and last-minute
 *                       windows, boost/turbo timing windows
 *   triggerWindows.js   scheduled-fill and voting-pause window state
 *   boostPrefill.js     pre-boost fill window state
 *   ruleEngine.js       the shared rule engine (_runVotingRules)
 *   voteDecisions.js    auto/manual vote evaluators
 *   entryPick.js        boost/turbo entry selection and boost fill-new mode
 *   boostTurbo.js       boost/turbo apply decisions, Emergency Fill override
 *   deadlineActions.js  deadline-action thresholds, ordering and description
 *   joinDecision.js     pure auto-join decision
 */

const { resolveEntryIndex } = require('../voting/entrySlot');
const thresholds = require('./decisions/thresholds');
const { getScheduledFillState, getVotingPauseState } = require('./decisions/triggerWindows');
const { getBoostPrefillState } = require('./decisions/boostPrefill');
const voteDecisions = require('./decisions/voteDecisions');
const entryPick = require('./decisions/entryPick');
const boostTurbo = require('./decisions/boostTurbo');
const deadlineActions = require('./decisions/deadlineActions');
const { shouldJoinChallenge, resolveJoinWindow } = require('./decisions/joinDecision');

/** @typedef {import('./decisions/ruleEngine').VotingRuleResult} VotingRuleResult */
/** @typedef {import('./decisions/voteDecisions').AutoVoteDecision} AutoVoteDecision */
/** @typedef {import('./decisions/voteDecisions').ManualVoteDecision} ManualVoteDecision */
/** @typedef {import('./decisions/boostTurbo').TurboDecision} TurboDecision */

module.exports = {
    shouldJoinChallenge,
    resolveJoinWindow,
    isWithinFinalWindow: thresholds.isWithinFinalWindow,
    isWithinLastMinuteThreshold: thresholds.isWithinLastMinuteThreshold,
    getEffectiveExposureThreshold: thresholds.getEffectiveExposureThreshold,
    getEffectiveFinalWindowExposureThreshold: thresholds.getEffectiveFinalWindowExposureThreshold,
    getEffectiveExposureTarget: thresholds.getEffectiveExposureTarget,
    getEffectiveFinalWindowExposureTarget: thresholds.getEffectiveFinalWindowExposureTarget,
    getScheduledFillState,
    getVotingPauseState,
    getBoostPrefillState,
    evaluateVotingDecision: voteDecisions.evaluateVotingDecision,
    evaluateManualVotingDecision: voteDecisions.evaluateManualVotingDecision,
    evaluateManualVotingToHundred: voteDecisions.evaluateManualVotingToHundred,
    getEffectiveBoostTime: thresholds.getEffectiveBoostTime,
    getEffectiveKeyUnlockedBoostTime: thresholds.getEffectiveKeyUnlockedBoostTime,
    pickBoostEntry: entryPick.pickBoostEntry,
    resolveBoostFillNewMode: entryPick.resolveBoostFillNewMode,
    isWithinEmergencyWindow: boostTurbo.isWithinEmergencyWindow,
    shouldApplyBoost: boostTurbo.shouldApplyBoost,
    isBoostWindowOpen: boostTurbo.isBoostWindowOpen,
    getEffectiveTurboTime: thresholds.getEffectiveTurboTime,
    shouldPlayAutoTurbo: boostTurbo.shouldPlayAutoTurbo,
    shouldApplyTurbo: boostTurbo.shouldApplyTurbo,
    resolveEntryIndex,
    pickEntryAvoidingConflict: entryPick.pickEntryAvoidingConflict,
    getAutoFillThresholdSec: deadlineActions.getAutoFillThresholdSec,
    getEmergencyFillThresholdSec: deadlineActions.getEmergencyFillThresholdSec,
    getBoostThresholdSec: deadlineActions.getBoostThresholdSec,
    orderDeadlineActions: deadlineActions.orderDeadlineActions,
    describeDeadlineActions: deadlineActions.describeDeadlineActions,
};
