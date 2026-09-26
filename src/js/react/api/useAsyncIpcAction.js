// @ts-check
import { useState, useCallback } from 'react';

/**
 * Fallback messages for a failed action.
 *
 * @typedef {{ failureMessage?: string, errorMessage?: string }} IpcActionLabels
 */

/**
 * The state envelope useAsyncIpcAction returns. `run` resolves the handler's
 * own result, or `{ success: false, error }` when the call threw.
 *
 * @template {unknown[]} A
 * @template R
 * @typedef {object} AsyncIpcAction
 * @property {(...args: A) => Promise<R | { success: false, error: string }>} run
 * @property {boolean} loading
 * @property {string | null} error
 * @property {() => void} clearError
 */

/**
 * Generic state envelope for an async IPC call from the renderer.
 *
 * Wraps the boilerplate that every IPC action hook would otherwise
 * repeat: setLoading(true), clear prior error, await the call, surface
 * `result.error` when `result.success` is falsy, catch thrown errors,
 * and clear loading in finally.
 *
 * @template {unknown[]} A
 * @template {{ success: boolean, error?: string }} R
 * @param {(...args: A) => Promise<R>} ipcInvoker - bound window.api method
 * @param {IpcActionLabels} [labels]
 *   - failureMessage: fallback when the IPC returned `{success:false}` without an error string
 *   - errorMessage: fallback when the call threw without a message
 * @returns {AsyncIpcAction<A, R>}
 */
export function useAsyncIpcAction(ipcInvoker, labels = {}) {
    const { failureMessage = 'Action failed', errorMessage = 'Action error' } = labels;

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(/** @type {string | null} */ (null));

    const run = useCallback(
        /**
         * @param {A} args
         * @returns {Promise<R | { success: false, error: string }>}
         */
        async (...args) => {
            setLoading(true);
            setError(null);
            try {
                const result = await ipcInvoker(...args);
                if (!result?.success) {
                    setError(result?.error || failureMessage);
                }
                return result;
            } catch (err) {
                const message = /** @type {Error} */ (err).message || errorMessage;
                setError(message);
                return { success: false, error: message };
            } finally {
                setLoading(false);
            }
        },
        [ipcInvoker, failureMessage, errorMessage],
    );

    const clearError = useCallback(() => setError(null), []);

    return { run, loading, error, clearError };
}

/**
 * useAsyncIpcAction's envelope with `run` under the name `N`.
 *
 * @template {string} N
 * @template {unknown[]} A
 * @template R
 * @typedef {Record<N, AsyncIpcAction<A, R>['run']> & Omit<AsyncIpcAction<A, R>, 'run'>} NamedIpcAction
 */

/**
 * useAsyncIpcAction with its `run` exposed under a domain name (e.g.
 * `applyBoost`, `fillNow`) — the shape of the single-action IPC hooks.
 *
 * @template {string} N
 * @template {unknown[]} A
 * @template {{ success: boolean, error?: string }} R
 * @param {N} runName - key the action's `run` is returned under
 * @param {(...args: A) => Promise<R>} ipcInvoker - bound window.api method
 * @param {IpcActionLabels} [labels]
 * @returns {NamedIpcAction<N, A, R>} `{ [runName]: run, loading, error, clearError }`
 */
export function useNamedIpcAction(runName, ipcInvoker, labels) {
    const { run, loading, error, clearError } = useAsyncIpcAction(ipcInvoker, labels);
    return /** @type {NamedIpcAction<N, A, R>} */ ({ [runName]: run, loading, error, clearError });
}
