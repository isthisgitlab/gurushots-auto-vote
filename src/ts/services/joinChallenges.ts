/**
 * GuruShots Auto Voter - Join Challenges Service
 *
 * Discovers un-joined ("open") challenges and joins them — free or paid —
 * reusing auto-fill's photo picker to choose the entry photo. Shared by the
 * automatic per-cycle pass (runJoinPass, wired into fetchChallengesAndVote so
 * GUI, CLI and Android all run it) and the manual single-join path
 * (joinChallengeSingle, behind an explicit paid confirmation).
 *
 * PAID-SPEND SAFETY (see the plan's safety model — do not reorder):
 *   1. Photo-first: resolve an eligible photo BEFORE any coins_unlock. No
 *      photo ⇒ skip the candidate, never spend.
 *   2. Idempotency: the unlock claim is persisted (joinStateStore) BEFORE
 *      coins_unlock is called, and only cleared on a successful submit. A crash
 *      the instant after the charge still leaves the claim on disk, so a later
 *      pass retries submit ONLY — it never re-unlocks (re-charges). If the claim
 *      cannot be written, no coins are spent.
 *   3. In-flight lock: a module-level Set stops a manual click racing the cycle
 *      pass (or itself) into a second coins_unlock WITHIN this process; a
 *      cross-process lockfile (deps.acquireUnlockLock) covers the same race
 *      across processes on real-fs platforms (GUI auto-join vs CLI `join --yes`
 *      on one account). The unlock claim is re-read authoritatively under that
 *      lock, and a corrupt/unreadable join-state refuses the spend (fail-safe).
 *   4. Budget decrements only after a confirmed unlock.
 *   5. Cancellation is honored between candidates and before each spend.
 *
 * deps (injected by strategies/real/index.ts real / mock/strategy.ts mock):
 *   { getMemberChallenges, getBankroll, coinsUnlock, submitToChallenge,
 *     getEligiblePhotos, joinStateStore, acquireUnlockLock } — joinStateStore is
 *   null and acquireUnlockLock absent in mock (no real state touched, mirroring
 *   cleanupStaleMetadata:null).
 */

export { inFlight } from './joinChallenges/shared';
export type { JoinDeps } from './joinChallenges/shared';
export { isAutoJoinActive, resolveJoinSetting } from './joinChallenges/settingsResolution';
export { performJoin } from './joinChallenges/performJoin';
export { runJoinPass } from './joinChallenges/joinPass';
export { joinChallengeSingle } from './joinChallenges/manualJoin';
