/**
 * Process-exit safety net. Electron sometimes lingers after the last
 * window closes — this gives the main process a deterministic
 * timeout-based exit path so a hung handle doesn't keep the app alive.
 */

const logger = require('../logger');

let forceExitTimeout = null;

const ensureExit = (reason) => {
    // Clear any existing timeout to prevent multiple force exits.
    if (forceExitTimeout) {
        clearTimeout(forceExitTimeout);
    }

    logger.withCategory('ui').info(`Ensuring exit after ${reason}...`, null);

    forceExitTimeout = setTimeout(() => {
        logger.withCategory('ui').info(`Force exiting after ${reason}...`, null);
        process.exit(0);
    }, 1000);
};

module.exports = { ensureExit };
