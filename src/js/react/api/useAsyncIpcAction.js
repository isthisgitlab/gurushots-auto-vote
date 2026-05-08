import { useState, useCallback } from 'react';

/**
 * Generic state envelope for an async IPC call from the renderer.
 *
 * Wraps the boilerplate that every IPC action hook would otherwise
 * repeat: setLoading(true), clear prior error, await the call, surface
 * `result.error` when `result.success` is falsy, catch thrown errors,
 * and clear loading in finally.
 *
 * @param {(...args: any[]) => Promise<any>} ipcInvoker - bound window.api method
 * @param {{ failureMessage?: string, errorMessage?: string }} [labels]
 *   - failureMessage: fallback when the IPC returned `{success:false}` without an error string
 *   - errorMessage: fallback when the call threw without a message
 * @returns {{
 *   run: (...args: any[]) => Promise<{success: boolean, error?: string}>,
 *   loading: boolean,
 *   error: string | null,
 *   clearError: () => void,
 * }}
 */
export function useAsyncIpcAction(ipcInvoker, labels = {}) {
    const { failureMessage = 'Action failed', errorMessage = 'Action error' } = labels;

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const run = useCallback(
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
                const message = err.message || errorMessage;
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
