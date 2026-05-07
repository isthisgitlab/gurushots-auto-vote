/**
 * Auth helpers shared between IPC handlers that need an early-return
 * when the user is not logged in.
 *
 * Intentionally small: only the token-presence check is shared. Each
 * handler keeps its own success-path logging, sanitisation, and error
 * formatting because those are not the same between the turbo and
 * boost flows.
 */

const settings = require('../settings');
const logger = require('../logger');

/**
 * Loads settings and verifies a token is present. On miss, logs a
 * warning under the authentication category and returns an
 * early-return response that the IPC handler can pass straight back
 * to the renderer.
 *
 * @param {string} actionLabel - free-text action identifier used only
 *   in the warning log message (e.g. 'turbo apply', 'boost').
 * @returns {{ ok: true, token: string, settings: object }
 *         | { ok: false, response: { success: false, error: string } }}
 */
const requireAuthToken = (actionLabel) => {
    const userSettings = settings.loadSettings();
    if (!userSettings.token) {
        logger.withCategory('authentication').warning(`❌ No token found for ${actionLabel}`, null);
        return {
            ok: false,
            response: {success: false, error: 'No authentication token found'},
        };
    }
    return {ok: true, token: userSettings.token, settings: userSettings};
};

module.exports = {requireAuthToken};
