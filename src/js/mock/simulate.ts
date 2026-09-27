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
 * @param data - The mock data to return
 * @param delay - Delay in milliseconds (default: 1000)
 * @returns Promise that resolves with the mock data after delay
 */
const simulateApiResponse = <T>(data: T, delay: number = 1000): Promise<T> => {
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve(data);
        }, delay);
    });
};

/**
 * Helper function to simulate API errors
 *
 * @param error - The error object to return
 * @param delay - Delay in milliseconds (default: 500)
 * @returns Promise that rejects with the error after delay
 */
const simulateApiError = (error: unknown, delay: number = 500): Promise<never> => {
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
 * @param spec.name - method name for the "Mock <name>" preamble
 * @param spec.category - preamble logger category (default 'api')
 * @param spec.tokenArg - index of the token in the call args
 * @param spec.debug - extra per-method debug logging (gets the raw args)
 * @param spec.noTokenMessage - authentication error line
 * @param spec.onNoToken - produces the no-token return value
 * @param fn - the method body
 */
const mockMethod = <F extends (...args: never[]) => Promise<unknown>>(
    {
        name,
        category = 'api',
        tokenArg,
        debug,
        noTokenMessage = 'No token provided, returning empty result',
        onNoToken,
    }: {
        name: string;
        category?: string;
        tokenArg: number;
        debug?: (...args: Parameters<F>) => void;
        noTokenMessage?: string;
        onNoToken: (...args: Parameters<F>) => Awaited<ReturnType<F>>;
    },
    fn: (...args: Parameters<F>) => ReturnType<F>,
): F => {
    const method = async (...args: Parameters<F>) => {
        logger.withCategory(category).api(`Mock ${name}`, null);
        if (debug) debug(...args);
        if (!args[tokenArg]) {
            logger.withCategory('authentication').error(noTokenMessage, null);
            return onNoToken(...args);
        }
        return fn(...args);
    };
    // `method` takes F's parameters and resolves F's result; the checker cannot
    // relate that to the generic F itself.
    return method as unknown as F;
};

export { simulateApiResponse, simulateApiError, mockMethod };
