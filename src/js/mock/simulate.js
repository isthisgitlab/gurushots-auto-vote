// @ts-check
/**
 * GuruShots Auto Voter - Mock endpoint scaffolding
 *
 * Latency simulation and the shared preamble + token guard every mock
 * endpoint (mock/endpoints/*) is built from.
 */

import * as logger from '../logger';

/**
 * Helper function to simulate API responses with delays
 *
 * @template T
 * @param {T} data - The mock data to return
 * @param {number} [delay] - Delay in milliseconds (default: 1000)
 * @returns {Promise<T>} - Promise that resolves with the mock data after delay
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
 * @param {unknown} error - The error object to return
 * @param {number} [delay] - Delay in milliseconds (default: 500)
 * @returns {Promise<never>} - Promise that rejects with the error after delay
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
 * The signature `F` comes from the declared type of the const the result is
 * assigned to (each endpoint declares its real counterpart's signature): it
 * types the `debug` and `fn` parameters and holds `onNoToken` to the same
 * resolved shape.
 *
 * @template {(...args: any[]) => Promise<unknown>} F
 * @param {object} spec
 * @param {string} spec.name - method name for the "Mock <name>" preamble
 * @param {string} [spec.category] - preamble logger category (default 'api')
 * @param {number} spec.tokenArg - index of the token in the call args
 * @param {(...args: Parameters<F>) => void} [spec.debug] - extra per-method debug logging (gets the raw args)
 * @param {string} [spec.noTokenMessage] - authentication error line
 * @param {() => Awaited<ReturnType<F>>} spec.onNoToken - produces the no-token return value
 * @param {(...args: Parameters<F>) => ReturnType<F>} fn - the method body
 * @returns {F}
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
    /** @param {Parameters<F>} args */
    const method = async (...args) => {
        logger.withCategory(category).api(`Mock ${name}`, null);
        if (debug) debug(...args);
        if (!args[tokenArg]) {
            logger.withCategory('authentication').error(noTokenMessage, null);
            return onNoToken();
        }
        return fn(...args);
    };
    // `method` takes F's parameters and resolves F's result; the checker cannot
    // relate that to the generic F itself.
    return /** @type {F} */ (/** @type {unknown} */ (method));
};

export { simulateApiResponse, simulateApiError, mockMethod };
