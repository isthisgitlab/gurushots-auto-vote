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

const logger = require('../logger');
const settings = require('../settings');
const currencyActions = require('./currencyActions');
const { CURRENCY_FIELD, challengeAllows } = require('../voting/currencyActions');
const { isRuleOpen, pickSwapTarget, votePoolReach, fillBeatsVoting } = require('../voting/currencyAuto');

const log = () => logger.withCategory('currency');

const RESERVE_KEY = Object.freeze({
    key: 'currencyReserveKeys',
    swap: 'currencyReserveSwaps',
    fill: 'currencyReserveFills',
});

/** @param {string} prefix - autoKey | autoSwap | autoExposureFill */
const timingOf = (prefix, challengeId) => ({
    afterStartSec: settings.getEffectiveSetting(`${prefix}AfterStart`, challengeId),
    beforeEndSec: settings.getEffectiveSetting(`${prefix}BeforeEnd`, challengeId),
    afterPercent: settings.getEffectiveSetting(`${prefix}AfterPercent`, challengeId),
});

const entriesOf = (challenge) =>
    Array.isArray(challenge?.member?.ranking?.entries) ? challenge.member.ranking.entries : [];

/**
 * The shared gates every action passes first: the currency endpoints exist in
 * this pass, the challenge allows the action, and its timing rule is open.
 */
const baseGate = (action, prefix, ctx) => {
    const { challenge, now, currency } = ctx;
    if (!currency?.strategy) return false;
    if (!challengeAllows(action, challenge, now)) return false;
    return isRuleOpen(challenge, timingOf(prefix, String(challenge.id)), now);
};

/**
 * True when the balance stays at or above the global reserve after spending
 * one. An unreadable bankroll refuses — never spend blind. Shared with the
 * scenario runner (services/scenarioRunner.js), which passes its own log
 * label, so both automations honour the same user-set reserves.
 */
