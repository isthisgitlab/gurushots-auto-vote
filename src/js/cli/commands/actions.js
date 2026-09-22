/**
 * CLI one-shot action commands — the parity of the GUI's per-card
 * buttons (boost / turbo / fill). Each reuses the exact code path the GUI
 * invokes: the middleware's index-resolving `applyBoost` (honors
 * `boostImageIndex` and the mock/real API swap), and the `play-auto-turbo`
 * / `fill-challenge-now` IPC handlers called with a null event — the same
 * shape the Capacitor bridge uses. The currency spends (unlock-boost / swap /
 * fill-exposure) reuse their IPC handlers the same way. All target a single challenge
 * identified by `--challenge=<id>`; the dispatcher in cli.js enforces that
 * the flag is present.
 */

const logger = require('../../logger');
const { ensureAuthenticated } = require('../guards');
const { getMiddleware } = require('../../apiFactory');
const { findActiveChallenge } = require('../../services/findActiveChallenge');

// Built lazily on first use so simply requiring this module (e.g. when the
// dispatcher loads it for `help` or `logout`) does not construct the handler
// set or pull in its transitive dependencies.
let _handlers;
const handlers = () => (_handlers ??= require('../../ipc/actions.handlers').buildHandlers());
let _currencyHandlers;
const currencyHandlers = () => (_currencyHandlers ??= require('../../ipc/currency.handlers').buildHandlers());

/**
 * Shared auth guard + challenge lookup. Returns the live challenge object,
 * or null after logging a user-facing reason (not authenticated / not found
 * / fetch failure) so callers can simply bail on null.
 *
 * Note: the turbo/fill handlers re-fetch and re-validate the live challenge
 * themselves, so this lookup is the friendly auth gate + early "not found"
 * (and the source of the title for logging), not the authoritative state
 * check — don't remove the handlers' own fetch on the assumption this covers it.
 */
const resolveChallenge = async (challengeId) => {
    if (!ensureAuthenticated()) {
        return null;
    }
    try {
        const resp = await getMiddleware().getActiveChallenges();
        const challenge = findActiveChallenge(resp?.challenges, challengeId);
        if (!challenge) {
            logger.withCategory('challenges').error(`Challenge ${challengeId} not found among active challenges`);
            return null;
        }
        return challenge;
    } catch (err) {
        logger.withCategory('challenges').error(`Failed to fetch challenges: ${err?.message || err}`);
        return null;
    }
};

/**
 * Apply a boost to a single challenge. With `--image=<id>` the explicit
 * entry is boosted via the same handler the GUI card button uses; otherwise
 * the auto-cycle's `applyBoost` picks the entry from `boostImageIndex`.
 */
const boostChallenge = async (challengeId, { imageId = null } = {}) => {
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return;

    try {
        if (imageId) {
            const result = await handlers()['apply-boost-to-entry'](null, challengeId, imageId);
            if (result?.success) {
                logger.withCategory('boost').success(`Boost applied to image ${imageId} in "${challenge.title}"`);
            } else {
                logger.withCategory('boost').error(result?.error || 'Failed to apply boost');
            }
            return;
        }

        // Route through the middleware so mock mode stays on the mock API
        // surface — the middleware injects the token itself.
        const response = await getMiddleware().applyBoost(challenge);
        if (response) {
            logger.withCategory('boost').success(`Boost applied to "${challenge.title}"`);
        } else {
            logger.withCategory('boost').error(`Failed to apply boost to "${challenge.title}" (see log for reason)`);
        }
    } catch (err) {
        logger.withCategory('boost').error(`Failed to apply boost: ${err?.message || err}`);
    }
};

/**
 * Play the Turbo mini-game on a single challenge. Delegates to the
 * play-auto-turbo handler, which resolves the entry (turboImageIndex) and
 * runs the full mini-game loop.
 */
const turboChallenge = async (challengeId) => {
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return;

    try {
        const result = await handlers()['play-auto-turbo'](null, challengeId, challenge.title);
        if (result?.success) {
            logger.withCategory('turbo').success(`Turbo earned on "${challenge.title}"`);
        } else {
            logger.withCategory('turbo').error(result?.error || 'Turbo not earned');
        }
    } catch (err) {
        logger.withCategory('turbo').error(`Failed to play turbo: ${err?.message || err}`);
    }
};

