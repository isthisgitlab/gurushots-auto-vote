/**
 * CLI one-shot action commands — the parity of the GUI's per-card
 * buttons (boost / turbo / fill). Each reuses the exact code path the GUI
 * invokes: the index-resolving `applyBoost` from api/boost (honors
 * `boostImageIndex`), and the `play-auto-turbo` / `fill-challenge-now` IPC
 * handlers called with a null event — the same shape the Capacitor bridge
 * uses. All three target a single challenge identified by `--challenge=<id>`;
 * the dispatcher in cli.js enforces that the flag is present.
 */

const logger = require('../../logger');
const settings = require('../../settings');
const { getMiddleware } = require('../../apiFactory');
const { applyBoost } = require('../../api/boost');

// Built lazily on first use so simply requiring this module (e.g. when the
// dispatcher loads it for `help` or `logout`) does not construct the handler
// set or pull in its transitive dependencies.
let _handlers;
const handlers = () => (_handlers ??= require('../../ipc/actions.handlers').buildHandlers());

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
    if (!getMiddleware().isAuthenticated()) {
        logger.withCategory('authentication').error('No authentication token found. Please login first');
        logger.withCategory('ui').info('Run: login');
        return null;
    }
    try {
        const resp = await getMiddleware().getActiveChallenges();
        const challenges = Array.isArray(resp?.challenges) ? resp.challenges : [];
        const challenge = challenges.find((c) => String(c.id) === String(challengeId));
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

        const token = settings.getSetting('token');
        const response = await applyBoost(challenge, token);
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

module.exports = { boostChallenge, turboChallenge, fillChallenge };
