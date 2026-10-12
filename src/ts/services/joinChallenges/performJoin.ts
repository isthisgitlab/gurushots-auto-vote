/**
 * The join itself, shared by the automatic pass and the manual join.
 *
 * PAID-SPEND SAFETY (do not reorder):
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
 *   4. Budget decrements only after a confirmed unlock (joinPass).
 *   5. Cancellation is honored between candidates (joinPass) and before each
 *      spend.
 */

import * as logger from '../../logger';
import * as cancellation from '../../voting/cancellation';
import type { Challenge } from '../../types/gurushots';
import { cat, inFlight } from './shared';
import type { JoinDeps, JoinOutcome, UnlockState } from './shared';
import {
    clearUnlocked,
    hasMarker,
    isUnlocked,
    markUnlocked,
    markerOwner,
    paidOwnerUnknown,
    readUnlockedState,
} from './unlockMarker';
import { pickJoinPhoto } from './photoPick';

const failedNoCharge = (): JoinOutcome => ({ status: 'failed-no-charge', charged: 0 });

/**
 * The check→claim→unlock section, run under the cross-process lock. Re-reads
 * the unlock claim authoritatively — another process may have unlocked between
 * the caller's first check and acquiring the lock.
 *
 *   `outcome` ends the join with that result; otherwise the unlock state the
 *   submit continues from.
 */
const claimAndUnlock = async (
    challenge: Challenge,
    token: string,
    deps: JoinDeps,
    needsCoins: number,
    owner: string | null,
): Promise<{ outcome: JoinOutcome } | UnlockState> => {
    const id = challenge?.id;
    const { state, ok: stateOk } = readUnlockedState(deps.joinStateStore);
    if (!stateOk) {
        // Cannot verify prior unlocks → refuse to spend (a re-charge
        // is worse than skipping this candidate this cycle).
        cat().error(`${logger.challengeTag(challenge)}: join-state is unreadable — not spending coins`, null);
        return { outcome: failedNoCharge() };
    }
    if (hasMarker(state, id, owner)) {
        return { charged: 0, alreadyUnlocked: true }; // another process already paid → retry submit only
    }
    if (cancellation.isCancelled()) return { outcome: failedNoCharge() };
    // Persist the claim BEFORE spending, so a crash the instant
    // after the charge can never let a later pass re-unlock. If
    // the claim cannot be recorded, do not spend at all.
    if (!markUnlocked(deps.joinStateStore, id, owner)) {
        cat().error(`${logger.challengeTag(challenge)}: could not record the unlock claim — not spending coins`, null);
        return { outcome: failedNoCharge() };
    }
    const unlock = await deps.coinsUnlock(id, token);
    if (!unlock?.ok) {
        clearUnlocked(deps.joinStateStore, id, owner);
        cat().warning(`coins_unlock failed for ${logger.challengeTag(challenge)} — no coins charged`, null);
        return { outcome: failedNoCharge() };
    }
    return { charged: needsCoins, alreadyUnlocked: false };
};

/**
 * Paid unlock, wrapped in the cross-process lock around the check→claim→unlock
 * section so a concurrent process (GUI auto-join vs CLI join) cannot both unlock.
 */
const unlockUnderLock = async (
    challenge: Challenge,
    token: string,
    deps: JoinDeps,
    needsCoins: number,
    owner: string | null,
): ReturnType<typeof claimAndUnlock> => {
    const id = challenge?.id;
    const xlock = deps.acquireUnlockLock ? deps.acquireUnlockLock(id) : { ok: true, release: () => {} };
    if (!xlock.ok) {
        return { outcome: { status: 'busy', charged: 0 } };
    }
    try {
        return await claimAndUnlock(challenge, token, deps, needsCoins, owner);
    } finally {
        xlock.release();
    }
};

/**
 * Submit the photo (the actual join).
 *
 * @param unlock - coins spent this
 *   call, and whether a prior pass/process already unlocked
 */
