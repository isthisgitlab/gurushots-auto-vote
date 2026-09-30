import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import type { Dispatch, SetStateAction } from 'react';

/**
 * What an `apply` callback gets to write the query's state with.
 */
export interface IpcQueryTools<D, E> {
    setData: Dispatch<SetStateAction<D>>;
    setError: Dispatch<SetStateAction<E | null>>;
}

/**
 * useIpcQuery's options other than `apply` (see useIpcQuery for what each does).
 */
export interface IpcQueryBaseOptions<D, A extends unknown[]> {
    initialData?: D;
    subscribe?: boolean;
    singleFlight?: boolean;
    clearErrorOnStart?: boolean;
    showLoading?: (...args: A) => boolean;
    enabled?: boolean;
    latestOnly?: boolean;
}

/**
 * A custom result application: gets the resolved value, the state setters and
 * the refetch arguments.
 */
export type IpcQueryApply<R, D, E, A extends unknown[]> = (
    result: R,
    tools: IpcQueryTools<D, E>,
    ...args: A
) => unknown;

/**
 * The state envelope useIpcQuery returns.
 */
export interface IpcQuery<D, E, A extends unknown[]> {
    data: D;
    setData: Dispatch<SetStateAction<D>>;
    loading: boolean;
    error: E | null;
    setError: Dispatch<SetStateAction<E | null>>;
    refetch: (...args: A) => Promise<void>;
}

/**
 * singleFlight's gate: take the in-flight slot, or report that a call already holds it.
 */
function claimFlight(inFlightRef: { current: boolean }): boolean {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    return true;
}

/**
 * Shared envelope for the renderer's "fetch over IPC" hooks: data +
 * loading + error state, a stable `refetch`, an automatic fetch on
 * mount, and an optional re-fetch subscription to settings-changed
 * events. useSettings / useSettingsSchema use the default envelope;
 * useActiveChallenges layers its custom behavior on via the options.
 *
 * `queryFn` (and `apply`, when given) must be referentially stable —
 * pass a module-level function or a useCallback-wrapped one — because
 * `refetch` (and therefore the mount effect) keys on it.
 *
 * Types: without `apply`, `data` is the resolved value or `initialData`;
 * with `apply`, `data` is whatever `apply` stores (typed by its `setData`)
 * and `error` whatever it passes to `setError` (default `Error`). A thrown
 * value is taken as an `Error` — IPC rejections are. `A` is the refetch
 * arguments; the automatic fetches pass none, so every one must be optional.
 */
export function useIpcQuery<R, D = null, E = Error, A extends unknown[] = []>(
    queryFn: (...args: NoInfer<A>) => Promise<R>,
    options?: IpcQueryBaseOptions<D, A> & { apply?: undefined },
): IpcQuery<R | D, E, A>;
export function useIpcQuery<R, D = null, E = Error, A extends unknown[] = []>(
    queryFn: (...args: NoInfer<A>) => Promise<R>,
    options: IpcQueryBaseOptions<D, A> & { apply: IpcQueryApply<R, D, E, A> },
): IpcQuery<D, E, A>;
/**
 * @param options
 *   - initialData: initial `data` state (default null)
 *   - subscribe: refetch on window.api.onSettingsChanged (default false).
 *     These refetches run in the background: they never raise `loading`
 *     (the data already on screen stays up while it revalidates) and skip
 *     `showLoading`; data, error and singleFlight apply as for any call
 *   - singleFlight: drop refetch calls that overlap an in-flight one
 *   - enabled: run the automatic fetch (and the subscription) only while
 *     true (default true); flipping it back on fetches again
 *   - latestOnly: a call superseded before it settles — by a newer call, or
 *     by the automatic fetch being re-keyed, disabled or unmounted — drops
 *     its outcome (data, error and the loading reset), like a cancelled effect;
 *     whichever call settles current clears `loading`, background ones too.
 *     Not combinable with singleFlight or showLoading (throws).
 *   - clearErrorOnStart: clear `error` when a refetch starts (default true)
 *   - showLoading: per-call predicate (gets the refetch args) deciding
 *     whether a mount fetch or manual refetch toggles `loading`; defaults to
 *     always
 *   - apply: custom result application (dedup, derived errors, side
 *     effects); default stores the resolved value as `data`
 */
