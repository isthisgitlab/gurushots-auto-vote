/**
 * CLI join commands: `discover` lists un-joined ("open") challenges, and
 * `join <id> [--yes]` joins one. Paid joins (join_coins > 0) print the coin
 * cost and require an explicit `--yes` — `join <id>` alone never spends coins.
 * Reuses the shared IPC handlers so the join safety model lives in one place.
 */

const logger = require('../../logger');
const { ensureAuthenticated } = require('../guards');

let _handlers;
const handlers = () => (_handlers ??= require('../../ipc/actions.handlers').buildHandlers());

const showDiscover = async () => {
    if (!ensureAuthenticated()) return;
    const result = await handlers()['get-member-challenges'](null, 'open');
    logger.withCategory('ui').info('=== Open (un-joined) Challenges ===');
    if (!result?.success) {
        logger.withCategory('ui').info(`  (unavailable — ${result?.error || 'could not list challenges'})`);
        return;
    }
    const items = Array.isArray(result.items) ? result.items : [];
    if (items.length === 0) {
        logger.withCategory('ui').info('  None');
        return;
    }
    items.forEach((c) => {
        const cost = Number(c?.join_coins) > 0 ? `${c.join_coins} coins` : 'free';
        const name = c?.title || c?.url || 'untitled';
        logger.withCategory('ui').info(`  • [${c?.id}] ${name} (${c?.type || '?'}) — ${cost}`);
    });
    logger.withCategory('ui').info('Join with: join <id>          (free challenges)');
    logger.withCategory('ui').info('           join <id> --yes    (paid challenges — spends coins)');
};

// Map a join outcome status to a user-facing line.
const reportJoin = (result, challengeId) => {
    const status = result?.status;
    switch (status) {
        case 'joined':
            logger.withCategory('ui').info(`✅ Joined challenge ${challengeId}.`);
            return;
        case 'skipped-unaffordable':
            logger
                .withCategory('ui')
                .error(
                    `Not enough coins to join ${challengeId} (needs ${result?.cost}, you have ${result?.coins ?? '?'}).`,
                );
            return;
        case 'balance-unknown':
            logger.withCategory('ui').error(`Could not read your coin balance — not joining ${challengeId}.`);
            return;
        case 'charged-pending-submit':
            logger
                .withCategory('ui')
                .error(
                    `Coins were charged for ${challengeId} but the join did not complete. Re-run "join ${challengeId} --yes" to retry the submit — you will NOT be charged again.`,
                );
            return;
        case 'failed-no-charge':
            logger.withCategory('ui').error(`Could not join ${challengeId}. No coins were charged.`);
            return;
        case 'skipped-no-photo':
            logger.withCategory('ui').error(`No eligible photo to submit for ${challengeId}. No coins were charged.`);
            return;
        case 'unavailable':
            logger.withCategory('ui').info(`Challenge ${challengeId} is not open to join (already joined or closed).`);
            return;
        case 'busy':
            logger.withCategory('ui').info(`A join is already in progress for ${challengeId}.`);
            return;
        case 'not-authenticated':
            logger.withCategory('ui').error(`Not logged in — run "login" first, then join ${challengeId}.`);
            return;
        case 'fetch-failed':
            logger
                .withCategory('ui')
                .error(`Could not reach GuruShots to join ${challengeId}. Check your connection and try again.`);
            return;
        default:
            // Friendly fallback; the raw status is logged at debug for diagnosis.
            logger.withCategory('ui').error(`Could not join ${challengeId} right now. Please try again.`);
            logger.withCategory('ui').debug(`join status=${status}`);
    }
};

/**
 * Join one challenge. Free challenges join immediately; paid challenges print
 * the cost and require `--yes` (yes=true) before any coins are spent.
 *
 * @param {string|number} challengeId
 * @param {{yes?: boolean}} [opts]
 */
const joinChallengeCmd = async (challengeId, { yes = false } = {}) => {
    if (!ensureAuthenticated()) return;
    if (!challengeId) {
        logger.withCategory('ui').error('Please specify a challenge id');
        logger.withCategory('ui').info('Usage: join <id> [--yes]');
        process.exit(1);
    }

    // First attempt with spendCoins=false: free challenges join; paid ones come
    // back as 'needs-confirm' WITHOUT spending anything.
    const first = await handlers()['join-challenge'](null, challengeId, false);
    if (first?.status !== 'needs-confirm') {
        reportJoin(first, challengeId);
        return;
    }

    logger.withCategory('ui').info(`Challenge ${challengeId} is a PAID challenge — joining costs ${first.cost} coins.`);
    if (!yes) {
        logger.withCategory('ui').info(`To spend the coins and join, re-run: join ${challengeId} --yes`);
        return;
    }
    const confirmed = await handlers()['join-challenge'](null, challengeId, true);
    reportJoin(confirmed, challengeId);
};

module.exports = { showDiscover, joinChallengeCmd };
