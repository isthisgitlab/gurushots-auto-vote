/**
 * The manual single join.
 */

import { errorMessage } from '../../errorMessage';
import { cat } from './shared';
import type { JoinDeps, JoinSingleResult } from './shared';
import { performJoin } from './performJoin';

// ---- manual single join (explicit paid consent) ----

/**
 * Live balance check for a confirmed paid manual join.
 *
 *   the refusal result, or null when the balance covers the cost
 */
const checkAffordable = async (
    challengeId: string | number,
    cost: number,
    token: string,
    deps: JoinDeps,
): Promise<JoinSingleResult | null> => {
    const bankroll = await deps.getBankroll(token);
    const coins = Number(bankroll?.coins);
    if (bankroll == null || !Number.isFinite(coins)) {
        return { status: 'balance-unknown', challengeId, cost };
    }
    if (coins < cost) {
        return { status: 'skipped-unaffordable', challengeId, cost, coins };
    }
    return null;
};

/**
 * Join ONE challenge by id, on user request. The `autoJoinWithinHoursOfEnd`
 * window deliberately does NOT apply here — it defers the AUTOMATIC pass, and an
 * explicit click is the user overriding that timing on purpose.
 *
 * Re-fetches the live candidate so a
 * stale/closed entry in the renderer's cached list cannot trigger a wasted
 * spend. A paid challenge without `spendCoins` returns `needs-confirm` (with the
 * cost) and spends nothing.
 */
const joinChallengeSingle = async (
    challengeId: string | number,
    token: string,
    deps: JoinDeps,
    { spendCoins = false }: { spendCoins?: boolean } = {},
): Promise<JoinSingleResult> => {
    if (!token) return { status: 'not-authenticated', challengeId, cost: 0 };

    let candidates;
    try {
        candidates = await deps.getMemberChallenges(token, 'open');
    } catch (error) {
        cat().warning(`could not list open challenges: ${errorMessage(error) || error}`, null);
        return { status: 'fetch-failed', challengeId, cost: 0 };
    }
    const challenge = (candidates || []).find((c) => String(c?.id) === String(challengeId));
    if (!challenge) {
        // Not in the open list any more — already joined, or closed.
        return { status: 'unavailable', challengeId, cost: 0 };
    }

    const rawCost = Number(challenge.join_coins);
    const cost = Number.isFinite(rawCost) && rawCost > 0 ? rawCost : 0;

    if (cost > 0 && !spendCoins) {
        return { status: 'needs-confirm', challengeId, cost };
    }

    if (cost > 0) {
        const refusal = await checkAffordable(challengeId, cost, token, deps);
        if (refusal) return refusal;
    }

    const outcome = await performJoin(challenge, token, deps, cost);
    return { status: outcome.status, challengeId, cost, imageId: outcome.imageId };
};

export { joinChallengeSingle };
