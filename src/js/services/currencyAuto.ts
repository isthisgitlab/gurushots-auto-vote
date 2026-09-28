/**
 * Automatic spending of the bankroll currencies during a voting pass — the
 * automated counterpart of the card's manual Key / Swap / Fill buttons.
 *
 * Every action is disabled by default. A global default, profile, or challenge
 * setting can enable it, subject to:
 *   1. the local challenge allowing it (voting/currencyActions challengeAllows),
 *   2. its timing rule being open (voting/currencyAuto isRuleOpen),
 *   3. its own per-challenge conditions (swap target / caps, fill shortfall),
 *   4. the global reserve (never spend the balance below currencyReserve*).
 * Only then does it take the process-wide spend lock (shared with the manual
 * handlers) and call the same service functions a manual spend uses, which
 * re-check the LIVE challenge and bankroll before spending.
 *
 * A successful spend is reflected onto the pass's challenge object (like
 * autoFill.reflectNewEntry) so later actions in the same pass see it: a key
 * unlock makes the boost available to the boost runner, a swap updates the
 * entry list, a fill raises exposure. Runners never throw — a failure is logged
 * and the pass moves on.
 */

import * as logger from '../logger';
import * as settings from '../settings';
import * as currencyActions from './currencyActions';
import { CURRENCY_FIELD, challengeAllows } from '../voting/currencyActions';
import { isRuleOpen, pickSwapTarget, votePoolReach, fillBeatsVoting } from '../voting/currencyAuto';

import type { Challenge, ChallengeMember, MemberRanking, VoteImagesResponse } from '../types/gurushots';
import type { CurrencyAction, CurrencyStrategy, SwapBackLedger, SwapCandidate } from './currencyActions';
import type * as currencyAutoStore from '../currencyAutoStore';
import { errorMessage } from '../errorMessage';

type AutoSpendLedger = ReturnType<typeof currencyAutoStore.createAutoSpendLedger>;

/** The part of a getVoteImages response the fill shortfall check reads.
 */
type VotePool = Pick<VoteImagesResponse, 'voting' | 'images'>;

/**
 * The pass's `currency` block: the spend endpoints (plus getVoteImages for the
 * fill shortfall check) and the swap-back / auto-spend ledgers.
 */
export interface CurrencyPassDeps {
    strategy: CurrencyStrategy & { getVoteImages: (challenge: Challenge, token: string) => Promise<VotePool | null> };
    swapLedger?: SwapBackLedger | null;
    spendLedger?: AutoSpendLedger | null;
}

/**
 * One challenge's context in a voting pass. `currency` is absent when the pass
 * has no currency endpoints.
 */
interface CurrencyCtx {
    challenge: Challenge;
    token: string;
    /** Unix seconds */
    now: number;
    currency?: CurrencyPassDeps | null;
}

type LiveCurrencyCtx = CurrencyCtx & { currency: CurrencyPassDeps };

type RulePrefix = 'autoKey' | 'autoSwap' | 'autoExposureFill';

const log = () => logger.withCategory('currency');

const RESERVE_KEY = Object.freeze({
    key: 'currencyReserveKeys',
    swap: 'currencyReserveSwaps',
    fill: 'currencyReserveFills',
});

const timingOf = (prefix: RulePrefix, challengeId: string) => ({
    afterStartSec: settings.getEffectiveSetting(`${prefix}AfterStart`, challengeId),
    beforeEndSec: settings.getEffectiveSetting(`${prefix}BeforeEnd`, challengeId),
    afterPercent: settings.getEffectiveSetting(`${prefix}AfterPercent`, challengeId),
});

const entriesOf = (challenge: Challenge) =>
    Array.isArray(challenge?.member?.ranking?.entries) ? challenge.member.ranking.entries : [];

/**
 * The shared gates every action passes first: the currency endpoints exist in
 * this pass, the challenge allows the action, and its timing rule is open.
 */
const baseGate = (action: CurrencyAction, prefix: RulePrefix, ctx: CurrencyCtx): ctx is LiveCurrencyCtx => {
    const { challenge, now, currency } = ctx;
    if (!currency?.strategy) return false;
    if (!challengeAllows(action, challenge, now)) return false;
    return isRuleOpen(challenge, timingOf(prefix, String(challenge.id)), now);
};

/**
 * True when the balance stays at or above the global reserve after spending
 * one. An unreadable bankroll refuses — never spend blind. Shared with the
 * scenario runner (services/scenarioRunner.ts), which passes its own log
 * label, so both automations honour the same user-set reserves.
 */
const reserveAllows = async (
    action: CurrencyAction,
    ctx: { challenge: Challenge; token: string; currency: CurrencyPassDeps },
    label: string = `auto ${action}`,
): Promise<boolean> => {
    const { challenge, token, currency } = ctx;
    const bankroll = await currency.strategy.getBankroll(token);
    const balance = Number(bankroll?.[CURRENCY_FIELD[action]]);
    if (!Number.isFinite(balance)) {
        log().warning(`${label}: balance unreadable for ${logger.challengeTag(challenge)} — not spending`, null);
        return false;
    }
    const reserve = Number(settings.getEffectiveSetting(RESERVE_KEY[action]));
    const keep = Number.isFinite(reserve) && reserve > 0 ? reserve : 0;
    if (balance > keep) return true;
    log().info(
        `${label}: ${logger.challengeTag(challenge)} skipped — balance ${balance} would go below the reserve of ${keep}`,
        null,
    );
    return false;
};

