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
import type { ForgetStatus } from '../../types/join';
import type { OpenChallenge } from '../../types/gurushots';
import type * as actions_handlersModule from '../../ipc/actions.handlers';
type ActionHandlers = NullEventHandlers<ReturnType<typeof actions_handlersModule.buildHandlers>>;
let _handlers: ActionHandlers | undefined;
const handlers = (): ActionHandlers =>
    (_handlers ??= (
        require('../../ipc/actions.handlers') as typeof import('../../ipc/actions.handlers')
    ).buildHandlers());

type DiscoverItem = Pick<OpenChallenge, 'id' | 'title' | 'url' | 'type' | 'status' | 'join_coins' | 'start_time'>;

/** One row of the listing. Everything that came from the server is stripped of terminal control. */
const discoverLine = (c: DiscoverItem, nowSec: number): string => {
    // A number, whatever the server sent: it is printed as text.
    const coins = Number(c?.join_coins);
    const cost = coins > 0 ? `${coins} coins` : 'free';
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
type JoinOutcome = {
    success?: boolean;
    status?: string;
    cost?: number;
    coins?: number;
    error?: string;
    reason?: string;
    coinsBefore?: number;
};

// The balance before a payment that got no answer, and the balance now when it could be read: for the user to
// compare with the coin history on GuruShots. The app does not decide anything from them.
const balanceHint = (before: number | undefined, now: number | null): string => {
    if (before === undefined) return '';
    const nowText = now === null ? '' : `; GuruShots reports ${now} now`;
    return ` Coins before this payment: ${before}${nowText}. Other coin activity since then changes the difference, and this app does not decide whether the payment went through: the coin history on the GuruShots website is what counts.`;
};

// The line for a join that cannot tell whether its payment was taken: what is not known, why it is safe to retry,
// and the way out when GuruShots shows the coins were not taken.
const unconfirmedText = (
    reason: 'unconfirmed' | 'earlier-payment',
    challengeId: string | number,
    balances: { before?: number; now: number | null },
) => {
    const rerun = `Re-run "join ${challengeId}": it only submits your photo, so you are never charged twice.`;
    if (reason === 'earlier-payment') {
        return `Challenge ${challengeId} has a payment record from an older version of the app, from before accounts were told apart, so it is not known whether the coins were taken, or by which GuruShots account used on this device. The join did not finish. ${rerun} The record cannot be forgotten here, because it may belong to another account: it stops applying to other accounts once the account that paid joins the challenge through this app, and otherwise clears by itself, at the next check after 30 days. If this is not the account that paid, you can join the challenge on the GuruShots website meanwhile.`;
    }
    return `The payment for ${challengeId} got no answer, so it may or may not have gone through, and the join did not finish.${balanceHint(balances.before, balances.now)} ${rerun} If the GuruShots website shows the coins were not taken, run "forget-payment ${challengeId}" and join again.`;
};

// Map a join outcome status to a user-facing line; null for an unknown status.
const joinLine = (
    result: JoinOutcome | null | undefined,
    challengeId: string | number,
    coinsNow: number | null,
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
            if (result?.reason === 'no-photo') {
                return {
                    level: 'error',
                    text: `Coins were already spent on ${challengeId}, but no photo qualifies for this challenge. Add an eligible photo, then re-run "join ${challengeId} --yes" — you will NOT be charged again. If you use Must Include Tags, or have turned off Submit Even Without a Tag Match, those can also be what blocks the pick.`,
                };
            }
            if (result?.reason === 'unconfirmed' || result?.reason === 'earlier-payment') {
                return {
                    level: 'error',
                    text: unconfirmedText(result.reason, challengeId, { before: result.coinsBefore, now: coinsNow }),
                };
            }
            return {
                level: 'error',
                text: `Coins were charged for ${challengeId} but the join did not complete. Re-run "join ${challengeId} --yes" to retry the submit — you will NOT be charged again.`,
            };
        case 'failed-no-charge':
            if (result?.reason === 'account-unknown') {
                return {
                    level: 'error',
                    text: `Could not confirm which account is logged in, so this attempt to join ${challengeId} spent no coins. Try again shortly, or run "login" again.`,
                };
            }
            if (result?.reason === 'already-joined') {
                return {
                    level: 'info',
                    text: `This account has already joined ${challengeId}; nothing was spent.`,
                };
            }
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
        case 'needs-confirm':
            return {
                level: 'error',
                text: `Challenge ${challengeId} costs ${Number(result?.cost)} coins, more than --max-coins allows. Nothing was spent — to pay this cost, re-run: join ${challengeId} --yes --max-coins=${Number(result?.cost)}`,
            };
        case 'busy':
            return { level: 'info', text: `A join is already in progress for ${challengeId}. Try again in a moment.` };
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

// The balance now, read only to put beside the one from before a payment that got no answer.
const coinsNow = async (result: JoinOutcome | null | undefined): Promise<number | null> => {
    if (result?.reason !== 'unconfirmed' || result.coinsBefore === undefined) return null;
    const bankroll = await handlers()['get-bankroll'](null);
    const coins = bankroll?.success ? Number(bankroll.coins) : Number.NaN;
    return Number.isFinite(coins) ? coins : null;
};

/**
 * @returns whether the challenge was joined
 */
const reportJoin = async (result: JoinOutcome | null | undefined, challengeId: string | number): Promise<boolean> => {
    const line = joinLine(result, challengeId, await coinsNow(result));
    if (line) {
        logger.withCategory('ui')[line.level](line.text);
        return result?.status === 'joined';
    }
    // Friendly fallback; the raw status is logged at debug for diagnosis.
    logger.withCategory('ui').error(`Could not join ${challengeId} right now. Please try again.`);
    logger.withCategory('ui').debug(`join status=${result?.status}`);
    return false;
};

/**
 * Join one challenge. Free challenges join immediately; paid challenges print
 * the cost and require `--yes` (yes=true) before any coins are spent. The re-run line
 * names that cost as `--max-coins`: with it, a challenge whose live cost has risen above it
 * is not joined. `--yes` alone accepts whatever the cost is at that moment.
 *
 * @param challengeId - from argv; a missing id exits with usage
 * @param options.maxCoins - the most the user agreed to pay (`--max-coins=<coins>`)
 * @returns the exit code: 0 when the challenge was joined, 1 for anything that did not join it (a refusal, a
 *   join that did not finish, a paid challenge that was only priced because `--yes` was not given)
 */
const joinChallengeCmd = async (
    challengeId: string | number | undefined,
    { yes = false, maxCoins }: { yes?: boolean; maxCoins?: number } = {},
): Promise<number> => {
    if (!ensureAuthenticated()) return 1;
    if (!challengeId) {
        logger.withCategory('ui').error('Please specify a challenge id');
        logger.withCategory('ui').info('Usage: join <id> [--yes [--max-coins=<coins>]]');
        process.exit(1);
    }

    // First attempt with spendCoins=false: free challenges join; paid ones come
    // back as 'needs-confirm' WITHOUT spending anything.
    const first = (await handlers()['join-challenge'](null, challengeId, false)) as JoinOutcome;
    if (first?.status !== 'needs-confirm') return (await reportJoin(first, challengeId)) ? 0 : 1;

    logger
        .withCategory('ui')
        .info(`Challenge ${challengeId} is a PAID challenge — joining costs ${Number(first.cost)} coins.`);
    if (!yes) {
        logger
            .withCategory('ui')
            .info(`To spend the coins and join, re-run: join ${challengeId} --yes --max-coins=${Number(first.cost)}`);
        return 1;
    }
    const confirmed = (await (maxCoins === undefined
        ? handlers()['join-challenge'](null, challengeId, true)
        : handlers()['join-challenge'](null, challengeId, true, maxCoins))) as JoinOutcome;
    return (await reportJoin(confirmed, challengeId)) ? 0 : 1;
};

type ForgetLine = { level: 'info' | 'error'; text: (id: string | number) => string };

const FORGET_LINES: Record<ForgetStatus, ForgetLine> = {
    forgotten: {
        level: 'info',
        text: (id) =>
            `Forgot the unconfirmed payment for ${id}. If the coins were in fact taken, joining it again charges you a second time, and auto-join may join it again within its coin budget. Run "join ${id}" to join it: a paid challenge asks for its price as usual.`,
    },
    'nothing-to-forget': {
        level: 'error',
        text: (id) =>
            `Nothing to forget for ${id}: no unconfirmed payment is recorded for it (a payment known to have been taken cannot be forgotten).`,
    },
    'legacy-record': {
        level: 'error',
        text: (id) =>
            `The payment record for ${id} is from an older version of the app and may belong to another GuruShots account used on this device, so it cannot be forgotten here. It stops applying to other accounts once the account that paid joins the challenge through this app, and otherwise clears by itself, at the next check after 30 days. Nothing was changed.`,
    },
    busy: {
        level: 'error',
        text: (id) =>
            `A join of ${id} is in progress, or another process is using the saved payment records. Nothing was changed. Try again in a moment.`,
    },
    'account-unknown': {
        level: 'error',
        text: () =>
            'Could not confirm which account is logged in, so nothing was changed. Try again shortly, or run "login" again.',
    },
    'not-authenticated': {
        level: 'error',
        text: () => 'Not logged in — run "login" first. Nothing was changed.',
    },
    unreadable: {
        level: 'error',
        text: () =>
            'The saved payment records could not be read, so nothing was changed. Restart the app and try again; if it keeps happening, the join-state file needs attention — check the log (logs --error).',
    },
};

/**
 * Forget the unconfirmed payment of a challenge, after the user has checked on GuruShots that its coins were not
 * taken: the next join asks for the price again.
 *
 * @returns the exit code: 0 when it was forgotten, 1 when it was not
 */
const forgetPaymentCmd = async (challengeId: string | number | undefined): Promise<number> => {
    if (!ensureAuthenticated()) return 1;
    if (!challengeId) {
        logger.withCategory('ui').error('Please specify a challenge id');
        logger.withCategory('ui').info('Usage: forget-payment <id>');
        process.exit(1);
    }
    const result = await handlers()['forget-unconfirmed-payment'](null, challengeId);
    // An answer with no status (the handler's own refusals: an invalid id, a failed call) forgot nothing.
    const line = 'status' in result ? FORGET_LINES[result.status] : undefined;
    if (!line) {
        logger.withCategory('ui').error(`Could not forget the payment for ${challengeId} right now. Please try again.`);
        return 1;
    }
    logger.withCategory('ui')[line.level](line.text(challengeId));
    return result.success ? 0 : 1;
};

export { showDiscover, joinChallengeCmd, forgetPaymentCmd };
