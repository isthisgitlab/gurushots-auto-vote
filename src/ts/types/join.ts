/**
 * Why a join ended as it did, where its status alone would mislead:
 *   no-photo        — coins were spent earlier, but no photo qualifies to finish the join with
 *   account-unknown — a paid join could not tell which account is logged in, and did nothing
 *                     (this attempt spent no coins)
 *   unconfirmed     — the payment got no answer, so it may or may not have gone through; the join only
 *                     retries the submit and never pays on that claim again
 *   earlier-payment — a payment record from before accounts were told apart, whose owner is unknown; the join
 *                     only retries the submit with it
 *   already-joined  — this account has already joined the challenge (its claim says so); nothing was spent
 *   full            — the challenge has no free player slots left (its `max_players` is reached), so a fresh
 *                     join was not attempted; nothing was spent
 *   price-unknown   — the challenge still needs a paid unlock but its price could not be read, so no consent
 *                     was possible; nothing was unlocked or spent
 */
type JoinReason =
    | 'no-photo'
    | 'account-unknown'
    | 'unconfirmed'
    | 'earlier-payment'
    | 'already-joined'
    | 'full'
    | 'price-unknown';

/**
 * What forgetting a payment came to:
 *   forgotten         — the unconfirmed claim of this account for the challenge is gone
 *   nothing-to-forget — there is none, or it is a confirmed one (never forgotten)
 *   legacy-record     — only a record from an older version, which is never forgotten (it may be another account's)
 *   busy              — a join of the challenge is under way, or the claims file is locked by another process
 *   unreadable        — the claims file cannot be read or written, so nothing was changed
 *   locks-unavailable — the app cannot create its lock files in its data folder, so nothing was changed
 *   account-unknown   — the account could not be told, so nothing was changed
 *   not-authenticated — nobody is logged in
 */
type ForgetStatus =
    | 'forgotten'
    | 'nothing-to-forget'
    | 'legacy-record'
    | 'busy'
    | 'unreadable'
    | 'locks-unavailable'
    | 'account-unknown'
    | 'not-authenticated';

export type { JoinReason, ForgetStatus };
