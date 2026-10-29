/**
 * CLI one-shot action commands — the parity of the GUI's per-card
 * buttons (boost / turbo). Each reuses the exact code path the GUI
 * invokes: the middleware's index-resolving `applyBoost` (honors
 * `boostImageIndex` and the mock/real API swap), and the `play-auto-turbo`
 * IPC handler called with a null event — the same shape the Capacitor
 * bridge uses. The swap spends (swap / swap-back) reuse their IPC handlers
 * the same way; the shared currency-spend plumbing with unlock-boost /
 * fill-exposure lives in spend.ts, and the submit path in submit.ts. All
 * target a single challenge identified by `--challenge=<id>`; the
 * dispatcher in cli.ts enforces that the flag is present.
 */

import * as logger from '../../logger';
import { resolveChallenge } from '../guards';
import { getMiddleware } from '../../apiFactory';
import { stripTerminalControl } from '../../format/logSafe';
import { CHOSEN_PHOTO_ID_RE } from '../../settings/limits';
import { actionError, describeOutcome, printCost, reportSpend } from './spend';

import type { SwapBackRecord } from '../../types/stores';
import type { NullEventHandlers } from '../../types/cli';
import type * as actions_handlersModule from '../../ipc/actions.handlers';
import type * as currency_handlersModule from '../../ipc/currency.handlers';
import { errorMessage } from '../../errorMessage';
type ActionHandlers = NullEventHandlers<ReturnType<typeof actions_handlersModule.buildHandlers>>;
type CurrencyHandlers = NullEventHandlers<ReturnType<typeof currency_handlersModule.buildHandlers>>;

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

    // A won Turbo cannot be replayed — without --image the play is refused with
    // the apply command, the same one the challenges detail view prints for a
    // WON turbo.
    if (!imageId && challenge.member?.turbo?.state === 'WON') {
        logger
            .withCategory('turbo')
            .error(
                `The Turbo on "${challenge.title}" is already won. Apply it to a photo: turbo --challenge=${challengeId} --image=<photo id> (challenges --challenge=<id> lists the photo ids).`,
            );
        return false;
    }

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

export { boostChallenge, turboChallenge, swapCmd, parseSwapFlags, SWAP_USAGE, swapBackCmd, SWAP_BACK_USAGE };