/**
 * Runs a spend under the shared lock. Null when another spend holds it (the
 * rule simply re-evaluates next cycle).
 */
const lockedSpend = async <T>(
    action: CurrencyAction,
    challenge: Challenge,
    spend: () => Promise<T>,
    label: string = `auto ${action}`,
): Promise<T | null> => {
    const locked = await currencyActions.withSpendLock(spend);
    if (locked.busy) {
        log().info(`${label}: ${logger.challengeTag(challenge)} deferred — another spend is in progress`, null);
        return null;
    }
    return locked.value;
};

/**
 * Wraps a runner so a throw is logged, never propagated into the pass.
 */
const guarded =
    <A extends unknown[]>(
        action: CurrencyAction,
        runner: (ctx: CurrencyCtx, ...rest: A) => Promise<boolean>,
    ): ((ctx: CurrencyCtx, ...rest: A) => Promise<boolean>) =>
    async (ctx, ...rest) => {
        try {
            return await runner(ctx, ...rest);
        } catch (error) {
            log().warning(
                `auto ${action}: failed for ${logger.challengeTag(ctx?.challenge)}: ${errorMessage(error) || error}`,
                null,
            );
            return false;
        }
    };

/**
 * Spend a KEY to unlock the challenge's LOCKED boost once the autoKey rule is
 * open. Unlock only: applying the unlocked boost stays with the boost runner
 * (autoBoost + keyUnlockedBoostTime), which sees it this same pass.
 *
 * @returns true when a key was spent
 */
const runAutoKey = guarded('key', async (ctx) => {
    const { challenge, token } = ctx;
    const id = String(challenge.id);
    if (settings.getEffectiveSetting('autoKeyUnlock', id) !== true) return false;
    if (!baseGate('key', 'autoKey', ctx)) return false;
    if (!(await reserveAllows('key', ctx))) return false;

    log().info(`${logger.challengeTag(challenge)} auto key: unlocking the boost`, null);
    const result = await lockedSpend('key', challenge, () =>
        currencyActions.unlockBoostWithKey(challenge.id, token, { strategy: ctx.currency.strategy, logger }),
    );
    if (!result?.ok) return false;
    // The gate required member.boost.state === 'LOCKED', so the member block is present.
    const member = challenge.member as ChallengeMember;
    member.boost = { ...member.boost, state: 'AVAILABLE_KEY', timeout: null };
    return true;
});

/**
 * Spend a SWAP to replace one entry once the autoSwap rule is open, until the
 * challenge's swap history reaches autoSwapMax. The target follows
 * autoSwapImageIndex (0 = last, 1-4 = slot) or, with autoSwapLowestVotes, the
 * entry with the fewest votes; boosted/turbo'd entries are skipped unless
 * autoSwapAllowBoosted (the swap-back ledger then records them).
 *
 * @returns true when a swap was spent
 */
const runAutoSwap = guarded('swap', async (ctx) => {
    const { challenge, token } = ctx;
    const id = String(challenge.id);
    if (settings.getEffectiveSetting('autoSwap', id) !== true) return false;
    if (!baseGate('swap', 'autoSwap', ctx)) return false;

    const ranking = (challenge.member as ChallengeMember).ranking;
    const swapsDone = Array.isArray(ranking?.swaps) ? ranking.swaps.length : 0;
    if (swapsDone >= Number(settings.getEffectiveSetting('autoSwapMax', id))) return false;

    const target = pickSwapTarget(entriesOf(challenge), {
        imageIndex: settings.getEffectiveSetting('autoSwapImageIndex', id),
        lowestVotes: settings.getEffectiveSetting('autoSwapLowestVotes', id) === true,
        allowProtected: settings.getEffectiveSetting('autoSwapAllowBoosted', id) === true,
        maxVotes: settings.getEffectiveSetting('autoSwapMaxVotes', id),
    });
    if (!target) {
        log().debug(`${logger.challengeTag(challenge)} auto swap: no entry qualifies`, null);
        return false;
    }
    if (!(await reserveAllows('swap', ctx))) return false;

    const deps = { strategy: ctx.currency.strategy, logger, settings };
    // Cast, not annotated: the closure below assigns it, which the checker's
    // narrowing of a plain `= null` initializer can't see.
    let candidate = null as SwapCandidate | null;
    const result = await lockedSpend('swap', challenge, async () => {
        const preview = await currencyActions.previewSwap(challenge.id, target.id, token, deps, {
            excludeSwapped: true,
        });
        if (!preview?.ok) return preview;
        candidate = preview.candidate;
        return currencyActions.swapEntry(challenge.id, target.id, candidate.id, token, {
            ...deps,
            ledger: ctx.currency.swapLedger ?? null,
        });
    });
    if (!result?.ok || !candidate) return false;

    log().info(`${logger.challengeTag(challenge)} auto swap: entry ${target.id} → ${candidate.id}`, null);
    const entries = entriesOf(challenge);
    const slot = entries.indexOf(target);
    entries[slot] = { id: candidate.id, member_id: candidate.member_id, votes: 0, turbo: false, boosted: false };
    // The target came from ranking.entries, so the ranking block is present.
    const swapped = ranking as MemberRanking;
    swapped.swaps = [...(Array.isArray(swapped.swaps) ? swapped.swaps : []), { id: String(target.id) }];
    return true;
});

