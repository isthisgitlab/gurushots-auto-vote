/**
 * The user's way out of a payment that cannot be confirmed: forget the claim, so the next join of the challenge
 * asks for its price like any first one. Nothing settles an unconfirmed claim by itself — only a paid submit that
 * used it, or this explicit act, ends it — so this is the one place a claim of coins that may have been taken is
 * deleted on the user's word. Only this account's own unconfirmed claim: a record from an older version is never
 * forgotten (it may be another account's), and clears by itself.
 */

import { cat, inFlight, lockFor } from './shared';
import type { JoinDeps } from './shared';
import { sanitizeLogString } from '../../logger/sanitize';
import { forgetClaim, markerOwner, paidOwnerUnknown } from './unlockMarker';
import type { ForgetStatus } from '../../types/join';

type ForgetOutcome = { status: ForgetStatus; challengeId: string | number };

/**
 * Forgets this account's claim for the challenge, under the same cross-process lock the unlock takes, re-reading
 * the store under it. Only a claim that is still unconfirmed: never one known to have been charged, and never a
 * bare one from before accounts were told apart (`legacy-record`). Refuses when the account cannot be told, a join
 * of the challenge is under way, or the file cannot be read.
 */
const forgetUnconfirmedPayment = async (
    challengeId: string | number,
    token: string,
    deps: JoinDeps,
): Promise<ForgetOutcome> => {
    if (!token) return { status: 'not-authenticated', challengeId };
    const safe = sanitizeLogString(challengeId);
    const owner = await markerOwner(token, deps);
    if (paidOwnerUnknown(deps, owner)) {
        cat().warning(`challenge ${safe}: the account could not be identified — not forgetting the payment`, null);
        return { status: 'account-unknown', challengeId };
    }
    // A join of this challenge under way holds its claim: it is not the user's to forget until it ends.
    if (inFlight.has(String(challengeId))) return { status: 'busy', challengeId };
    const lock = lockFor(deps, challengeId);
    if (!lock.ok) return { status: 'busy', challengeId };
    try {
        const status = await forgetClaim(deps, challengeId, owner);
        if (status === 'forgotten') cat().info(`challenge ${safe}: the unconfirmed payment was forgotten`, null);
        return { status, challengeId };
    } finally {
        lock.release();
    }
};

export type { ForgetOutcome };
export { forgetUnconfirmedPayment };
