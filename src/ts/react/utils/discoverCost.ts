import type { Challenge, OpenChallenge } from '../../types/gurushots';

/** What a row costs to join: its `join_coins` as a positive number, else 0 (free). */
export const costOf = (c: Challenge): number => {
    const n = Number(c?.join_coins);
    return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * The row to confirm when a join that was not meant to spend answered `needs-confirm` for a paid
 * row: the row at the cost the answer named (the listed cost when it named none). Null for any
 * other answer, which is the outcome of the join as it stands.
 */
export const rowToConfirm = (
    c: OpenChallenge,
    spendCoins: boolean,
    res: { status?: string; cost?: number },
): OpenChallenge | null => {
    if (spendCoins || costOf(c) <= 0 || res.status !== 'needs-confirm') return null;
    return { ...c, join_coins: typeof res.cost === 'number' && Number.isFinite(res.cost) ? res.cost : costOf(c) };
};