/**
 * Submit photo(s) to a challenge's empty slots. `--all` fills every empty
 * slot; otherwise a single best-ranked eligible photo is submitted.
 */
const fillChallenge = async (challengeId, { all = false } = {}) => {
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return;

    const mode = all ? 'all' : 'one';
    try {
        const result = await handlers()['fill-challenge-now'](null, challengeId, mode);
        if (result?.success) {
            logger
                .withCategory('autoFill')
                .success(
                    `${result.message || `Filled "${challenge.title}"`} (submitted ${result.submitted ?? 0}, skipped ${result.skipped ?? 0})`,
                );
        } else {
            logger.withCategory('autoFill').error(result?.error || 'Failed to fill challenge');
        }
    } catch (err) {
        logger.withCategory('autoFill').error(`Failed to fill challenge: ${err?.message || err}`);
    }
};

// ---- bankroll-currency spends (key unlock / swap / exposure fill) ----
//
// Mirror of `join <id> [--yes]`: without --yes nothing is spent — the command
// prints what would happen and the exact re-run line. The handlers enforce the
// same gate main-side (confirmed === true), so --yes is the only way to spend.

// CLI wording for each outcome code the spend handlers return.
const OUTCOME_TEXT = {
    'not-available': 'That action is not available on this challenge right now (it may already be done).',
    'no-balance': 'You have none of that currency left.',
    'balance-unknown': 'Could not read your balance, so nothing was spent. Try again shortly.',
    'no-alternative': 'No different photo is available to swap in.',
    'stale-candidate':
        'The replacement photo changed since the preview. Nothing was spent — re-run without --yes to see the new suggestion.',
    busy: 'Another currency action is still running. Try again in a moment.',
    'invalid-args': 'Invalid challenge or image id.',
    'api-failed': 'GuruShots rejected the request. Nothing further was attempted — check the log for details.',
};

const describeOutcome = (result) => OUTCOME_TEXT[result?.outcome] || result?.error || 'Action failed';

const CURRENCY_LABEL = { keys: 'key', swaps: 'swap', fills: 'fill' };

const readBalance = async (field) => {
    const bankroll = await handlers()['get-bankroll'](null);
    return bankroll?.success ? Number(bankroll[field]) : null;
};

const printCost = async (field) => {
    const balance = await readBalance(field);
    const label = CURRENCY_LABEL[field];
    const line =
        balance === null
            ? `Cost: 1 ${label} (balance could not be read).`
            : `Cost: 1 ${label} — balance ${balance} → ${Math.max(balance - 1, 0)}.`;
    logger.withCategory('currency').info(line);
};

const reportSpend = (result, successText) => {
    if (result?.success) {
        logger.withCategory('currency').success(successText);
    } else {
        logger.withCategory('currency').error(describeOutcome(result));
    }
};

/**
 * Spend a KEY to unlock the challenge's locked boost (unlock only).
 */
const unlockBoostCmd = async (challengeId, { yes = false } = {}) => {
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return;
    try {
        if (!yes) {
            logger.withCategory('currency').info(`Unlock the boost on "${challenge.title}" with a key.`);
            await printCost('keys');
            logger
                .withCategory('currency')
                .info(`To spend the key, re-run: unlock-boost --challenge=${challengeId} --yes`);
            return;
        }
        const result = await currencyHandlers()['key-unlock-boost'](null, challengeId, true);
        reportSpend(result, `Boost unlocked on "${challenge.title}" (not applied yet).`);
    } catch (err) {
        logger.withCategory('currency').error(`Failed to unlock boost: ${err?.message || err}`);
    }
};

const SWAP_USAGE = 'Usage: swap --challenge=<id> --image=<id> [--to=<id> --yes]';
const SWAP_BACK_USAGE = 'Usage: swap-back --challenge=<id> --image=<id> [--yes]';

/**
 * Reads swap's own flags from the args left after --challenge:
 * --image=<id> (the entry to replace), --to=<id> (the confirmed replacement), --yes.
 */
const parseSwapFlags = (rest) => {
    const flag = (name) => {
        const arg = rest.find((a) => a.startsWith(`--${name}=`));
        return arg ? arg.slice(name.length + 3) || null : null;
    };
    return { imageId: flag('image'), to: flag('to'), yes: rest.includes('--yes') };
};