/**
 * Raise the pass's copy of the challenge to the 100% a fill just set, so later
 * steps see it.
 *
 * @param challenge - one whose exposure_factor was read, so member.ranking is present
 */
const reflectFill = (challenge: Challenge) => {
    const ranking = (challenge.member as ChallengeMember).ranking as MemberRanking;
    ranking.exposure = { ...ranking.exposure, exposure_factor: 100 };
};

/**
 * Spend a FILL once the autoExposureFill rule is open, exposure is below
 * autoExposureFillBelow AND the vote pool can't lift it back there — a fill is
 * worth exactly what voting is worth, so it only replaces voting that can't be
 * done (typically a flash challenge that ran out of photos). Capped per
 * challenge by autoExposureFillMax.
 *
 * `votePool` is the getVoteImages response this pass voted from (null = none
 * available); undefined = voting didn't run, so the pool is fetched here to
 * judge the shortfall. Resolves true when a fill was spent.
 */
const runAutoExposureFill: (ctx: CurrencyCtx, votePool: VotePool | null | undefined) => Promise<boolean> = guarded(
    'fill',
    async (ctx, votePool) => {
        const { challenge, token } = ctx;
        const id = String(challenge.id);
        if (settings.getEffectiveSetting('autoExposureFill', id) !== true) return false;
        if (!baseGate('fill', 'autoExposureFill', ctx)) return false;
        const ledger = ctx.currency.spendLedger;
        if (!ledger) return false;
        if (ledger.fills(id) >= Number(settings.getEffectiveSetting('autoExposureFillMax', id))) return false;

        const exposure = Number(challenge.member?.ranking?.exposure?.exposure_factor);
        const below = settings.getEffectiveSetting('autoExposureFillBelow', id);
        if (!(exposure < below)) return false;

        const pool = votePool === undefined ? await ctx.currency.strategy.getVoteImages(challenge, token) : votePool;
        // votePoolReach reads the pool through optional chaining; null (no pool) yields null.
        const reach = votePoolReach(pool as VoteImagesResponse);
        if (!fillBeatsVoting(exposure, reach, below)) {
            log().debug(
                `${logger.challengeTag(challenge)} auto fill: voting can still reach ${below}% — not spending a fill`,
                null,
            );
            return false;
        }
        if (!(await reserveAllows('fill', ctx))) return false;

        const reachText = reach === null ? 'no vote images left' : `votes reach only ~${Math.round(reach)}%`;
        log().info(
            `${logger.challengeTag(challenge)} auto fill: exposure ${exposure}% < ${below}%, ${reachText}`,
            null,
        );
        const result = await lockedSpend('fill', challenge, () =>
            currencyActions.fillExposure(challenge.id, token, { strategy: ctx.currency.strategy, logger }),
        );
        if (!result?.ok) return false;
        ledger.addFill(id);
        reflectFill(challenge);
        return true;
    },
);

/**
 * Spend a FILL toward an active "Use Fill" mission (missionUseFills — the
 * caller passes what the mission still needs, 0 when none is followed): on a
 * challenge that can take one (fill offered, exposure below 100%), at most one
 * per challenge per pass. Keeps the fill reserve and takes the spend lock, but
 * isn't counted against autoExposureFillMax, which caps only the exposure rule.
 * Resolves true when a fill was spent.
 */
const runMissionFill: (ctx: CurrencyCtx, missionNeed: number) => Promise<boolean> = guarded(
    'fill',
    async (ctx, missionNeed) => {
        const { challenge, token, now, currency } = ctx;
        if (!(missionNeed > 0) || !currency?.strategy) return false;
        if (!challengeAllows('fill', challenge, now)) return false;
        if (!(await reserveAllows('fill', { challenge, token, currency }, 'mission fill'))) return false;

        log().info(
            `${logger.challengeTag(challenge)} mission fill: ${missionNeed} more fill(s) needed for the mission`,
            null,
        );
        const result = await lockedSpend(
            'fill',
            challenge,
            () => currencyActions.fillExposure(challenge.id, token, { strategy: currency.strategy, logger }),
            'mission fill',
        );
        if (!result?.ok) return false;
        reflectFill(challenge);
        return true;
    },
);

export { runAutoKey, runAutoSwap, runAutoExposureFill, runMissionFill, reserveAllows, lockedSpend };
