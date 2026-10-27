/**
 * The join itself, shared by the automatic pass and the manual join.
 *
 * PAID-SPEND SAFETY (do not reorder):
 *   1. Photo-first: resolve an eligible photo BEFORE any coins_unlock. No
 *      photo ⇒ skip the candidate, never spend.
 *   2. Idempotency: the unlock claim is persisted (joinStateStore) BEFORE
 *      coins_unlock is called, and kept (marked joined) after a successful submit, so a process that read the open
 *      list earlier finds it and never unlocks a joined challenge again. A crash
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
import { sanitizeLogString } from '../../logger/sanitize';
import { isValidId } from '../../ids';
import { cat, inFlight, lockFor } from './shared';
import type { Claim, JoinDeps, JoinOutcome, UnlockState } from './shared';
import { alreadyJoined, claimsStale, failedNoCharge, unlockUnderLock } from './paidUnlock';
import { claimOf, markJoined } from './unlockMarker';
import { dropChallenge } from '../libraryCache';
import { pickJoinPhoto } from './photoPick';
import type { JoinPick } from './photoPick';

// A pending submit, worded by what is known of the payment: an unconfirmed one (the unlock got no answer) says so;
// any other claim is a payment that is known to have been taken.
const pendingOutcome = (claim: Claim | null, charged: number): JoinOutcome => {
    const base = { status: 'charged-pending-submit', charged };
    if (claim?.unconfirmed) {
        // The balance from before the payment is only there for the user to compare with GuruShots.
        const before = claim.coinsBefore === null ? {} : { coinsBefore: claim.coinsBefore };
        return { ...base, reason: 'unconfirmed', ...before };
    }
    return base;
};

/**
 * Marks a claim as joined after a join that used it, under the unlock lock like every other change of a claim (the
 * caller may already hold it). A lock another process holds leaves the claim as it is, which still protects: it is
 * pruned with its challenge.
 */
