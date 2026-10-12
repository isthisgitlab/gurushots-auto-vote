/**
 * Why a join ended as it did, where its status alone would mislead:
 *   no-photo        — coins were spent earlier, but no photo qualifies to finish the join with
 *   account-unknown — a paid join could not tell which account is logged in, and did nothing
 *                     (this attempt spent no coins)
 *   unconfirmed     — the payment got no answer, so it may or may not have gone through; the join only
 *                     retries the submit and never pays on that claim again
 *   earlier-payment — a payment record from before accounts were told apart, whose owner is unknown; the join
 *                     only retries the submit with it
 */
type JoinReason = 'no-photo' | 'account-unknown' | 'unconfirmed' | 'earlier-payment';

export type { JoinReason };
