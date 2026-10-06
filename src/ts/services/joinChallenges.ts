/**
 * GuruShots Auto Voter - Join Challenges Service
 *
 * Discovers un-joined ("open") challenges and joins them — free or paid —
 * reusing auto-fill's photo picker to choose the entry photo. Shared by the
 * automatic per-cycle pass (runJoinPass, wired into fetchChallengesAndVote so
 * GUI, CLI and Android all run it) and the manual single-join path
 * (joinChallengeSingle, behind an explicit paid confirmation).
 *
 * The paid-spend safety model lives in ./joinChallenges/performJoin.
 *
 * deps (injected by strategies/real/index.ts real / mock/strategy.ts mock):
 *   { getMemberChallenges, getBankroll, coinsUnlock, submitToChallenge,
 *     getEligiblePhotos, joinStateStore, acquireUnlockLock } — joinStateStore is
 *   null and acquireUnlockLock absent in mock (no real state touched, mirroring
 *   cleanupStaleMetadata:null).
 */

export type { JoinDeps } from './joinChallenges/shared';
export { isAutoJoinActive, resolveJoinSetting } from './joinChallenges/settingsResolution';
export { runJoinPass } from './joinChallenges/joinPass';
export { joinChallengeSingle } from './joinChallenges/manualJoin';

// exported for tests
export { performJoin } from './joinChallenges/performJoin';
export { inFlight } from './joinChallenges/shared';
