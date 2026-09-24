/**
 * GuruShots Auto Voter - Mock endpoint scaffolding
 *
 * Latency simulation and the shared preamble + token guard every mock
 * endpoint (mock/endpoints/*) is built from.
 */

const logger = require('../logger');

/**
 * Helper function to simulate API responses with delays
 *
 * @param {object} data - The mock data to return
 * @param {number} delay - Delay in milliseconds (default: 1000)
 * @returns {Promise<object>} - Promise that resolves with the mock data after delay
 */
const simulateApiResponse = (data, delay = 1000) => {
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve(data);
        }, delay);
    });
};

/**
 * Helper function to simulate API errors
 *
 * @param {object} error - The error object to return
 * @param {number} delay - Delay in milliseconds (default: 500)
 * @returns {Promise<object>} - Promise that rejects with the error after delay
 */
const simulateApiError = (error, delay = 500) => {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            reject(error);
        }, delay);
    });
};

/**
 * Shared preamble + token guard for the mock API methods. Logs
 * `Mock <name>` on the category's api channel, runs the per-method
 * debug lines, and — when the token argument is missing — emits the
 * standard authentication error log and short-circuits with the
 * method's no-token result. The wrapped `fn` therefore only ever runs
 * with a token present (mock mode accepts any token, including real ones).
 *
 * Contract: onNoToken must RESOLVE with the same shape the method's real
 * counterpart resolves with on failure (real api modules never reject on
 * a missing token — e.g. challenges resolves `{ challenges: [] }`, boost
 * resolves `null`). Callers must behave identically in mock and real
 * mode; tests/mock/no-token-contract.test.js enforces this.
 *
 * @param {object} spec
 * @param {string} spec.name - method name for the "Mock <name>" preamble
 * @param {string} [spec.category] - preamble logger category (default 'api')
 * @param {number} spec.tokenArg - index of the token in the call args
 * @param {Function} [spec.debug] - extra per-method debug logging (gets the raw args)
 * @param {string} [spec.noTokenMessage] - authentication error line
 * @param {Function} spec.onNoToken - produces the no-token return value
 * @param {Function} fn - the method body
 * @returns {(...args: any[]) => Promise<any>}
 */
const mockMethod = (
    {
        name,
        category = 'api',
        tokenArg,
        debug,
        noTokenMessage = 'No token provided, returning empty result',
        onNoToken,
    },
    fn,
) => {
    return async (...args) => {
        logger.withCategory(category).api(`Mock ${name}`, null);
        if (debug) debug(...args);
        if (!args[tokenArg]) {
            logger.withCategory('authentication').error(noTokenMessage, null);
            return onNoToken();
        }
        return fn(...args);
    };
};

module.exports = { simulateApiResponse, simulateApiError, mockMethod };
