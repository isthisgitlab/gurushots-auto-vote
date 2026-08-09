/**
 * Small CLI guard helpers shared across commands: the auth gate every
 * networked command starts with, the profile-argument validation the
 * three profile commands repeat, and the --challenge requirement the
 * challenge-scoped action commands share. Each caller keeps its own
 * return shape; only the check + user-facing guidance live here.
 */

const logger = require('../logger');
const { getMiddleware } = require('../apiFactory');

/**
 * True when a token is present. On miss, logs the standard "login first"
 * guidance; the caller decides what to return/exit.
 */
const ensureAuthenticated = () => {
    if (getMiddleware().isAuthenticated()) return true;
    logger.withCategory('authentication').error('No authentication token found. Please login first');
    logger.withCategory('ui').info('Run: login');
    return false;
};

/**
 * Validate the `<name>` (+ optional --challenge=<id>) arguments the profile
 * commands share. Exits the process with usage guidance on any miss;
 * returns the validated profile name otherwise.
 *
 * @param {string} command - e.g. 'save-profile' (used in usage strings)
 * @param {{challengeId: (string|null), rest: string[]}} parsed - extractChallenge() output
 * @param {{needsChallenge?: boolean, challengeHint?: string}} [opts]
 * @returns {string} the profile name
 */
const requireProfileArgs = (command, { challengeId, rest }, { needsChallenge = false, challengeHint = '' } = {}) => {
    const usage = needsChallenge ? `Usage: ${command} "<name>" --challenge=<id>` : `Usage: ${command} "<name>"`;
    if (!rest[0]) {
        logger.withCategory('ui').error('Please specify a profile name');
        logger.withCategory('ui').info(usage);
        process.exit(1);
    }
    if (rest.length > 1) {
        // An unquoted multi-word name splits into several argv tokens —
        // fail loudly rather than acting on the first word.
        logger.withCategory('ui').error(`Unexpected extra arguments: ${rest.slice(1).join(' ')}`);
        logger
            .withCategory('ui')
            .info(
                `Quote profile names containing spaces: ${command} "2-pic tactic"${needsChallenge ? ' --challenge=<id>' : ''}`,
            );
        process.exit(1);
    }
    if (needsChallenge && !challengeId) {
        logger.withCategory('ui').error(challengeHint);
        logger.withCategory('ui').info(usage);
        process.exit(1);
    }
    return rest[0];
};

/**
 * Require the --challenge=<id> argument the challenge-scoped action commands
 * (boost / turbo / fill) share. Exits the process with the command's usage
 * guidance on a miss; returns the challenge id otherwise.
 *
 * @param {{challengeId: (string|null)}} parsed - extractChallenge() output
 * @param {string} usage - the command's usage string
 * @returns {string} the challenge id
 */
const requireChallenge = ({ challengeId }, usage) => {
    if (challengeId == null) {
        logger.withCategory('ui').error('Please specify a challenge');
        logger.withCategory('ui').info(usage);
        process.exit(1);
    }
    return challengeId;
};

module.exports = { ensureAuthenticated, requireProfileArgs, requireChallenge };