/**
 * Spend a SWAP to replace entered photo `imageId` with the app's best-ranked
 * different photo. The dry run prints the suggested replacement; --yes must
 * repeat it as --to=<id>, and is refused if the suggestion changed since.
 * Returns false on a usage error (no --image).
 */
const swapCmd = async (challengeId, { imageId, to = null, yes = false } = {}) => {
    if (!imageId) {
        logger.withCategory('ui').error('Please specify the entered photo to replace with --image=<id>');
        logger.withCategory('ui').info(SWAP_USAGE);
        return false;
    }
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return;
    try {
        const preview = await currencyHandlers()['preview-swap-photo'](null, challengeId, imageId);
        if (!preview?.success) {
            logger.withCategory('currency').error(describeOutcome(preview));
            return;
        }
        const newId = preview.candidate.id;
        if (!yes) {
            logger.withCategory('currency').info(`Swap in "${challenge.title}": ${imageId} → ${newId}`);
            await printCost('swaps');
            logger
                .withCategory('currency')
                .info(
                    `To spend the swap, re-run: swap --challenge=${challengeId} --image=${imageId} --to=${newId} --yes`,
                );
            return;
        }
        if (!to || to !== newId) {
            logger
                .withCategory('currency')
                .error(
                    to
                        ? `The suggested replacement is now ${newId}, not ${to}. Nothing was spent — re-run with --to=${newId} --yes to confirm it.`
                        : `Add --to=${newId} to confirm the replacement (run without --yes first to review it).`,
                );
            return;
        }
        const result = await currencyHandlers()['swap-entry-photo'](null, challengeId, imageId, newId, true);
        reportSpend(result, `Swapped ${imageId} → ${newId} in "${challenge.title}".`);
    } catch (err) {
        logger.withCategory('currency').error(`Failed to swap photo: ${err?.message || err}`);
    }
};

/**
 * Spend a SWAP to put a photo swapped out while boosted/turbo'd back into the
 * slot now holding `imageId` — it gets its boost/turbo back. Only swaps made
 * through this app are known (the API history has no boost flag).
 * Returns false on a usage error (no --image).
 */
const swapBackCmd = async (challengeId, { imageId, yes = false } = {}) => {
    if (!imageId) {
        logger.withCategory('ui').error('Please specify the photo now in the slot with --image=<id>');
        logger.withCategory('ui').info(SWAP_BACK_USAGE);
        return false;
    }
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return true;
    try {
        const list = await currencyHandlers()['get-swap-backs'](null, challengeId);
        const record = (list?.items || []).find((r) => r.currentId === String(imageId));
        if (!record) {
            logger.withCategory('currency').error(`No swap back is recorded for ${imageId} in "${challenge.title}".`);
            return true;
        }
        if (!yes) {
            logger
                .withCategory('currency')
                .info(
                    `Swap back in "${challenge.title}": ${imageId} → ${record.previousId} (gets its ${record.kind} back)`,
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
            `Swapped ${record.previousId} back into "${challenge.title}" — its ${record.kind} is back.`,
        );
    } catch (err) {
        logger.withCategory('currency').error(`Failed to swap back: ${err?.message || err}`);
    }
    return true;
};

/**
 * Spend a FILL to top the challenge's exposure up to 100%.
 */
const fillExposureCmd = async (challengeId, { yes = false } = {}) => {
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return;
    try {
        if (!yes) {
            logger.withCategory('currency').info(`Fill the exposure of "${challenge.title}" to 100%.`);
            await printCost('fills');
            logger
                .withCategory('currency')
                .info(`To spend the fill, re-run: fill-exposure --challenge=${challengeId} --yes`);
            return;
        }
        const result = await currencyHandlers()['fill-exposure'](null, challengeId, true);
        reportSpend(result, `Exposure filled on "${challenge.title}".`);
    } catch (err) {
        logger.withCategory('currency').error(`Failed to fill exposure: ${err?.message || err}`);
    }
};

module.exports = {
    boostChallenge,
    turboChallenge,
    fillChallenge,
    unlockBoostCmd,
    swapCmd,
    parseSwapFlags,
    SWAP_USAGE,
    swapBackCmd,
    SWAP_BACK_USAGE,
    fillExposureCmd,
};
