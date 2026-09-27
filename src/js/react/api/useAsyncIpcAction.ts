import { useState, useCallback } from 'react';

/**
 * Fallback messages for a failed action.
 */
export type IpcActionLabels = { failureMessage?: string; errorMessage?: string };

/**
 * The state envelope useAsyncIpcAction returns. `run` resolves the handler's
 * own result, or `{ success: false, error }` when the call threw.
 */
export interface AsyncIpcAction<A extends unknown[], R> {
    run: (...args: A) => Promise<R | { success: false; error: string }>;
    loading: boolean;
    error: string | null;
    clearError: () => void;
}

/**
 * Generic state envelope for an async IPC call from the renderer.
 *
 * Wraps the boilerplate that every IPC action hook would otherwise
 * repeat: setLoading(true), clear prior error, await the call, surface
 * `result.error` when `result.success` is falsy, catch thrown errors,
 * and clear loading in finally.
 *
 * @param ipcInvoker - bound window.api method
 * @param labels
 *   - failureMessage: fallback when the IPC returned `{success:false}` without an error string
 *   - errorMessage: fallback when the call threw without a message
 */
export function useAsyncIpcAction<A extends unknown[], R extends { success: boolean; error?: string }>(
    ipcInvoker: (...args: A) => Promise<R>,
    labels: IpcActionLabels = {},
): AsyncIpcAction<A, R> {
    const { failureMessage = 'Action failed', errorMessage = 'Action error' } = labels;

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const run = useCallback(
        async (...args: A): Promise<R | { success: false; error: string }> => {
            setLoading(true);
            setError(null);
            try {
                const result = await ipcInvoker(...args);
                if (!result?.success) {
                    setError(result?.error || failureMessage);
                }
                return result;
            } catch (err) {
                const message = (err as { message?: string } | null | undefined)?.message || errorMessage;
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
 */
export type NamedIpcAction<N extends string, A extends unknown[], R> = Record<N, AsyncIpcAction<A, R>['run']> &
    Omit<AsyncIpcAction<A, R>, 'run'>;

/**
 * useAsyncIpcAction with its `run` exposed under a domain name (e.g.
 * `applyBoost`, `fillNow`) — the shape of the single-action IPC hooks.
 *
 * @param runName - key the action's `run` is returned under
 * @param ipcInvoker - bound window.api method
 * @returns `{ [runName]: run, loading, error, clearError }`
 */
export function useNamedIpcAction<
    N extends string,
    A extends unknown[],
    R extends { success: boolean; error?: string },
>(runName: N, ipcInvoker: (...args: A) => Promise<R>, labels?: IpcActionLabels): NamedIpcAction<N, A, R> {
    const { run, loading, error, clearError } = useAsyncIpcAction(ipcInvoker, labels);
    return { [runName]: run, loading, error, clearError } as NamedIpcAction<N, A, R>;
}
