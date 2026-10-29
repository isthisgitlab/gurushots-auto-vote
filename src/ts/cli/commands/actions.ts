/**
 * CLI one-shot action commands — the parity of the GUI's per-card
 * buttons (boost / turbo / fill). Each reuses the exact code path the GUI
 * invokes: the middleware's index-resolving `applyBoost` (honors
 * `boostImageIndex` and the mock/real API swap), and the `play-auto-turbo`
 * / `fill-challenge-now` IPC handlers called with a null event — the same
 * shape the Capacitor bridge uses. The currency spends (unlock-boost / swap /
 * fill-exposure) reuse their IPC handlers the same way. All target a single challenge
 * identified by `--challenge=<id>`; the dispatcher in cli.ts enforces that
 * the flag is present.
 */

import * as logger from '../../logger';
import { ensureAuthenticated, INVALID_ID_TEXT } from '../guards';
import { getMiddleware } from '../../apiFactory';
import { findActionableChallenge } from '../../services/findActiveChallenge';
import { stripTerminalControl } from '../../format/logSafe';
import { CHOSEN_PHOTO_ID_RE } from '../../settings/limits';

import type { Challenge } from '../../types/gurushots';
import type { SwapBackRecord } from '../../types/stores';
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

/**
 * Shared auth guard + challenge lookup. Returns the live challenge object,
 * or null after logging a user-facing reason (not authenticated / not found
 * / data cannot be read / fetch failure) so callers can simply bail on null.
 *
 * Note: the turbo/fill handlers re-fetch and re-validate the live challenge
 * themselves, so this lookup is the friendly auth gate + early "not found"
 * (and the source of the title for logging), not the authoritative state
 * check — don't remove the handlers' own fetch on the assumption this covers it.
 */
const resolveChallenge = async (challengeId: string): Promise<Challenge | null> => {
    if (!ensureAuthenticated()) {
        return null;
    }
    try {
        const resp = await getMiddleware().getActiveChallenges();
        const found = findActionableChallenge(resp, challengeId);
        if ('refused' in found) {
            // The handlers re-read below refuse the same way, so bailing here
            // only spares the round trip; the wording is the user-facing part.
            if (found.refused === 'data-incomplete') {
                logger.withCategory('challenges').error(`Challenge ${challengeId}: challenge data cannot be read`);
            } else {
                logger.withCategory('challenges').error(`Challenge ${challengeId} not found among active challenges`);
            }
            return null;
        }
        return found.challenge;
    } catch (err) {
        logger.withCategory('challenges').error(`Failed to fetch challenges: ${errorMessage(err) || err}`);
        return null;
    }
};

/**
 * Apply a boost to a single challenge. With `--image=<id>` the explicit
 * entry is boosted via the same handler the GUI card button uses; otherwise
 * the auto-cycle's `applyBoost` picks the entry from `boostImageIndex`.
 */
const boostChallenge = async (challengeId: string, { imageId = null }: { imageId?: string | null } = {}) => {
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return;

    try {
        if (imageId) {
            const result = await handlers()['apply-boost-to-entry'](null, challengeId, imageId);
            if (result?.success) {
                logger.withCategory('boost').success(`Boost applied to image ${imageId} in "${challenge.title}"`);
            } else {
                logger.withCategory('boost').error(actionError(result, 'Failed to apply boost'));
            }
            return;
        }

        // Route through the middleware so mock mode stays on the mock API
        // surface — the middleware injects the token itself.
        const response = await getMiddleware().applyBoost(challenge);
        if (response) {
            logger.withCategory('boost').success(`Boost applied to "${challenge.title}"`);
        } else {
            logger
                .withCategory('boost')
                .error(
                    `Failed to apply boost to "${challenge.title}" (see log for reason). To boost one photo yourself, pass --image=<id>`,
                );
        }
    } catch (err) {
        logger.withCategory('boost').error(`Failed to apply boost: ${errorMessage(err) || err}`);
    }
};

