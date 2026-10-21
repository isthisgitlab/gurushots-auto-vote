/**
 * CLI join commands: `discover` lists un-joined challenges (the open ones, and the upcoming ones
 * starting within `discoverUpcomingHours` — a capped one shows `players/max` (· Full when it is
 * full), and a join-unlock price GuruShots did not send readably shows as `price unknown`), and
 * `join <id> [--yes]` joins one. Paid joins (join_coins > 0) print the coin
 * cost and require an explicit `--yes` — `join <id>` alone never spends coins.
 * Reuses the shared IPC handlers so the join safety model lives in one place.
 */

import * as logger from '../../logger';
import { ensureAuthenticated, INVALID_ID_TEXT } from '../guards';
import { stripTerminalControl } from '../../format/logSafe';
import { formatDuration } from '../../format/duration';
import { challengeKind, challengePhotoCount, listedTags } from '../../format/challengeListing';
import { endTimeOf, formatEndTimeIn } from '../../format/endTime';
import * as settings from '../../settings';
import { effectiveTimezone } from '../../settings/uiDefaults';
import { joinFreshRefusal } from '../../services/VotingLogic';

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

type DiscoverItem = Pick<
    OpenChallenge,
    | 'id'
    | 'title'
    | 'url'
    | 'type'
    | 'badge'
    | 'tags'
    | 'max_photo_submits'
    | 'status'
    | 'join_coins'
    | 'start_time'
    | 'close_time'
    | 'players'
    | 'max_players'
    | 'member'
>;

