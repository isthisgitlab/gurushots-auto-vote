/**
 * Why a join ended as it did, where its status alone would mislead:
 *   no-photo        — coins were spent earlier, but no photo qualifies to finish the join with
 *   account-unknown — a paid join could not tell which account is logged in, and did nothing
 *                     (this attempt spent no coins)
 *   unconfirmed     — the payment got no answer (or its owner is unknown), so it may or may not have gone
 *                     through; the join only retries the submit and never pays on that claim again
 */
type JoinReason = 'no-photo' | 'account-unknown' | 'unconfirmed';

export type { JoinReason };