/**
 * Play the Turbo mini-game on a single challenge — or, with `imageId`, apply
 * an already-won Turbo to that photo through the same handler the GUI entry
 * badge uses (the play path delegates to play-auto-turbo, which resolves the
 * entry via turboImageIndex and runs the full mini-game loop). Returns true
 * when the Turbo was earned or applied, so the command exits 1 on a refusal,
 * an unknown challenge, or a thrown error.
 */
const turboChallenge = async (
    challengeId: string,
    { imageId = null }: { imageId?: string | null } = {},
): Promise<boolean> => {
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return false;

    try {
        if (imageId) {
            const result = await handlers()['apply-turbo-to-entry'](null, challengeId, imageId);
            if (result?.success) {
                logger.withCategory('turbo').success(`Turbo applied to image ${imageId} in "${challenge.title}"`);
                return true;
            }
            // The error can carry the API's own wording (the raw upstream
            // message), so it is stripped before it reaches the terminal.
            logger.withCategory('turbo').error(stripTerminalControl(actionError(result, 'Failed to apply turbo')));
            return false;
        }
        const result = await handlers()['play-auto-turbo'](null, challengeId, challenge.title);
        if (result?.success) {
            logger.withCategory('turbo').success(`Turbo earned on "${challenge.title}"`);
            return true;
        }
        logger.withCategory('turbo').error(stripTerminalControl(actionError(result, 'Turbo not earned')));
        return false;
    } catch (err) {
        logger.withCategory('turbo').error(`Failed to play turbo: ${stripTerminalControl(errorMessage(err) || err)}`);
        return false;
    }
};

// The wording both submit paths (fill-challenge-now and submit-picked-photos)
// share for the handler's fixed error codes: what happened and what to do next.
// 'submit-unclear' is never shown as a failure — the photo(s) may have been
// submitted, so it exits 2 instead of 1.
const SUBMIT_OUTCOME_TEXT: Record<string, string> = {
    'not-enough-slots':
        'The challenge has fewer open slots than photos to submit, so nothing was sent. Submit fewer photos, or wait for a slot to free up.',
    'already-entered':
        'One of those photos is already entered in this challenge, so nothing was sent. Submit without it.',
    'submit-rejected':
        'GuruShots rejected the submit, so nothing was sent. Check the challenge on the GuruShots website, then try again.',
    'submit-busy': 'A submit for this challenge is already running. Wait for it to finish, then run the command again.',
    'submit-unclear':
        'The submit got no answer, so the photo(s) may have been submitted. Check the challenge before retrying.',
};

// The line for a failed submit reply: the fixed submit codes are worded from the
// shared table — 'submit-unclear' as a warning, never as a failure — and any
// other error (the invalid-id wording, a challenge-data-incomplete refusal, a
// free-text message carrying API wording) is stripped before it reaches the
// terminal. Returns the exit code: 2 for unclear, 1 otherwise.
const reportSubmitFailure = (result: { error?: string | null } | null | undefined): number => {
    const code = result?.error;
    if (code === 'submit-unclear') {
        logger.withCategory('autoSubmit').warning(SUBMIT_OUTCOME_TEXT['submit-unclear']);
        return 2;
    }
    const text =
        code !== undefined && code !== null && Object.hasOwn(SUBMIT_OUTCOME_TEXT, code)
            ? SUBMIT_OUTCOME_TEXT[code]
            : actionError(result, 'Failed to submit photos');
    logger.withCategory('autoSubmit').error(stripTerminalControl(text));
    return 1;
};

/**
 * Submit photo(s) to a challenge's empty slots through the auto-fill path
 * (`fill-challenge-now`). `--all` submits to every empty slot; otherwise a
 * single best-ranked eligible photo is submitted. Returns the exit code:
 * 0 sent, 2 the submit got no answer (it may have landed), 1 every other
 * failure, including an unknown challenge or a thrown handler.
 */
