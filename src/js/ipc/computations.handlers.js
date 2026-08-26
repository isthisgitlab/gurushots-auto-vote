/**
 * IPC handlers for read-only, main-side computations the renderer can't run
 * itself because they need the settings facade (services/VotingLogic is
 * renderer-unreachable — it transitively imports node:fs/electron).
 *
 * Currently just get-deadline-actions, which powers the per-card deadline
 * timeline + boost/turbo conflict signal. It takes the challenge object the
 * renderer already holds (from useActiveChallenges) — NOT a challengeId to
 * re-fetch — so one settings change doesn't fan out N full-list network calls.
 * It is strictly read-only: it never calls an apply/mutation path, so it
 * cannot perturb a concurrent voting pass.
 *
 * Registered through registerHandlers() (like every other module) so it
 * inherits the isTrustedSender frame-origin guard; a hand-rolled
 * ipcMain.handle would bypass it while still passing manifest name-parity.
 */

const { registerHandlers } = require('./registerHandlers');
const logger = require('../logger');
const votingLogic = require('../services/VotingLogic');

const buildHandlers = () => ({
    'get-deadline-actions': async (event, challenge) => {
        try {
            if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge)) {
                return { success: false, error: 'invalid challenge' };
            }
            // Defense-in-depth on the renderer-supplied id (used downstream as a
            // per-challenge override lookup key): only a string/number is a valid
            // challenge id. Rejects e.g. an object/array id before it reaches the
            // settings facade.
            const idType = typeof challenge.id;
            if (idType !== 'string' && idType !== 'number') {
                return { success: false, error: 'invalid challenge id' };
            }
            const now = Math.floor(Date.now() / 1000);
            const { actions, boostBlocked } = votingLogic.describeDeadlineActions(challenge, now);
            return { success: true, actions, boostBlocked };
        } catch (error) {
            logger.withCategory('voting').error('Error computing deadline actions:', error);
            return { success: false, error: 'Failed to compute deadline actions' };
        }
    },
});

const register = (ipcMain) => {
    registerHandlers(ipcMain, buildHandlers());
};

module.exports = { register, buildHandlers };
