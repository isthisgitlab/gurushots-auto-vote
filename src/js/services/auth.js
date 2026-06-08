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
            response: { success: false, error: 'No authentication token found' },
        };
    }
    return { ok: true, token: userSettings.token, settings: userSettings };
};

/**
 * Normalize a raw authentication response into a single success/token/error
 * shape, accepting every token key and success indicator GuruShots has been
 * seen to return across versions. This is the one place that knows the wire
 * shape — both BaseMiddleware._login (CLI + GUI) and the authenticate IPC
 * handler call it, so the CLI and GUI agree on what "logged in" means.
 *
 * Success requires an actual token: a bare `success: true` / `status:
 * 'success'` without a token still resolves to a failure (there is nothing to
 * persist), matching the prior handler behaviour.
 *
 * @param {object|null|undefined} response - Raw response from apiStrategy.authenticate.
 * @returns {{ ok: true, token: string, error: null }
 *         | { ok: false, token: null, error: string }}
 */
const extractAuthResult = (response) => {
    if (!response) {
        return { ok: false, token: null, error: 'Authentication failed - no response from server' };
    }
    const token = response.token || response.access_token || response.auth_token || null;
    const looksSuccessful = !!token || response.success === true || response.status === 'success';
    if (looksSuccessful && token) {
        return { ok: true, token, error: null };
    }
    return {
        ok: false,
        token: null,
        error: response.error || response.message || 'Authentication failed - invalid response from server',
    };
};

module.exports = { requireAuthToken, extractAuthResult };