const fillChallenge = async (challengeId: string, { all = false }: { all?: boolean } = {}): Promise<number> => {
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return 1;

    const mode = all ? 'all' : 'one';
    try {
        const result = await handlers()['fill-challenge-now'](null, challengeId, mode);
        if (result?.success) {
            logger
                .withCategory('autoSubmit')
                .success(
                    `${result.message || `Submitted photos to "${challenge.title}"`} (submitted ${result.submitted ?? 0}, skipped ${result.skipped ?? 0})`,
                );
            return 0;
        }
        return reportSubmitFailure(result);
    } catch (err) {
        logger
            .withCategory('autoSubmit')
            .error(`Failed to submit photos: ${stripTerminalControl(errorMessage(err) || err)}`);
        return 1;
    }
};

/**
 * Submit exactly the photos named with `--image=<id>[,<id>…]` through the same
 * handler the card's picked-photos submit uses (submit-picked-photos): no
 * ranking, no tag rules — the ids go to the challenge as given. Returns the
 * exit code: 0 sent, 2 unclear (may have landed), 1 every other failure.
 */
const submitPickedCmd = async (challengeId: string, imageIds: string[]): Promise<number> => {
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return 1;
    try {
        const result = await handlers()['submit-picked-photos'](null, challengeId, imageIds);
        if (result?.success) {
            logger
                .withCategory('autoSubmit')
                .success(`Submitted ${result.submitted} photo(s) to "${challenge.title}".`);
            return 0;
        }
        return reportSubmitFailure(result);
    } catch (err) {
        logger
            .withCategory('autoSubmit')
            .error(`Failed to submit photos: ${stripTerminalControl(errorMessage(err) || err)}`);
        return 1;
    }
};

// ---- bankroll-currency spends (key unlock / swap / exposure fill) ----
//
// Mirror of `join <id> [--yes]`: without --yes nothing is spent — the command
// prints what would happen and the exact re-run line. The handlers enforce the
// same gate main-side (confirmed === true), so --yes is the only way to spend.

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

const SWAP_USAGE = 'Usage: swap --challenge=<id> --image=<id> [--to=<id>] [--yes]';
const SWAP_BACK_USAGE = 'Usage: swap-back --challenge=<id>  |  swap-back --challenge=<id> --image=<id> [--yes]';

/**
 * Reads swap's own flags from the args left after --challenge:
 * --image=<id> (the entry to replace), --to=<id> (the photo to swap in), --yes.
 */
const parseSwapFlags = (rest: string[]) => {
    const flag = (name: string) => {
        const arg = rest.find((a) => a.startsWith(`--${name}=`));
        return arg ? arg.slice(name.length + 3) || null : null;
    };
    return { imageId: flag('image'), to: flag('to'), yes: rest.includes('--yes') };
};

/**
 * Spend a SWAP to replace entered photo `imageId`. Without --to the dry run
 * prints the app's best-ranked different photo, and --yes must repeat it as
 * --to=<id>. With --to the named photo is the replacement, as chosen (nothing
 * is ranked; the server checks eligibility when the swap is spent): the dry run
 * prints it, and --to=<id> --yes spends it.
 * Returns false on a usage error (no --image), true otherwise.
 */
const swapCmd = async (
    challengeId: string,
    { imageId, to = null, yes = false }: { imageId?: string | null; to?: string | null; yes?: boolean } = {},
): Promise<boolean> => {
    if (!imageId) {
        logger.withCategory('ui').error('Please specify the entered photo to replace with --image=<id>');
        logger.withCategory('ui').info(SWAP_USAGE);
        return false;
    }
    if (to && !CHOSEN_PHOTO_ID_RE.test(to)) {
        logger.withCategory('ui').error('Invalid --to photo id: use the id list-photos --challenge=<id> shows.');
        return true;
    }
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return true;
    try {
        const preview = await currencyHandlers()['preview-swap-photo'](null, challengeId, imageId, to ?? undefined);
        if (!preview?.success) {
            logger.withCategory('currency').error(describeOutcome(preview));
            return true;
        }
        const newId = preview.candidate.id;
        if (!yes) {
            logger.withCategory('currency').info(`Swap in "${challenge.title}": ${imageId} → ${newId}`);
            await printCost('swaps');
            if (to) {
                logger
                    .withCategory('currency')
                    .info(
                        `GuruShots checks that the challenge accepts ${newId} when the swap is spent; list-photos --challenge=${challengeId} shows the photos it accepts.`,
                    );
            }
            logger
                .withCategory('currency')
                .info(
                    `To spend the swap, re-run: swap --challenge=${challengeId} --image=${imageId} --to=${newId} --yes`,
                );
            return true;
        }
        if (!to) {
            logger
                .withCategory('currency')
                .error(`Add --to=${newId} to confirm the replacement (run without --yes first to review it).`);
            return true;
        }
        const result = await currencyHandlers()['swap-entry-photo'](null, challengeId, imageId, newId, true);
        reportSpend(result, `Swapped ${imageId} → ${newId} in "${challenge.title}".`);
    } catch (err) {
        logger.withCategory('currency').error(`Failed to swap photo: ${errorMessage(err) || err}`);
    }
    return true;
};

