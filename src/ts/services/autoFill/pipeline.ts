/**
 * Auto-fill — the shared fill pipeline: load and score candidates, enrich the
 * contested ones, visually verify the pick, and submit (runFillAttempt), plus
 * the submit-free ranking the swap flow uses (rankCandidatesForChallenge).
 */

export { rankCandidatesForChallenge } from './pipeline/rank';
export { runFillAttempt } from './pipeline/attempt';