export function useIpcQuery(
    queryFn: (...args: unknown[]) => Promise<unknown>,
    options: IpcQueryBaseOptions<unknown, unknown[]> & {
        apply?: IpcQueryApply<unknown, unknown, unknown, unknown[]>;
    } = {},
): IpcQuery<unknown, unknown, unknown[]> {
    const {
        initialData = null,
        subscribe = false,
        singleFlight = false,
        clearErrorOnStart = true,
        showLoading,
        apply,
        enabled = true,
        latestOnly = false,
    } = options;

    // latestOnly drops a superseded call's loading reset and leaves clearing
    // `loading` to the call that settles current, which is only safe when every
    // started call runs: singleFlight can drop the replacement call and leave
    // `loading` stuck on. showLoading is refused with it so a latestOnly query
    // has exactly one loading rule.
    if (latestOnly && (singleFlight || showLoading)) {
        throw new Error('useIpcQuery: latestOnly cannot be combined with singleFlight or showLoading');
    }

    const [data, setData] = useState(initialData);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<unknown>(null);
    const inFlightRef = useRef(false);
    const callIdRef = useRef(0);

    // One call of either kind: `background` ones (the settings-changed
    // subscription) never raise `loading`.
    const run = useCallback(
        async (background: boolean, ...args: unknown[]) => {
            if (singleFlight && !claimFlight(inFlightRef)) return;
            const callId = ++callIdRef.current;
            const toggleLoading = !background && (showLoading ? showLoading(...args) : true);
            if (toggleLoading) setLoading(true);
            if (clearErrorOnStart) setError(null);
            let outcome;
            try {
                outcome = { ok: true, result: await queryFn(...args) };
            } catch (err) {
                outcome = { ok: false, err };
            }
            // Judged once, when the query settles: a call that settled current
            // owns its whole outcome, even if a newer one starts during apply.
            const superseded = latestOnly && callId !== callIdRef.current;
            try {
                if (superseded) return;
                if (!outcome.ok) {
                    setError(outcome.err);
                } else if (apply) {
                    await apply(outcome.result, { setData, setError }, ...args);
                } else {
                    setData(outcome.result);
                }
            } catch (err) {
                setError(err);
            } finally {
                // Under latestOnly the call that settles current clears
                // `loading` even when it never raised it: a background call can
                // supersede a foreground one, whose own reset is then dropped.
                if (latestOnly ? !superseded : toggleLoading) setLoading(false);
                if (singleFlight) inFlightRef.current = false;
            }
        },
        [queryFn, singleFlight, clearErrorOnStart, showLoading, apply, latestOnly],
    );

    const refetch = useCallback((...args: unknown[]) => run(false, ...args), [run]);
    const revalidate = useCallback(() => run(true), [run]);

    useAutoFetch(refetch, revalidate, { enabled, subscribe, latestOnly, callIdRef });

    return { data, setData, loading, error, setError, refetch };
}

/**
 * useIpcQuery's automatic fetches: `refetch` on mount / whenever it is re-keyed
 * while `enabled`, and the background `revalidate` on settings-changed when
 * `subscribe` is set. With `latestOnly`, the effect cleanup (re-key, disable,
 * unmount) supersedes the call it started by advancing the shared call id.
 */
function useAutoFetch(
    refetch: () => Promise<void>,
    revalidate: () => Promise<void>,
    {
        enabled,
        subscribe,
        latestOnly,
        callIdRef,
    }: { enabled: boolean; subscribe: boolean; latestOnly: boolean; callIdRef: { current: number } },
) {
    useEffect(() => {
        if (!enabled) return undefined;
        // run() settles every failure into the error state.
        void refetch();
        if (!latestOnly) return undefined;
        return () => {
            callIdRef.current += 1;
        };
    }, [enabled, latestOnly, refetch, callIdRef]);

    useLayoutEffect(() => {
        if (!enabled || !subscribe || !window.api?.onSettingsChanged) return undefined;
        return window.api.onSettingsChanged(() => {
            void revalidate();
        });
    }, [enabled, subscribe, revalidate]);
}

/**
 * useIpcQuery for a handler that resolves a `{ success, ... }` envelope: a
 * successful result stores `select(result)` and clears the error; anything
 * else stores and surfaces what `fail(result)` returns. `queryFn`, `select`
 * and `fail` must be referentially stable (module-level) — `refetch` keys on
 * them.
 *
 * `select` gets the `success: true` arms of the result, `fail` the rest;
 * `data` is what either returns, or `initialData` (default null) before the
 * first result lands.
 */
export function useIpcResultQuery<R extends { success: boolean }, D, I = null, E = Error>(
    queryFn: () => Promise<R>,
    {
        initialData = null as I,
        select,
        fail,
    }: {
        initialData?: I;
        select: (result: Extract<R, { success: true }>) => D;
        fail: (result: Exclude<R, { success: true }>) => { data: D; error?: E };
    },
): IpcQuery<D | I, E, []> {
    const apply = useCallback(
        (result: R, { setData, setError }: IpcQueryTools<D | I, E>) => {
            const next = result?.success
                ? { data: select(result as Extract<R, { success: true }>), error: null }
                : fail(result as Exclude<R, { success: true }>);
            setData(next.data);
            setError(next.error ?? null);
        },
        [select, fail],
    );
    return useIpcQuery(queryFn, { initialData: initialData as D | I, apply });
}