const reserveAllows = async (action, ctx, label = `auto ${action}`) => {
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
const lockedSpend = async (action, challenge, spend, label = `auto ${action}`) => {
    const locked = await currencyActions.withSpendLock(spend);
    if (locked.busy) {
        log().info(`${label}: ${logger.challengeTag(challenge)} deferred — another spend is in progress`, null);
        return null;
    }
    return locked.value;
};

/** Wraps a runner so a throw is logged, never propagated into the pass. */
const guarded =
    (action, runner) =>
    async (ctx, ...rest) => {
        try {
            return await runner(ctx, ...rest);
        } catch (error) {
            log().warning(
                `auto ${action}: failed for ${logger.challengeTag(ctx?.challenge)}: ${error?.message || error}`,
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
 * @returns {Promise<boolean>} true when a key was spent
 */
const runAutoKey = guarded('key', async (ctx) => {
    const { challenge, token, currency } = ctx;
    const id = String(challenge.id);
    if (settings.getEffectiveSetting('autoKeyUnlock', id) !== true) return false;
    if (!baseGate('key', 'autoKey', ctx)) return false;
    if (!(await reserveAllows('key', ctx))) return false;

    log().info(`${logger.challengeTag(challenge)} auto key: unlocking the boost`, null);
    const result = await lockedSpend('key', challenge, () =>
        currencyActions.unlockBoostWithKey(challenge.id, token, { strategy: currency.strategy, logger }),
    );
    if (!result?.ok) return false;
    challenge.member.boost = { ...challenge.member.boost, state: 'AVAILABLE_KEY', timeout: null };
    return true;
});

/**
 * Spend a SWAP to replace one entry once the autoSwap rule is open, until the
 * challenge's swap history reaches autoSwapMax. The target follows
 * autoSwapImageIndex (0 = last, 1-4 = slot) or, with autoSwapLowestVotes, the
 * entry with the fewest votes; boosted/turbo'd entries are skipped unless
 * autoSwapAllowBoosted (the swap-back ledger then records them).
 *
 * @returns {Promise<boolean>} true when a swap was spent
 */
const runAutoSwap = guarded('swap', async (ctx) => {
    const { challenge, token, currency } = ctx;
    const id = String(challenge.id);
    if (settings.getEffectiveSetting('autoSwap', id) !== true) return false;
    if (!baseGate('swap', 'autoSwap', ctx)) return false;

    const ranking = challenge.member.ranking;
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

    const deps = { strategy: currency.strategy, logger, settings };
    let candidate = null;
    const result = await lockedSpend('swap', challenge, async () => {
        const preview = await currencyActions.previewSwap(challenge.id, target.id, token, deps, {
            excludeSwapped: true,
        });
        if (!preview?.ok) return preview;
        candidate = preview.candidate;
        return currencyActions.swapEntry(challenge.id, target.id, candidate.id, token, {
            ...deps,
            ledger: currency.swapLedger ?? null,
        });
    });
    if (!result?.ok || !candidate) return false;

    log().info(`${logger.challengeTag(challenge)} auto swap: entry ${target.id} → ${candidate.id}`, null);
    const entries = entriesOf(challenge);
    const slot = entries.indexOf(target);
    entries[slot] = { id: candidate.id, member_id: candidate.member_id, votes: 0, turbo: false, boosted: false };
    ranking.swaps = [...(Array.isArray(ranking.swaps) ? ranking.swaps : []), { id: String(target.id) }];
    return true;
});

/**
 * Spend a FILL once the autoExposureFill rule is open, exposure is below
 * autoExposureFillBelow AND the vote pool can't lift it back there — a fill is
 * worth exactly what voting is worth, so it only replaces voting that can't be
 * done (typically a flash challenge that ran out of photos). Capped per
 * challenge by autoExposureFillMax.
 *
 * @param {object} ctx
 * @param {object|null|undefined} votePool - the getVoteImages response this pass
 *   voted from (null = none available); undefined = voting didn't run, so the
 *   pool is fetched here to judge the shortfall
 * @returns {Promise<boolean>} true when a fill was spent
 */
const runAutoExposureFill = guarded('fill', async (ctx, votePool) => {
    const { challenge, token, currency } = ctx;
    const id = String(challenge.id);
    if (settings.getEffectiveSetting('autoExposureFill', id) !== true) return false;
    if (!baseGate('fill', 'autoExposureFill', ctx)) return false;
    const ledger = currency.spendLedger;
    if (!ledger) return false;
    if (ledger.fills(id) >= Number(settings.getEffectiveSetting('autoExposureFillMax', id))) return false;

    const exposure = Number(challenge.member?.ranking?.exposure?.exposure_factor);
    const below = settings.getEffectiveSetting('autoExposureFillBelow', id);
    if (!(exposure < below)) return false;

    const pool = votePool === undefined ? await currency.strategy.getVoteImages(challenge, token) : votePool;
    const reach = votePoolReach(pool);
    if (!fillBeatsVoting(exposure, reach, below)) {
        log().debug(
            `${logger.challengeTag(challenge)} auto fill: voting can still reach ${below}% — not spending a fill`,
            null,
        );
        return false;
    }
    if (!(await reserveAllows('fill', ctx))) return false;

    const reachText = reach === null ? 'no vote images left' : `votes reach only ~${Math.round(reach)}%`;
    log().info(`${logger.challengeTag(challenge)} auto fill: exposure ${exposure}% < ${below}%, ${reachText}`, null);
    const result = await lockedSpend('fill', challenge, () =>
        currencyActions.fillExposure(challenge.id, token, { strategy: currency.strategy, logger }),
    );
    if (!result?.ok) return false;
    ledger.addFill(id);
    challenge.member.ranking.exposure = { ...challenge.member.ranking.exposure, exposure_factor: 100 };
    return true;
});

module.exports = { runAutoKey, runAutoSwap, runAutoExposureFill, reserveAllows, lockedSpend };
