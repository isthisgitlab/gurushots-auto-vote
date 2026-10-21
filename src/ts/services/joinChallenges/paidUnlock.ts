/**
 * The paid half of a join: the claim persisted before coins_unlock, the price read again, and what an unlock that is
 * refused or gets no answer comes to. See performJoin.ts for the paid-spend safety model these steps keep.
 */

import * as logger from '../../logger';
import * as cancellation from '../../voting/cancellation';
import { errorMessage } from '../../errorMessage';
import type { Challenge } from '../../types/gurushots';
import { sanitizeLogString } from '../../logger/sanitize';
import { joinFreshRefusal, joinFreshRefusalWhy } from '../VotingLogic';
import { cat, lockFor } from './shared';
import type { Claim, JoinDeps, JoinOutcome, UnlockState } from './shared';
import {
    clearUnlocked,
    findClaim,
    markUnconfirmed,
    claimUnlock,
    readUnlockedState,
    refreshClaims,
} from './unlockMarker';

const failedNoCharge = (): JoinOutcome => ({ status: 'failed-no-charge', charged: 0 });

/**
 * A claim that is marked joined says the join it was for went through, so nothing may be unlocked or submitted on
 * it: the open list this call started from was read before that join. Null when the claim is not that.
 */
const alreadyJoined = (challenge: Challenge, claim: Claim | null): JoinOutcome | null => {
    if (!claim?.joined) return null;
    cat().debug(`${logger.challengeTag(challenge)}: already joined it — nothing is unlocked`, null);
    return { ...failedNoCharge(), reason: 'already-joined' };
};

// Whether the claims could not be read again (and so may be stale): a paid decision is not made on them.
const claimsStale = async (challenge: Challenge, deps: JoinDeps, doing: string): Promise<boolean> => {
    if (await refreshClaims(deps)) return false;
    cat().warning(
        `${logger.challengeTag(challenge)}: the saved claims could not be read again — not ${doing} — try again in a moment`,
        null,
    );
    return true;
};

/**
 * What an unlock that got no usable answer comes to: the charge may have gone through, so the claim stays,
 * flagged as unconfirmed, and the join is reported with what it may have cost.
 */
const unclearUnlock = async (
    challenge: Challenge,
    deps: JoinDeps,
    needsCoins: number,
    coinsBefore: number | null,
): Promise<JoinOutcome> => {
    const tag = logger.challengeTag(challenge);
    const flagged = await markUnconfirmed(deps, challenge?.id);
    cat().error(
        `${tag}: coins_unlock got no usable answer — the charge may have gone through, keeping the claim`,
        null,
    );
    // A claim that could not be flagged reads as a confirmed one, so it is worded as one: charged, retry the
    // submit — and no way to forget it, which only an unconfirmed claim has.
    if (!flagged) {
        cat().error(`${tag}: the unlock marker could not be flagged as unconfirmed — it stays as a charged one`, null);
        return { status: 'charged-pending-submit', charged: 0, maybeCharged: needsCoins };
    }
    const before = coinsBefore === null ? {} : { coinsBefore };
    return { status: 'charged-pending-submit', charged: 0, reason: 'unconfirmed', maybeCharged: needsCoins, ...before };
};

// A claim file's lock that is held when a refused unlock's claim is removed is tried once more, briefly: the whole
// removal waits on the calling thread, so it stays short.
const CLEAR_RETRY_WAIT_MS = 100;

/**
 * The unlock was refused, so its claim must go. When it cannot be removed (the claims file stays locked or
 * unwritable) it must not stay looking like a payment that is known to have been taken, which nothing could forget:
 * it is flagged unconfirmed instead, so the user can forget it. Only a lock held by another process is worth
 * trying again; a file that cannot be read or written will not be any better a moment later.
 */
const releaseRefusedClaim = async (deps: JoinDeps, id: string | number): Promise<void> => {
    const key = String(id);
    let cleared = await clearUnlocked(deps, key);
    if (cleared === 'locked') cleared = await clearUnlocked(deps, key, CLEAR_RETRY_WAIT_MS);
    if (cleared === 'done') return;
    const flagged = await markUnconfirmed(deps, id);
    cat().error(
        `challenge ${sanitizeLogString(id)}: the unlock was refused but its claim could not be removed — ${flagged ? 'it is flagged as unconfirmed, so it can be forgotten' : 'it could not be flagged either'}`,
        null,
    );
};

/**
 * Whether the price still holds: the open list is read again, and the challenge must still be on it at no more than
 * the price the decision to join used. A price that cannot be read again is not one to spend on. The same read
 * refuses a challenge that has since filled up, or whose unlock price is unreadable (`joinFreshRefusal`) — this is
 * the last look before `coins_unlock`, so a spend that cannot succeed, or that nothing can consent to, happens
 * nowhere. `risenTo` is the
 * live price when it is above the ceiling (null: it holds, or could not be read).
 */