/**
 * What each stored swap-back kind reads as in the CLI lines: a fixed map, never
 * a key built from the stored value.
 */
const SWAP_BACK_KINDS: Record<SwapBackRecord['kind'], string> = {
    boost: 'boost',
    turbo: 'turbo',
    guruPick: "Guru's pick",
};

/**
 * Spend a SWAP to put a photo swapped out while boosted, turbo'd or guru-picked
 * back into the slot now holding `imageId` — it gets its boost/turbo/Guru's
 * pick back. Without `imageId` the command is a read-only listing: one line per
 * recorded offer, or an info line when none is recorded. Only swaps made
 * through this app are known (the mobile swap history has no such flag; the web
 * one's the app does not read).
 * Returns false on a failed read or spend (exit 1), true otherwise.
 */
const swapBackCmd = async (
    challengeId: string,
    { imageId, yes = false }: { imageId?: string | null; yes?: boolean } = {},
) => {
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return false;
    try {
        const list = await currencyHandlers()['get-swap-backs'](null, challengeId);
        if (!list?.success) {
            logger
                .withCategory('currency')
                .error(
                    `Could not read the recorded swap backs: ${stripTerminalControl(String(list?.error ?? 'no answer'))}. Try again in a moment.`,
                );
            return false;
        }
        if (!imageId) {
            if (list.items.length === 0) {
                logger.withCategory('currency').info(`No swap back is recorded for "${challenge.title}".`);
                return true;
            }
            for (const record of list.items) {
                logger
                    .withCategory('currency')
                    .info(
                        `${stripTerminalControl(record.currentId)} → ${stripTerminalControl(record.previousId)} (gets its ${SWAP_BACK_KINDS[record.kind]} back)`,
                    );
            }
            return true;
        }
        const record = list.items.find((r) => r.currentId === String(imageId));
        if (!record) {
            logger.withCategory('currency').error(`No swap back is recorded for ${imageId} in "${challenge.title}".`);
            return false;
        }
        if (!yes) {
            logger
                .withCategory('currency')
                .info(
                    `Swap back in "${challenge.title}": ${imageId} → ${record.previousId} (gets its ${SWAP_BACK_KINDS[record.kind]} back)`,
                );
            await printCost('swaps');
            logger
                .withCategory('currency')
                .info(`To spend the swap, re-run: swap-back --challenge=${challengeId} --image=${imageId} --yes`);
            return true;
        }
        const result = await currencyHandlers()['swap-back-entry-photo'](null, challengeId, imageId, true);
        reportSpend(
            result,
            `Swapped ${record.previousId} back into "${challenge.title}" — its ${SWAP_BACK_KINDS[record.kind]} is back.`,
        );
    } catch (err) {
        logger.withCategory('currency').error(`Failed to swap back: ${stripTerminalControl(errorMessage(err) || err)}`);
        return false;
    }
    return true;
};

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

export {
    boostChallenge,
    resolveChallenge,
    actionError,
    turboChallenge,
    fillChallenge,
    submitPickedCmd,
    unlockBoostCmd,
    swapCmd,
    parseSwapFlags,
    SWAP_USAGE,
    swapBackCmd,
    SWAP_BACK_USAGE,
    fillExposureCmd,
};