/** One row of the listing. Everything that came from the server is stripped of terminal control. */
const discoverLine = (c: DiscoverItem, nowSec: number, timezone: string): string => {
    // The join-safety read the auto-joiner also makes: what would stop this challenge from joining.
    const refusal = joinFreshRefusal(c);
    // A number, whatever the server sent: it is printed as text.
    const coins = Number(c?.join_coins);
    // A price GuruShots did not send readably is not implied to be free.
    const cost = refusal === 'price-unknown' ? 'price unknown' : coins > 0 ? `${coins} coins` : 'free';
    const name = stripTerminalControl(c?.title || c?.url || 'untitled');
    const type = stripTerminalControl(challengeKind(c)?.label || '?');
    const photoCount = challengePhotoCount(c);
    const photos = photoCount === null ? '' : ` — ${photoCount} photos`;
    // Stripped first: a tag that is nothing but control characters is then empty, and not listed.
    const tags = listedTags(c)
        .map((tag) => stripTerminalControl(tag).trim())
        .filter(Boolean);
    const tagList = tags.length > 0 ? ` — tags: ${tags.join(', ')}` : '';
    const timing = c?.status === 'upcoming' ? ` — starts in ${formatDuration(Number(c.start_time) - nowSec)}` : '';
    // The end time, as the challenge card shows it: in the app's timezone setting, not the device clock.
    const close = endTimeOf(c?.close_time);
    const ends = close === null ? '' : ` — ends ${formatEndTimeIn(close, timezone, 'en-GB')}`;
    // Capacity, only when both sides of the fraction are readable: `players/max`, and · Full when nothing more can join.
    const maxPlayers = Number(c?.max_players);
    const players = Number(c?.players);
    const capacity =
        Number.isFinite(maxPlayers) && maxPlayers > 0 && Number.isFinite(players)
            ? ` — ${players}/${maxPlayers}${refusal === 'full' ? ' · Full' : ''}`
            : '';
    return `  • [${stripTerminalControl(String(c?.id))}] ${name} (${type})${photos} — ${cost}${capacity}${tagList}${timing}${ends}`;
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
    const timezone = effectiveTimezone(settings.getSetting('timezone'));
    items.forEach((c) => logger.withCategory('ui').info(discoverLine(c, nowSec, timezone)));
    const upcoming = items.filter((c) => c?.status === 'upcoming');
    // Only a challenge that has started can be joined: a list of upcoming ones alone has nothing to join yet.
    if (upcoming.length < items.length) {
        logger.withCategory('ui').info('Join with: join <id>          (free challenges)');
        logger
            .withCategory('ui')
            .info('           join <id> --yes --max-coins=<cost>    (paid challenges — spends up to that many coins)');
    }
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
const unconfirmedText = (challengeId: string | number, balances: { before?: number; now: number | null }) => {
    const rerun = `Re-run "join ${challengeId}": it only submits your photo, so you are never charged twice.`;
    return `The payment for ${challengeId} got no answer, so it may or may not have gone through, and the join did not finish.${balanceHint(balances.before, balances.now)} ${rerun} If the GuruShots website shows the coins were not taken, run "forget-payment ${challengeId}" and join again.`;
};

/** The most a confirmed join may spend: what `--max-coins` said, or else the cost that was printed first. */
type SpendCap = { coins: number; named: boolean };

const capText = (cap: SpendCap | undefined): string =>
    cap && !cap.named ? `the ${cap.coins} coins shown` : '--max-coins allows';

// Map a join outcome status to a user-facing line; null for an unknown status.
const joinLine = (
    result: JoinOutcome | null | undefined,
    challengeId: string | number,
    coinsNow: number | null,
    cap?: SpendCap,
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
                    text: `Coins were already spent on ${challengeId}, but no photo qualifies for this challenge. Add an eligible photo, then re-run "join ${challengeId}" — you will NOT be charged again. If you use Must Include Tags, or have turned off Submit Even Without a Tag Match, those can also be what blocks the pick.`,
                };
            }
            if (result?.reason === 'unconfirmed') {
                return {
                    level: 'error',
                    text: unconfirmedText(challengeId, { before: result.coinsBefore, now: coinsNow }),
                };
            }
            return {
                level: 'error',
                text: `Coins were charged for ${challengeId} but the join did not complete. Re-run "join ${challengeId}" to retry the submit — you will NOT be charged again.`,
            };
        case 'failed-no-charge':
            if (result?.reason === 'already-joined') {
                return {
                    level: 'info',
                    text: `This account has already joined ${challengeId}; nothing was spent.`,
                };
            }
            if (result?.reason === 'full') {
                return {
                    level: 'error',
                    text: `Challenge ${challengeId} is full, so this attempt to join it spent no coins. Join another one, or check it on gurushots.com.`,
                };
            }
            if (result?.reason === 'price-unknown') {
                return {
                    level: 'error',
                    text: `GuruShots did not send the price for ${challengeId}, so it is not known what joining costs — no coins were charged. Run "discover" again to refresh it, or join the challenge on gurushots.com.`,
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
                text: `Challenge ${challengeId} costs ${Number(result?.cost)} coins, more than ${capText(cap)}. Nothing was spent — to pay this cost, re-run: join ${challengeId} --yes --max-coins=${Number(result?.cost)}`,
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
const reportJoin = async (
    result: JoinOutcome | null | undefined,
    challengeId: string | number,
    cap?: SpendCap,
): Promise<boolean> => {
    const line = joinLine(result, challengeId, await coinsNow(result), cap);
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
 * names that cost as `--max-coins`: a challenge whose live cost has risen above it is not joined.
 * `--yes` alone caps the spend at the cost printed first.
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
    // Without --max-coins the cap is the cost just printed: a price that rises in between is not spent on.
    const cap = { coins: maxCoins ?? Number(first.cost), named: maxCoins !== undefined };
    const confirmed = (await handlers()['join-challenge'](null, challengeId, true, cap.coins)) as JoinOutcome;
    return (await reportJoin(confirmed, challengeId, cap)) ? 0 : 1;
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
    busy: {
        level: 'error',
        text: (id) =>
            `A join of ${id} is in progress, or another process is using the saved payment records. Nothing was changed. Try again in a moment.`,
    },
    'locks-unavailable': {
        level: 'error',
        text: () =>
            'The app cannot create its lock files in its data folder, so it cannot do this safely. Nothing was changed. Check the folder’s permissions and the free disk space (logs --error has the details), then try again.',
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
