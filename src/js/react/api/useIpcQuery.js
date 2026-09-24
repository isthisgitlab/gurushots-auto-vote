import { useState, useCallback, useEffect, useRef } from 'react';

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
 * @param {(...args: any[]) => Promise<any>} queryFn
 * @param {{
 *   initialData?: any,
 *   subscribe?: boolean,
 *   singleFlight?: boolean,
 *   clearErrorOnStart?: boolean,
 *   showLoading?: (...args: any[]) => boolean,
 *   apply?: (result: any, tools: { setData: Function, setError: Function }, ...args: any[]) => any,
 * }} [options]
 *   - initialData: initial `data` state (default null)
 *   - subscribe: refetch on window.api.onSettingsChanged (default false)
 *   - singleFlight: drop refetch calls that overlap an in-flight one
 *   - clearErrorOnStart: clear `error` when a refetch starts (default true)
 *   - showLoading: per-call predicate (gets the refetch args) deciding
 *     whether this call toggles `loading`; defaults to always
 *   - apply: custom result application (dedup, derived errors, side
 *     effects); default stores the resolved value as `data`
 * @returns {{ data: any, setData: Function, loading: boolean, error: any, setError: Function, refetch: (...args: any[]) => Promise<void> }}
 */
export function useIpcQuery(queryFn, options = {}) {
    const {
        initialData = null,
        subscribe = false,
        singleFlight = false,
        clearErrorOnStart = true,
        showLoading,
        apply,
    } = options;

    const [data, setData] = useState(initialData);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const inFlightRef = useRef(false);

    const refetch = useCallback(
        async (...args) => {
            if (singleFlight) {
                if (inFlightRef.current) return;
                inFlightRef.current = true;
            }
            const toggleLoading = showLoading ? showLoading(...args) : true;
            if (toggleLoading) setLoading(true);
            if (clearErrorOnStart) setError(null);
            try {
                const result = await queryFn(...args);
                if (apply) {
                    await apply(result, { setData, setError }, ...args);
                } else {
                    setData(result);
                }
            } catch (err) {
                setError(err);
            } finally {
                if (toggleLoading) setLoading(false);
                if (singleFlight) inFlightRef.current = false;
            }
        },
        [queryFn, singleFlight, clearErrorOnStart, showLoading, apply],
    );

    useEffect(() => {
        refetch();
    }, [refetch]);

    useEffect(() => {
        if (!subscribe || !window.api?.onSettingsChanged) return undefined;
        return window.api.onSettingsChanged(() => {
            refetch();
        });
    }, [subscribe, refetch]);

    return { data, setData, loading, error, setError, refetch };
}

/**
 * useIpcQuery for a handler that resolves a `{ success, ... }` envelope: a
 * successful result stores `select(result)` and clears the error; anything
 * else stores and surfaces what `fail(result)` returns. `queryFn`, `select`
 * and `fail` must be referentially stable (module-level) — `refetch` keys on
 * them.
 *
 * @param {(...args: any[]) => Promise<any>} queryFn
 * @param {{
 *   initialData?: any,
 *   select: (result: any) => any,
 *   fail: (result: any) => { data: any, error?: Error },
 * }} options
 * @returns {ReturnType<typeof useIpcQuery>}
 */
export function useIpcResultQuery(queryFn, { initialData = null, select, fail }) {
    const apply = useCallback(
        (result, { setData, setError }) => {
            const next = result?.success ? { data: select(result), error: null } : fail(result);
            setData(next.data);
            setError(next.error ?? null);
        },
        [select, fail],
    );
    return useIpcQuery(queryFn, { initialData, apply });
}
