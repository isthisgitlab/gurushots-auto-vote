import { useState, useCallback, useEffect, useRef } from 'react';

/** singleFlight's gate: take the in-flight slot, or report that a call already holds it. */
function claimFlight(inFlightRef) {
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
 * @param {(...args: any[]) => Promise<any>} queryFn
 * @param {{
 *   initialData?: any,
 *   subscribe?: boolean,
 *   singleFlight?: boolean,
 *   clearErrorOnStart?: boolean,
 *   showLoading?: (...args: any[]) => boolean,
 *   apply?: (result: any, tools: { setData: Function, setError: Function }, ...args: any[]) => any,
 *   enabled?: boolean,
 *   latestOnly?: boolean,
 * }} [options]
 *   - initialData: initial `data` state (default null)
 *   - subscribe: refetch on window.api.onSettingsChanged (default false)
 *   - singleFlight: drop refetch calls that overlap an in-flight one
 *   - enabled: run the automatic fetch (and the subscription) only while
 *     true (default true); flipping it back on fetches again
 *   - latestOnly: a call superseded before it settles — by a newer call, or
 *     by the automatic fetch being re-keyed, disabled or unmounted — drops
 *     its outcome (data, error and the loading reset), like a cancelled effect.
 *     Not combinable with singleFlight or showLoading (throws).
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
        enabled = true,
        latestOnly = false,
    } = options;

    // latestOnly drops a superseded call's loading reset, which is only safe
    // when every started call runs and owns its loading toggle: singleFlight
    // can drop the replacement call and showLoading can skip its toggle, and
    // either would leave `loading` stuck on.
    if (latestOnly && (singleFlight || showLoading)) {
        throw new Error('useIpcQuery: latestOnly cannot be combined with singleFlight or showLoading');
    }

    const [data, setData] = useState(initialData);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const inFlightRef = useRef(false);
    const callIdRef = useRef(0);

    const refetch = useCallback(
        async (...args) => {
            if (singleFlight && !claimFlight(inFlightRef)) return;
            const callId = ++callIdRef.current;
            const toggleLoading = showLoading ? showLoading(...args) : true;
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
                if (toggleLoading && !superseded) setLoading(false);
                if (singleFlight) inFlightRef.current = false;
            }
        },
        [queryFn, singleFlight, clearErrorOnStart, showLoading, apply, latestOnly],
    );

    useAutoFetch(refetch, { enabled, subscribe, latestOnly, callIdRef });

    return { data, setData, loading, error, setError, refetch };
}

/**
 * useIpcQuery's automatic fetches: on mount / whenever `refetch` is re-keyed
 * while `enabled`, and on settings-changed when `subscribe` is set. With
 * `latestOnly`, the effect cleanup (re-key, disable, unmount) supersedes the
 * call it started by advancing the shared call id.
 */
function useAutoFetch(refetch, { enabled, subscribe, latestOnly, callIdRef }) {
    useEffect(() => {
        if (!enabled) return undefined;
        refetch();
        if (!latestOnly) return undefined;
        return () => {
            callIdRef.current += 1;
        };
    }, [enabled, latestOnly, refetch, callIdRef]);

    useEffect(() => {
        if (!enabled || !subscribe || !window.api?.onSettingsChanged) return undefined;
        return window.api.onSettingsChanged(() => {
            refetch();
        });
    }, [enabled, subscribe, refetch]);
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
