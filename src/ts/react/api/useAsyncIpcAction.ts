import { useState, useCallback, useEffect, useRef } from 'react';
import { errorMessage } from '../../core/errorMessage';
import { checkEffectStatus, effectOutcomeOf, logRendererError, logRendererWarning } from './ipc';

import type { EffectOutcome } from './ipc';

/**
 * Fallback codes for a failed action, used when the handler or the throw carries no text of its own. They are
 * codes, not wording: what the user reads is ipcErrorText's translation of the stored error.
 */
export type IpcActionLabels = { failureMessage?: string; errorMessage?: string };

/**
 * What a caller does once an open change turns out to have been applied: a status check (not the first reply) found the
 * host's record says so. It gets the arguments the change was sent with — not what the caller's form says by then — so the
 * caller finishes exactly what it began (a rename that lands lets the save after it go on under the name that was sent).
 */
export type IpcActionCallbacks<A extends unknown[]> = { onApplied?: (sent: A) => void };

/** The change a run left open: what to ask the host about it, which request it is (never reused), and what it was sent with. */
type OpenChange<A extends unknown[]> = { outcome: EffectOutcome; id: number; sent: A };

/**
 * The state envelope useAsyncIpcAction returns. `run` resolves the handler's
 * own result, or `{ success: false, error }` when the call threw.
 */
export interface AsyncIpcAction<A extends unknown[], R> {
    run: (...args: A) => Promise<R | { success: false; error: string }>;
    loading: boolean;
    error: string | null;
    clearError: () => void;
    /**
     * The change the last run left open: its reply was lost (`{ success: false, unclear: true, requestId }`) or an Android service
     * has it queued (`{ success: true, pending: true, requestId }`). Null once it has a final result, or none was left open.
     * While one is open with its identity, `run` sends nothing (`effect-unresolved`): it is checked first, never sent again.
     */
    outcome: EffectOutcome | null;
    /** Asks the host where the open change stands by its identity. Resolves true when it reached a final result. */
    checkStatus: () => Promise<boolean>;
    /** Gives up on the open change without a result (the user's choice). */
    dismissOutcome: () => void;
}

/**
 * Generic state envelope for an async IPC call from the renderer.
 *
 * Wraps the boilerplate that every IPC action hook would otherwise
 * repeat: setLoading(true), clear prior error, await the call, surface
 * `result.error` when `result.success` is falsy, catch thrown errors,
 * and clear loading in finally. The raw failure detail goes to the log; the stored `error` is shown through
 * ipcErrorText, which words it for the user.
 *
 * @param ipcInvoker - bound window.api method
 * @param labels
 *   - failureMessage: code stored when the IPC returned `{success:false}` without an error string
 *   - errorMessage: code stored when the call threw without a message
 * @param callbacks
 *   - onApplied: called when a status check finds the open change was applied
 */
export function useAsyncIpcAction<A extends unknown[], R extends { success: boolean; error?: string }>(
    ipcInvoker: (...args: A) => Promise<R>,
    labels: IpcActionLabels = {},
    callbacks: IpcActionCallbacks<A> = {},
): AsyncIpcAction<A, R> {
    const { failureMessage = 'action-failed', errorMessage: errorFallback = 'action-error' } = labels;
    // The latest callback, so a check that settles after a re-render still reaches the caller's current state.
    const appliedRef = useRef(callbacks.onApplied);
    appliedRef.current = callbacks.onApplied;
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [outcome, setOutcome] = useState<EffectOutcome | null>(null);
    // The open change as the next run sees it (state lags a render behind). Every open change has an identity of its own: a
    // status reply settles only the change it was asked about, and only while that change is still the open one.
    const openRef = useRef<OpenChange<A> | null>(null);
    const sequence = useRef(0);
    const open = useCallback((next: OpenChange<A> | null) => {
        openRef.current = next;
        setOutcome(next === null ? null : next.outcome);
    }, []);

    const run = useCallback(
        async (...args: A): Promise<R | { success: false; error: string }> => {
            // An open change keeps its identity until it has a final result: the earlier change is checked, not sent again.
            if (openRef.current?.outcome.requestId) return { success: false, error: 'effect-unresolved' };
            setLoading(true);
            setError(null);
            try {
                const result = await ipcInvoker(...args);
                const left = effectOutcomeOf(result);
                open(left === null ? null : { outcome: left, id: ++sequence.current, sent: args });
                if (left !== null) {
                    void logRendererWarning(`IPC action not final: ${left.kind} ${left.requestId}`);
                } else if (!result?.success) {
                    const failure = result?.error || failureMessage;
                    void logRendererWarning(`IPC action failed: ${failure}`);
                    setError(failure);
                }
                return result;
            } catch (err) {
                const message = errorMessage(err) || errorFallback;
                void logRendererError(`IPC action threw: ${message}`);
                setError(message);
                return { success: false, error: message };
            } finally {
                setLoading(false);
            }
        },
        [ipcInvoker, failureMessage, errorFallback, open],
    );

    const clearError = useCallback(() => setError(null), []);

    const checkStatus = useCallback(async (): Promise<boolean> => {
        const held = openRef.current;
        if (held === null) return true;
        const status = await checkEffectStatus(held.outcome);
        // The reply belongs to the change it was asked about: if that change was given up (or replaced by another) or the
        // component is gone, it settles nothing.
        if (!mountedRef.current || openRef.current?.id !== held.id) return false;
        if (!status.settled) {
            open({ ...held, outcome: status.outcome });
            return false;
        }
        open(null);
        if (status.applied) appliedRef.current?.(held.sent);
        else setError(status.error);
        return true;
    }, [open]);

    const dismissOutcome = useCallback(() => open(null), [open]);

    return { run, loading, error, clearError, outcome, checkStatus, dismissOutcome };
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
    const { run, ...rest } = useAsyncIpcAction(ipcInvoker, labels);
    return { [runName]: run, ...rest } as NamedIpcAction<N, A, R>;
}
