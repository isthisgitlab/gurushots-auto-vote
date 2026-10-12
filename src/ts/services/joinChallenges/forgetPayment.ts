/**
 * The user's way out of a payment that cannot be confirmed: forget the claim, so the next join of the challenge
 * asks for its price like any first one. Nothing settles an unconfirmed claim by itself — only a paid submit that
 * used it, or this explicit act, ends it — so this is the one place a claim of coins that may have been taken is
 * deleted on the user's word.
 */

import { cat, inFlight } from './shared';
import type { JoinDeps } from './shared';
import { forgetClaim, markerOwner, paidOwnerUnknown } from './unlockMarker';

type ForgetOutcome = {
    status: 'forgotten' | 'nothing-to-forget' | 'busy' | 'account-unknown' | 'unreadable' | 'not-authenticated';
    challengeId: string | number;
};

/**
 * Forgets this account's claim for the challenge, under the same cross-process lock the unlock takes, re-reading
 * the store under it. Only a claim that is still unconfirmed, or a bare one from before accounts were told apart;
 * never one known to have been charged. Refuses when the account cannot be told or the file cannot be read.
 */
const forgetUnconfirmedPayment = async (
    challengeId: string | number,
    token: string,
    deps: JoinDeps,
): Promise<ForgetOutcome> => {
    if (!token) return { status: 'not-authenticated', challengeId };
    const owner = await markerOwner(token, deps);
    if (paidOwnerUnknown(deps, owner)) {
        cat().warning(
            `challenge ${challengeId}: the account could not be identified — not forgetting the payment`,
            null,
        );
        return { status: 'account-unknown', challengeId };
    }
    // A join of this challenge under way holds its claim: it is not the user's to forget until it ends.
    if (inFlight.has(String(challengeId))) return { status: 'busy', challengeId };
    const lock = deps.acquireUnlockLock ? deps.acquireUnlockLock(challengeId) : { ok: true, release: () => {} };
    if (!lock.ok) return { status: 'busy', challengeId };
    try {
        const status = forgetClaim(deps.joinStateStore, challengeId, owner);
        if (status === 'forgotten') cat().info(`challenge ${challengeId}: the unconfirmed payment was forgotten`, null);
        return { status, challengeId };
    } finally {
        lock.release();
    }
};

export type { ForgetOutcome };
export { forgetUnconfirmedPayment };
