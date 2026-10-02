/**
 * The join itself, shared by the pass and the manual join.
 */

import * as logger from '../../logger';
import * as cancellation from '../../voting/cancellation';
import type { Challenge } from '../../types/gurushots';
import { cat, inFlight } from './shared';
import type { JoinDeps, JoinOutcome, UnlockState } from './shared';
import { clearUnlocked, isUnlocked, markUnlocked, readUnlockedState } from './unlockMarker';
import { pickJoinPhoto } from './photoPick';

// ---- the join itself (shared by pass + manual) ----

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
): Promise<{ outcome: JoinOutcome } | UnlockState> => {
    const id = challenge?.id;
    const { state, ok: stateOk } = readUnlockedState(deps.joinStateStore);
    if (!stateOk) {
        // Cannot verify prior unlocks → refuse to spend (a re-charge
        // is worse than skipping this candidate this cycle).
        cat().error(`${logger.challengeTag(challenge)}: join-state is unreadable — not spending coins`, null);
        return { outcome: failedNoCharge() };
    }
    if (Object.prototype.hasOwnProperty.call(state, String(id))) {
        return { charged: 0, alreadyUnlocked: true }; // another process already paid → retry submit only
    }
    if (cancellation.isCancelled()) return { outcome: failedNoCharge() };
    // Persist the claim BEFORE spending, so a crash the instant
    // after the charge can never let a later pass re-unlock. If
    // the claim cannot be recorded, do not spend at all.
    if (!markUnlocked(deps.joinStateStore, id)) {
        cat().error(`${logger.challengeTag(challenge)}: could not record the unlock claim — not spending coins`, null);
        return { outcome: failedNoCharge() };
    }
    const unlock = await deps.coinsUnlock(id, token);
    if (!unlock?.ok) {
        clearUnlocked(deps.joinStateStore, id);
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
): ReturnType<typeof claimAndUnlock> => {
    const id = challenge?.id;
    const xlock = deps.acquireUnlockLock ? deps.acquireUnlockLock(id) : { ok: true, release: () => {} };
    if (!xlock.ok) {
        return { outcome: { status: 'busy', charged: 0 } };
    }
    try {
        return await claimAndUnlock(challenge, token, deps, needsCoins);
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
        clearUnlocked(deps.joinStateStore, id);
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
 *   status ∈ joined | skipped-no-photo | charged-pending-submit |
 *            failed-no-charge | busy. `charged` is coins spent THIS call.
 */
const performJoin = async (
    challenge: Challenge,
    token: string,
    deps: JoinDeps,
    needsCoins: number,
): Promise<JoinOutcome> => {
    const id = challenge?.id;
    const key = String(id);
    if (inFlight.has(key)) {
        return { status: 'busy', charged: 0 };
    }
    inFlight.add(key);
    try {
        // 1. Photo first — no photo, no spend.
        const imageId = await pickJoinPhoto(challenge, token, deps);
        if (!imageId) {
            return { status: 'skipped-no-photo', charged: 0 };
        }

        let unlock = { charged: 0, alreadyUnlocked: isUnlocked(deps.joinStateStore, id) };

        // 2. Paid unlock (skipped when a prior pass already unlocked → retry submit only).
        if (needsCoins > 0 && !unlock.alreadyUnlocked) {
            const claimed = await unlockUnderLock(challenge, token, deps, needsCoins);
            if ('outcome' in claimed) return claimed.outcome;
            unlock = claimed;
        }

        // 3. Submit the photo (the actual join).
        return await submitJoin(challenge, token, deps, needsCoins, imageId, unlock);
    } finally {
        inFlight.delete(key);
    }
};

export { performJoin };