const submitJoin = async (
    challenge: Challenge,
    token: string,
    deps: JoinDeps,
    needsCoins: number,
    imageId: string,
    { charged, alreadyUnlocked }: UnlockState,
    owner: string | null,
): Promise<JoinOutcome> => {
    const id = challenge?.id;
    const coinsSpent = charged > 0 || alreadyUnlocked;
    // If cancelled now and coins are already spent (this call or a prior
    // cycle), report pending-submit — not "no charge", which would misinform
    // the user about money spent.
    if (cancellation.isCancelled()) {
        return coinsSpent ? { status: 'charged-pending-submit', charged } : failedNoCharge();
    }
    const submit = await deps.submitToChallenge(id, [imageId], token);
    if (submit?.ok) {
        // Only the coins this join spent are its to clear: a free join must not delete a marker that is
        // another account's (a bare one from before accounts were told apart), or its owner is charged twice.
        if (needsCoins > 0 && coinsSpent) clearUnlocked(deps.joinStateStore, id, owner);
        cat().success(
            `joined ${logger.challengeTag(challenge)}${needsCoins > 0 ? ` (spent ${needsCoins} coins)` : ''}`,
            null,
        );
        return { status: 'joined', charged, imageId };
    }

    // Submit failed. If we (or a prior pass) unlocked, coins are gone — keep
    // the marker so the next attempt retries submit only, never re-charges.
    if (needsCoins > 0 && coinsSpent) {
        cat().error(
            `${logger.challengeTag(challenge)}: coins were charged but the join did not complete — will retry the submit, not re-unlock`,
            null,
        );
        return { status: 'charged-pending-submit', charged };
    }
    return failedNoCharge();
};

/**
 * Perform one join under the safety model. Assumes the decision to join (and,
 * for paid, the consent/affordability) has already been made by the caller.
 *
 * @param needsCoins paid cost (0 = free)
 * @param options.manual the user asked for this join: Submit Only Chosen Photos
 *   does not apply (the call site says so, never the renderer)
 * @param options.submitOnly the caller saw an unlock marker and skipped the price and balance checks
 *   on that account: if this call's own read of the marker finds none (another process cleared it,
 *   or the file is unreadable) nothing is unlocked — a charge nobody consented to
 *
 * status ∈ joined | skipped-no-photo | skipped-no-chosen |
 *            charged-pending-submit | failed-no-charge | busy.
 *   `charged` is coins spent THIS call.
 */
const performJoin = async (
    challenge: Challenge,
    token: string,
    deps: JoinDeps,
    needsCoins: number,
    { manual = false, submitOnly = false }: { manual?: boolean; submitOnly?: boolean } = {},
): Promise<JoinOutcome> => {
    const id = challenge?.id;
    const key = String(id);
    if (inFlight.has(key)) {
        return { status: 'busy', charged: 0 };
    }
    inFlight.add(key);
    try {
        // The unlock claim is read BEFORE picking: a join whose coins are already
        // spent must submit something, so Submit Only Chosen Photos is lifted for
        // it — stranding paid coins behind a skipped pick would be worse than an
        // automatic photo.
        const owner = await markerOwner(token, deps);
        if (needsCoins > 0 && paidOwnerUnknown(deps, owner)) {
            cat().warning(
                `${logger.challengeTag(challenge)}: the account could not be identified — not joining a paid challenge`,
                null,
            );
            return failedNoCharge();
        }
        let unlock = { charged: 0, alreadyUnlocked: isUnlocked(deps.joinStateStore, id, owner) };
        if (submitOnly && !unlock.alreadyUnlocked) {
            cat().warning(
                `${logger.challengeTag(challenge)}: the unlock marker is gone — not unlocking without consent`,
                null,
            );
            return failedNoCharge();
        }

        // 1. Photo first — no photo, no spend.
        const pick = await pickJoinPhoto(challenge, token, deps, {
            ignoreChosenOnly: manual || unlock.alreadyUnlocked,
        });
        const imageId = pick.id;
        if (!imageId) {
            // Coins spent earlier are still owed their join: not "no coins were charged", and the marker stays.
            if (unlock.alreadyUnlocked && needsCoins > 0) {
                return { status: 'charged-pending-submit', charged: 0, reason: 'no-photo' };
            }
            return { status: pick.reason === 'no-chosen' ? 'skipped-no-chosen' : 'skipped-no-photo', charged: 0 };
        }

        // 2. Paid unlock (skipped when a prior pass already unlocked → retry submit only).
        if (needsCoins > 0 && !unlock.alreadyUnlocked) {
            const claimed = await unlockUnderLock(challenge, token, deps, needsCoins, owner);
            if ('outcome' in claimed) return claimed.outcome;
            unlock = claimed;
        }

        // 3. Submit the photo (the actual join).
        return await submitJoin(challenge, token, deps, needsCoins, imageId, unlock, owner);
    } finally {
        inFlight.delete(key);
    }
};

export { performJoin };
