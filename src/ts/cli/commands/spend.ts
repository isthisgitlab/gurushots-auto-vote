/**
 * CLI bankroll-currency spends: the shared outcome wording, the cost preview
 * and the spend reporting behind unlock-boost / swap / swap-back /
 * fill-exposure, plus the two single-step spends (unlock-boost and
 * fill-exposure) that drive it.
 *
 * Mirror of `join <id> [--yes]`: without --yes nothing is spent — the command
 * prints what would happen and the exact re-run line. The handlers enforce the
 * same gate main-side (confirmed === true), so --yes is the only way to spend.
 */

import * as logger from '../../logger';
import { resolveChallenge, INVALID_ID_TEXT } from '../guards';

import type { NullEventHandlers } from '../../types/cli';
import type * as actions_handlersModule from '../../ipc/actions.handlers';
import type * as currency_handlersModule from '../../ipc/currency.handlers';
import { errorMessage } from '../../errorMessage';
type ActionHandlers = NullEventHandlers<ReturnType<typeof actions_handlersModule.buildHandlers>>;
type CurrencyHandlers = NullEventHandlers<ReturnType<typeof currency_handlersModule.buildHandlers>>;
type CurrencyField = 'keys' | 'swaps' | 'fills';

// Built lazily on first use so simply requiring this module (e.g. when the
// dispatcher loads it for `help` or `logout`) does not construct the handler
// set or pull in its transitive dependencies.
let _handlers: ActionHandlers | undefined;
const handlers = (): ActionHandlers =>
    (_handlers ??= (
        require('../../ipc/actions.handlers') as typeof import('../../ipc/actions.handlers')
    ).buildHandlers());
let _currencyHandlers: CurrencyHandlers | undefined;
const currencyHandlers = (): CurrencyHandlers =>
    (_currencyHandlers ??= (
        require('../../ipc/currency.handlers') as typeof import('../../ipc/currency.handlers')
    ).buildHandlers());

// CLI wording for each outcome code the spend handlers return.
// The refusal for a challenge whose data cannot be read (the boundary's mark),
// shared by the outcome table and the error mapping.
const CHALLENGE_DATA_INCOMPLETE_TEXT = "The challenge's data cannot be read, so the action was refused.";

const OUTCOME_TEXT: Record<string, string> = {
    'not-available': 'That action is not available on this challenge right now (it may already be done).',
    'data-incomplete': CHALLENGE_DATA_INCOMPLETE_TEXT,
    'no-balance': 'You have none of that currency left.',
    'balance-unknown': 'Could not read your balance, so nothing was spent. Try again shortly.',
    'no-alternative': 'No different photo is available to swap in.',
    'stale-candidate': 'The swap offer expired or changed since the preview. Nothing was spent — run the swap again.',
    'already-entered':
        'That photo is already entered in this challenge. Nothing was spent — run the swap again with a different photo.',
    busy: 'Another currency action is still running. Try again in a moment.',
    'invalid-args': INVALID_ID_TEXT,
    unclear:
        'The request got no answer, so it may or may not have gone through. Check the challenge (or your balance) before trying again.',
    'api-failed': 'GuruShots rejected the request. Nothing further was attempted — check the log for details.',
};

const describeOutcome = (result: { outcome?: string | null; error?: string | null } | null | undefined): string =>
    OUTCOME_TEXT[result?.outcome ?? ''] || result?.error || 'Action failed';

// The line for a failed boost / turbo / fill reply: the handlers' 'invalid-args'
// code becomes its wording, a 'challenge-data-incomplete' refusal (the handlers
// re-read the challenge themselves) becomes its wording, and any other error is
// already a message.
const actionError = (result: { error?: string | null } | null | undefined, fallback: string): string =>
    result?.error === 'invalid-args'
        ? INVALID_ID_TEXT
        : result?.error === 'challenge-data-incomplete'
          ? CHALLENGE_DATA_INCOMPLETE_TEXT
          : result?.error || fallback;

const CURRENCY_LABEL = { keys: 'key', swaps: 'swap', fills: 'fill' };

const readBalance = async (field: CurrencyField): Promise<number | null> => {
    const bankroll = await handlers()['get-bankroll'](null);
    return bankroll?.success ? Number(bankroll[field]) : null;
};

const printCost = async (field: CurrencyField) => {
    const balance = await readBalance(field);
    const label = CURRENCY_LABEL[field];
    const line =
        balance === null
            ? `Cost: 1 ${label} (balance could not be read).`
            : `Cost: 1 ${label} — balance ${balance} → ${Math.max(balance - 1, 0)}.`;
    logger.withCategory('currency').info(line);
};

const reportSpend = (
    result: { success?: boolean; outcome?: string | null; error?: string | null } | null | undefined,
    successText: string,
) => {
    if (result?.success) {
        logger.withCategory('currency').success(successText);
    } else {
        logger.withCategory('currency').error(describeOutcome(result));
    }
};

/**
 * The shape both single-step spends (unlock-boost, fill-exposure) share: the
 * dry run prints what would happen, its cost and the exact re-run line; --yes
 * runs `spend` and reports its outcome.
 */
const spendOnChallenge = async (
    challengeId: string,
    yes: boolean,
    spend: {
        command: string;
        field: CurrencyField;
        failure: string;
        preview: (title: string) => string;
        success: (title: string) => string;
        run: () => Promise<Parameters<typeof reportSpend>[0]>;
    },
) => {
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return;
    try {
        if (!yes) {
            logger.withCategory('currency').info(spend.preview(challenge.title));
            await printCost(spend.field);
            logger
                .withCategory('currency')
                .info(
                    `To spend the ${CURRENCY_LABEL[spend.field]}, re-run: ${spend.command} --challenge=${challengeId} --yes`,
                );
            return;
        }
        reportSpend(await spend.run(), spend.success(challenge.title));
    } catch (err) {
        logger.withCategory('currency').error(`Failed to ${spend.failure}: ${errorMessage(err) || err}`);
    }
};

/**
 * Spend a KEY to unlock the challenge's locked boost (unlock only).
 */
const unlockBoostCmd = async (challengeId: string, { yes = false }: { yes?: boolean } = {}) =>
    spendOnChallenge(challengeId, yes, {
        command: 'unlock-boost',
        field: 'keys',
        failure: 'unlock boost',
        preview: (title) => `Unlock the boost on "${title}" with a key.`,
        success: (title) => `Boost unlocked on "${title}" (not applied yet).`,
        run: () => currencyHandlers()['key-unlock-boost'](null, challengeId, true),
    });

/**
 * Spend a FILL to top the challenge's exposure up to 100%.
 */
const fillExposureCmd = async (challengeId: string, { yes = false }: { yes?: boolean } = {}) =>
    spendOnChallenge(challengeId, yes, {
        command: 'fill-exposure',
        field: 'fills',
        failure: 'fill exposure',
        preview: (title) => `Fill the exposure of "${title}" to 100%.`,
        success: (title) => `Exposure filled on "${title}".`,
        run: () => currencyHandlers()['fill-exposure'](null, challengeId, true),
    });

export { actionError, describeOutcome, printCost, reportSpend, unlockBoostCmd, fillExposureCmd };