const markClaimJoined = async (
    deps: JoinDeps,
    id: string | number,
    claim: Claim,
    holdsLock: boolean,
): Promise<void> => {
    if (holdsLock) {
        await markJoined(deps, claim.key);
        return;
    }
    const lock = lockFor(deps, id);
    if (!lock.ok) {
        cat().warning(
            `challenge ${sanitizeLogString(id)}: another process holds the unlock lock — the claim is left as it is`,
            null,
        );
        return;
    }
    try {
        await markJoined(deps, claim.key);
    } finally {
        lock.release();
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
    { charged, alreadyUnlocked, claim }: UnlockState,
    holdsLock: boolean,
): Promise<JoinOutcome> => {
    const id = challenge?.id;
    const coinsSpent = charged > 0 || alreadyUnlocked;
    // If cancelled now and coins are already spent (this call or a prior
    // cycle), report pending-submit — not "no charge", which would misinform
    // the user about money spent.
    if (cancellation.isCancelled()) {
        return needsCoins > 0 && coinsSpent ? pendingOutcome(claim, charged) : failedNoCharge();
    }
    const submit = await deps.submitToChallenge(id, [imageId], token);
    if (submit?.ok) {
        // A paid submit that succeeds proves the unlock was held: the claim it used stays, marked joined,
        // for a process that read the open list before this join.
        if (needsCoins > 0 && claim) await markClaimJoined(deps, id, claim, holdsLock);
        // The photo chooser's listing for it was read before the challenge had this entry.
        dropChallenge(String(id));
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
        return pendingOutcome(claim, charged);
    }
    return failedNoCharge();
};

/**
 * The submit of a join that continues on a claim already held: the claim is read again and the submit made under
 * the unlock lock, so another process (forgetting the payment, say) cannot take the claim away between the two.
 * A claim that is gone by then, or a lock another process holds, submits nothing.
 */
const submitOnClaim = async (
    challenge: Challenge,
    token: string,
    deps: JoinDeps,
    needsCoins: number,
    imageId: string,
): Promise<JoinOutcome> => {
    const lock = lockFor(deps, challenge?.id);
    if (!lock.ok) return { status: 'busy', charged: 0 };
    try {
        if (await claimsStale(challenge, deps, 'submitting')) return failedNoCharge();
        const claim = claimOf(deps.joinStateStore, challenge?.id);
        if (!claim) {
            cat().warning(`${logger.challengeTag(challenge)}: the unlock marker is gone — not submitting`, null);
            return failedNoCharge();
        }
        return (
            alreadyJoined(challenge, claim) ??
            (await submitJoin(
                challenge,
                token,
                deps,
                needsCoins,
                imageId,
                { charged: 0, alreadyUnlocked: true, claim },
                true,
            ))
        );
    } finally {
        lock.release();
    }
};

/**
 * No photo was picked. Coins spent earlier are still owed their join: not "no coins were charged", and the marker
 * stays. Only a library that was read and held nothing is "no photo"; a failed read is a failure like any other,
 * and retrying is what helps.
 */
const noPhotoOutcome = (reason: JoinPick['reason'], owedClaim: Claim | null): JoinOutcome => {
    if (owedClaim) {
        // A payment that may not have happened is what the user is told about first.
        if (owedClaim.unconfirmed) return pendingOutcome(owedClaim, 0);
        return reason === 'unreadable'
            ? pendingOutcome(owedClaim, 0)
            : { status: 'charged-pending-submit', charged: 0, reason: 'no-photo' };
    }
    return { status: reason === 'no-chosen' ? 'skipped-no-chosen' : 'skipped-no-photo', charged: 0 };
};

/**
 * Perform one join under the safety model. Assumes the decision to join (and,
 * for paid, the consent/affordability) has already been made by the caller.
 *
 * @param needsCoins paid cost (0 = free)
 * @param options.manual the user asked for this join: Submit Only Chosen Photos
 *   does not apply (the call site says so, never the renderer)
 * @param options.coinsBefore the balance the caller already had, kept in the claim for the user to compare with
 *   GuruShots if the unlock gets no answer; nothing decides on it, and it costs no request
 * @param options.priceCeiling the price the decision to join used (the automatic pass): the open list is read again
 *   right before the claim, and a price above it, or one that cannot be read, spends nothing
 * @param options.submitOnly the caller saw an unlock marker and skipped the price and balance checks
 *   on it: if this call's own read of the marker finds none (another process cleared it,
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
    {
        manual = false,
        submitOnly = false,
        coinsBefore = null,
        priceCeiling,
    }: { manual?: boolean; submitOnly?: boolean; coinsBefore?: number | null; priceCeiling?: number } = {},
): Promise<JoinOutcome> => {
    const id = challenge?.id;
    // An open-list row with an unusable id joins nothing: String(id) would key the in-flight set, the
    // claim and the cross-process lock on "undefined". The row is server-controlled, so the line names
    // it through the sanitized tag, never by printing it. Before any lock, claim or request.
    if (!isValidId(id)) {
        cat().warningT('me63c0d7b952a', [logger.challengeTag(challenge)], null);
        return failedNoCharge();
    }
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
        if (needsCoins > 0 && (await claimsStale(challenge, deps, 'joining a paid challenge'))) return failedNoCharge();
        const claim = claimOf(deps.joinStateStore, id);
        const joined = needsCoins > 0 ? alreadyJoined(challenge, claim) : null;
        if (joined) return joined;
        let unlock: UnlockState = { charged: 0, alreadyUnlocked: claim !== null, claim };
        if (submitOnly && !unlock.alreadyUnlocked) {
            cat().warning(
                `${logger.challengeTag(challenge)}: the unlock marker is gone — not unlocking without consent`,
                null,
            );
            return failedNoCharge();
        }

        // 1. Photo first — no photo, no spend.
        const pick = await pickJoinPhoto(challenge, token, deps, {
            ignoreChosenOnly: manual || (unlock.alreadyUnlocked && needsCoins > 0),
        });
        const imageId = pick.id;
        if (!imageId) return noPhotoOutcome(pick.reason, needsCoins > 0 ? unlock.claim : null);

        // 2. Paid unlock (skipped when a prior pass already unlocked → retry submit only).
        if (needsCoins > 0 && !unlock.alreadyUnlocked) {
            const claimed = await unlockUnderLock(challenge, token, deps, needsCoins, coinsBefore, priceCeiling);
            if ('outcome' in claimed) return claimed.outcome;
            unlock = claimed;
        }

        // 3. Submit the photo (the actual join).
        if (needsCoins > 0 && unlock.alreadyUnlocked) {
            return await submitOnClaim(challenge, token, deps, needsCoins, imageId);
        }
        return await submitJoin(challenge, token, deps, needsCoins, imageId, unlock, false);
    } finally {
        inFlight.delete(key);
    }
};

export { performJoin };
