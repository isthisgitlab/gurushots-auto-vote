/**
 * Why a join ended as it did, where its status alone would mislead:
 *   no-photo        — coins were spent earlier, but no photo qualifies to finish the join with
 *   unconfirmed     — the payment got no answer, so it may or may not have gone through; the join only
 *                     retries the submit and never pays on that claim again
 *   already-joined  — the challenge has already been joined (its claim says so); nothing was spent
 *   full            — the challenge has no free player slots left (its `max_players` is reached), so a fresh
 *                     join was not attempted; nothing was spent
 *   price-unknown   — the challenge still needs a paid unlock but its price could not be read, so no consent
 *                     was possible; nothing was unlocked or spent
 */
type JoinReason = 'no-photo' | 'unconfirmed' | 'already-joined' | 'full' | 'price-unknown';

/**
 * What forgetting a payment came to:
 *   forgotten         — the unconfirmed claim for the challenge is gone
 *   nothing-to-forget — there is none, or it is a confirmed one (never forgotten)
 *   busy              — a join of the challenge is under way, or the claims file is locked by another process
 *   unreadable        — the claims file cannot be read or written, so nothing was changed
 *   locks-unavailable — the app cannot create its lock files in its data folder, so nothing was changed
 *   not-authenticated — nobody is logged in
 */
type ForgetStatus =
    | 'forgotten'
    | 'nothing-to-forget'
    | 'busy'
    | 'unreadable'
    | 'locks-unavailable'
    | 'not-authenticated';

export type { JoinReason, ForgetStatus };
