/**
 * The manual single join, on the user's explicit request. A paid challenge needs
 * explicit paid consent (`spendCoins`): without it nothing is spent and the cost
 * is returned as `needs-confirm`. The live candidate and balance are re-read, so
 * a stale renderer list cannot trigger a wasted spend. A paid challenge whose coins
 * were already spent (an unlock marker, left by a join whose submit failed) is only
 * submitted: no consent to a price and no balance check, and nothing is charged.
 */

import { errorMessage } from '../../errorMessage';
import { cat } from './shared';
import type { JoinDeps, JoinSingleResult } from './shared';
import { performJoin } from './performJoin';
import { isUnlocked, markerOwner, paidOwnerUnknown } from './unlockMarker';

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
 * What an id the live open list does not hold is: `not-started` when a live look at the upcoming
 * challenges names it (nothing is unlocked or submitted), and `unavailable` when that look does not
 * (joined already, or closed) or itself fails. A live call, not a
 * remembered list, so it holds in a fresh process and never calls a challenge that has since
 * started or been joined "not started".
 */
const notOpenResult = async (
    challengeId: string | number,
    token: string,
    deps: JoinDeps,
): Promise<JoinSingleResult> => {
    let upcoming;
    try {
        upcoming = await deps.getMemberChallenges(token, 'upcoming');
    } catch (error) {
        cat().warning(`could not list upcoming challenges: ${errorMessage(error) || error}`, null);
        return { status: 'unavailable', challengeId, cost: 0 };
    }
    if (upcoming === null) return { status: 'unavailable', challengeId, cost: 0 };
    const isUpcoming = upcoming.some((c) => String(c?.id) === String(challengeId));
    return { status: isUpcoming ? 'not-started' : 'unavailable', challengeId, cost: 0 };
};

/**
 * Join ONE challenge by id, on user request. The `autoJoinWithinHoursOfEnd`
 * window deliberately does NOT apply here — it defers the AUTOMATIC pass, and an
 * explicit click is the user overriding that timing on purpose.
 *
 * Re-fetches the live candidate so a
 * stale/closed entry in the renderer's cached list cannot trigger a wasted
 * spend. A paid challenge without `spendCoins` returns `needs-confirm` (with the
 * cost) and spends nothing; so does one whose live cost is above `expectedCost`, the
 * cost the caller's confirmation named (a price that rose since then is not consented to).
 * A paid challenge with an unlock marker skips both of those and the balance check: it is
 * submitted alone (`performJoin` re-reads the marker and refuses to unlock if it is gone).
 */
const joinChallengeSingle = async (
    challengeId: string | number,
    token: string,
    deps: JoinDeps,
    { spendCoins = false, expectedCost }: { spendCoins?: boolean; expectedCost?: number } = {},
): Promise<JoinSingleResult> => {
    if (!token) return { status: 'not-authenticated', challengeId, cost: 0 };

    let candidates;
    try {
        candidates = await deps.getMemberChallenges(token, 'open');
    } catch (error) {
        cat().warning(`could not list open challenges: ${errorMessage(error) || error}`, null);
        return { status: 'fetch-failed', challengeId, cost: 0 };
    }
    if (candidates === null) return { status: 'fetch-failed', challengeId, cost: 0 };
    const challenge = candidates.find((c) => String(c?.id) === String(challengeId));
    if (!challenge) return notOpenResult(challengeId, token, deps);

    const rawCost = Number(challenge.join_coins);
    const cost = Number.isFinite(rawCost) && rawCost > 0 ? rawCost : 0;

    // A paid join of an account that cannot be identified does nothing paid: whose coins a marker holds
    // is unknown, and no marker could be written for it.
    const owner = cost > 0 ? await markerOwner(token, deps) : null;
    if (cost > 0 && paidOwnerUnknown(deps, owner)) {
        cat().warning(`challenge ${challengeId}: the account could not be identified — not joining`, null);
        return { status: 'failed-no-charge', challengeId, cost, reason: 'account-unknown' };
    }

    // Coins already spent (an unlock marker, left by a join whose submit failed) are not spent again:
    // the retry only submits, so neither consent to a price nor the balance has a say in it. An
    // unreadable marker file reads as "no marker" here, as in performJoin, whose paid path then refuses.
    const retryOnly = cost > 0 && isUnlocked(deps.joinStateStore, challengeId, owner);

    // Consent covers a price: a cost above the one the caller confirmed (`expectedCost`) needs a new
    // confirmation, with the live cost, and unlocks nothing.
    if (!retryOnly && cost > 0 && (!spendCoins || (expectedCost !== undefined && cost > expectedCost))) {
        return { status: 'needs-confirm', challengeId, cost };
    }

    if (!retryOnly && cost > 0) {
        const refusal = await checkAffordable(challengeId, cost, token, deps);
        if (refusal) return refusal;
    }

    // An explicit click auto-picks even with Submit Only Chosen Photos on.
    const outcome = await performJoin(challenge, token, deps, cost, { manual: true, submitOnly: retryOnly });
    return { status: outcome.status, challengeId, cost, imageId: outcome.imageId, reason: outcome.reason };
};

export { joinChallengeSingle };
