/**
 * CLI join commands: `discover` lists un-joined challenges (the open ones, and the upcoming ones
 * starting within `discoverUpcomingHours`), and
 * `join <id> [--yes]` joins one. Paid joins (join_coins > 0) print the coin
 * cost and require an explicit `--yes` — `join <id>` alone never spends coins.
 * Reuses the shared IPC handlers so the join safety model lives in one place.
 */

import * as logger from '../../logger';
import { ensureAuthenticated, INVALID_ID_TEXT } from '../guards';
import { stripTerminalControl } from '../../format/logSafe';
import { formatDuration } from '../../format/duration';

import type { NullEventHandlers } from '../../types/cli';
import type * as actions_handlersModule from '../../ipc/actions.handlers';
type ActionHandlers = NullEventHandlers<ReturnType<typeof actions_handlersModule.buildHandlers>>;
let _handlers: ActionHandlers | undefined;
const handlers = (): ActionHandlers =>
    (_handlers ??= (
        require('../../ipc/actions.handlers') as typeof import('../../ipc/actions.handlers')
    ).buildHandlers());

type DiscoverItem = {
    id?: string | number;
    title?: string;
    url?: string;
    type?: string;
    status?: string;
    join_coins?: number;
    start_time?: number;
};

/** One row of the listing. Everything that came from the server is stripped of terminal control. */
const discoverLine = (c: DiscoverItem, nowSec: number): string => {
    const cost = Number(c?.join_coins) > 0 ? `${c.join_coins} coins` : 'free';
    const name = stripTerminalControl(c?.title || c?.url || 'untitled');
    const type = stripTerminalControl(c?.type || '?');
    const timing = c?.status === 'upcoming' ? ` — starts in ${formatDuration(Number(c.start_time) - nowSec)}` : '';
    return `  • [${stripTerminalControl(String(c?.id))}] ${name} (${type}) — ${cost}${timing}`;
};

const showDiscover = async () => {
    if (!ensureAuthenticated()) return;
    const result = await handlers()['get-member-challenges'](null);
    logger.withCategory('ui').info('=== Open and upcoming challenges ===');
    if (!result?.success) {
        logger.withCategory('ui').info(`  (unavailable — ${result?.error || 'could not list challenges'})`);
        return;
    }
    const items = Array.isArray(result.items) ? result.items : [];
    if (items.length === 0) {
        logger.withCategory('ui').info('  None');
        return;
    }
    const nowSec = Date.now() / 1000;
    items.forEach((c) => logger.withCategory('ui').info(discoverLine(c, nowSec)));
    logger.withCategory('ui').info('Join with: join <id>          (free challenges)');
    logger.withCategory('ui').info('           join <id> --yes    (paid challenges — spends coins)');
    const upcoming = items.filter((c) => c?.status === 'upcoming');
    if (upcoming.length > 0) {
        // An upcoming challenge cannot be joined yet, but its photos can be chosen now.
        logger
            .withCategory('ui')
            .info('Upcoming challenges cannot be joined until they start. To choose their photos now:');
        logger.withCategory('ui').info('  list-photos --challenge=<id>');
        logger.withCategory('ui').info(`  set-setting chosenPhotos '["<photo id>"]' --challenge=<id>`);
    }
};

/**
 * A join-challenge handler result, read loosely: its arms share no
 * discriminant, so each field is optional here.
 */
type JoinOutcome = { success?: boolean; status?: string; cost?: number; coins?: number; error?: string };

// Map a join outcome status to a user-facing line; null for an unknown status.
const joinLine = (
    result: JoinOutcome | null | undefined,
    challengeId: string | number,
): { level: 'info' | 'error'; text: string } | null => {
    if (result?.error === 'invalid-args') return { level: 'error', text: INVALID_ID_TEXT };
    switch (result?.status) {
        case 'joined':
            return { level: 'info', text: `✅ Joined challenge ${challengeId}.` };
        case 'skipped-unaffordable':
            return {
                level: 'error',
                text: `Not enough coins to join ${challengeId} (needs ${result?.cost}, you have ${result?.coins ?? '?'}).`,
            };
        case 'balance-unknown':
            return { level: 'error', text: `Could not read your coin balance — not joining ${challengeId}.` };
        case 'charged-pending-submit':
            return {
                level: 'error',
                text: `Coins were charged for ${challengeId} but the join did not complete. Re-run "join ${challengeId} --yes" to retry the submit — you will NOT be charged again.`,
            };
        case 'failed-no-charge':
            return { level: 'error', text: `Could not join ${challengeId}. No coins were charged.` };
        case 'skipped-no-photo':
            return {
                level: 'error',
                text: `No eligible photo to submit for ${challengeId}. No coins were charged.`,
            };
        case 'unavailable':
            return {
                level: 'info',
                text: `Challenge ${challengeId} is not open to join (already joined or closed).`,
            };
        case 'not-started':
            return {
                level: 'info',
                text: `Challenge ${challengeId} has not started yet, so it can't be joined. Choose its photos now — list-photos --challenge=${challengeId}, then set-setting chosenPhotos '["<photo id>"]' --challenge=${challengeId} — and join once it starts.`,
            };
        case 'busy':
            return { level: 'info', text: `A join is already in progress for ${challengeId}.` };
        case 'not-authenticated':
            return { level: 'error', text: `Not logged in — run "login" first, then join ${challengeId}.` };
        case 'fetch-failed':
            return {
                level: 'error',
                text: `Could not reach GuruShots to join ${challengeId}. Check your connection and try again.`,
            };
        default:
            return null;
    }
};

const reportJoin = (result: JoinOutcome | null | undefined, challengeId: string | number) => {
    const line = joinLine(result, challengeId);
    if (line) {
        logger.withCategory('ui')[line.level](line.text);
        return;
    }
    // Friendly fallback; the raw status is logged at debug for diagnosis.
    logger.withCategory('ui').error(`Could not join ${challengeId} right now. Please try again.`);
    logger.withCategory('ui').debug(`join status=${result?.status}`);
};

/**
 * Join one challenge. Free challenges join immediately; paid challenges print
 * the cost and require `--yes` (yes=true) before any coins are spent.
 *
 * @param challengeId - from argv; a missing id exits with usage
 */
const joinChallengeCmd = async (challengeId: string | number | undefined, { yes = false }: { yes?: boolean } = {}) => {
    if (!ensureAuthenticated()) return;
    if (!challengeId) {
        logger.withCategory('ui').error('Please specify a challenge id');
        logger.withCategory('ui').info('Usage: join <id> [--yes]');
        process.exit(1);
    }

    // First attempt with spendCoins=false: free challenges join; paid ones come
    // back as 'needs-confirm' WITHOUT spending anything.
    const first = (await handlers()['join-challenge'](null, challengeId, false)) as JoinOutcome;
    if (first?.status !== 'needs-confirm') {
        reportJoin(first, challengeId);
        return;
    }

    logger.withCategory('ui').info(`Challenge ${challengeId} is a PAID challenge — joining costs ${first.cost} coins.`);
    if (!yes) {
        logger.withCategory('ui').info(`To spend the coins and join, re-run: join ${challengeId} --yes`);
        return;
    }
    const confirmed = (await handlers()['join-challenge'](null, challengeId, true)) as JoinOutcome;
    reportJoin(confirmed, challengeId);
};

export { showDiscover, joinChallengeCmd };