const priceHolds = async (
    challenge: Challenge,
    token: string,
    deps: JoinDeps,
    ceiling: number,
): Promise<{ holds: boolean; risenTo: number | null }> => {
    const tag = logger.challengeTag(challenge);
    let open;
    try {
        open = await deps.getMemberChallenges(token, 'open');
    } catch (error) {
        cat().warning(
            `${tag}: could not read the price again (${errorMessage(error) || error}) — not spending coins`,
            null,
        );
        return { holds: false, risenTo: null };
    }
    const live = open?.find((c) => String(c?.id) === String(challenge?.id));
    // Only a FRESH unlock reaches here (a claim found earlier retries the submit without this read), so a full or
    // price-unreadable live item refuses the spend outright — it only ever reduces spending.
    const freshRefusal = joinFreshRefusal(live);
    if (freshRefusal) {
        cat().warning(
            `${tag}: ${joinFreshRefusalWhy(freshRefusal)} since the join was decided — not spending coins`,
            null,
        );
        return { holds: false, risenTo: null };
    }
    const cost = Number(live?.join_coins);
    if (!Number.isFinite(cost)) {
        cat().warning(`${tag}: its price could not be read again — not spending coins`, null);
        return { holds: false, risenTo: null };
    }
    if (cost > ceiling) {
        cat().warning(
            `${tag}: the price rose from ${ceiling} to ${cost} coins since it was decided — not spending coins`,
            null,
        );
        return { holds: false, risenTo: cost };
    }
    return { holds: true, risenTo: null };
};

/**
 * The check→claim→unlock section, run under the cross-process lock. Re-reads
 * the unlock claim authoritatively — another process may have unlocked between
 * the caller's first check and acquiring the lock.
 *
 *   `outcome` ends the join with that result; otherwise the unlock state the
 *   submit continues from.
 */
const claimAndUnlock = async (
    challenge: Challenge,
    token: string,
    deps: JoinDeps,
    needsCoins: number,
    coinsBefore: number | null,
    priceCeiling: number | undefined,
): Promise<{ outcome: JoinOutcome } | UnlockState> => {
    const id = challenge?.id;
    const { state, ok: stateOk } = readUnlockedState(deps.joinStateStore);
    if (!stateOk) {
        // Cannot verify prior unlocks → refuse to spend (a re-charge
        // is worse than skipping this candidate this cycle).
        cat().error(`${logger.challengeTag(challenge)}: join-state is unreadable — not spending coins`, null);
        return { outcome: failedNoCharge() };
    }
    const existing = findClaim(state, id);
    if (existing) {
        const joined = alreadyJoined(challenge, existing);
        // Another process already paid → retry submit only; unless it has joined, too.
        return joined ? { outcome: joined } : { charged: 0, alreadyUnlocked: true, claim: existing };
    }
    if (cancellation.isCancelled()) return { outcome: failedNoCharge() };
    // The price the decision used may have moved while the photo was picked: asked right before the claim.
    if (priceCeiling !== undefined) {
        const price = await priceHolds(challenge, token, deps, priceCeiling);
        if (!price.holds) {
            return { outcome: { ...failedNoCharge(), ...(price.risenTo === null ? {} : { priceNow: price.risenTo }) } };
        }
    }
    // Persist the claim BEFORE spending, so a crash the instant
    // after the charge can never let a later pass re-unlock. If
    // the claim cannot be recorded, do not spend at all.
    const marked = await claimUnlock(deps, id, coinsBefore);
    if (marked.status === 'exists') {
        // Recorded by another process between the read above and this change (the background service, say): it is
        // unlocking this challenge now, and its unlock may still be refused, so nothing is said of a payment: busy,
        // and the next pass finds the claim and only submits.
        return { outcome: alreadyJoined(challenge, marked.claim) ?? { status: 'busy', charged: 0 } };
    }
    if (marked.status === 'failed') {
        cat().error(`${logger.challengeTag(challenge)}: could not record the unlock claim — not spending coins`, null);
        return { outcome: failedNoCharge() };
    }
    const unlock = await deps.coinsUnlock(id, token);
    if (unlock?.ok) {
        return {
            charged: needsCoins,
            alreadyUnlocked: false,
            claim: { key: String(id), unconfirmed: false, joined: false, coinsBefore },
        };
    }
    // No usable answer (a timeout, a reset, a 5xx) is unclear: the charge may have gone through, and the unlock
    // is not known to be idempotent, so the claim stays — flagged — and the next attempt only submits. A refusal
    // (a body that says no, or a 4xx) was not processed: nothing was charged, the claim goes back.
    if (!unlock || unlock.unclear) {
        return { outcome: await unclearUnlock(challenge, deps, needsCoins, coinsBefore) };
    }
    await releaseRefusedClaim(deps, id);
    cat().warning(`coins_unlock failed for ${logger.challengeTag(challenge)} — no coins charged`, null);
    return { outcome: failedNoCharge() };
};

/**
 * Paid unlock, wrapped in the cross-process lock around the check→claim→unlock
 * section so a concurrent process (GUI auto-join vs CLI join) cannot both unlock.
 */
const unlockUnderLock = async (
    challenge: Challenge,
    token: string,
    deps: JoinDeps,
    needsCoins: number,
    coinsBefore: number | null,
    priceCeiling: number | undefined,
): ReturnType<typeof claimAndUnlock> => {
    const id = challenge?.id;
    const xlock = lockFor(deps, id);
    if (!xlock.ok) {
        return { outcome: { status: 'busy', charged: 0 } };
    }
    try {
        return await claimAndUnlock(challenge, token, deps, needsCoins, coinsBefore, priceCeiling);
    } finally {
        xlock.release();
    }
};

export { alreadyJoined, claimsStale, failedNoCharge, unlockUnderLock };
