import { useCallback } from 'react';
import { useIpcQuery } from '@/api/useIpcQuery';
import * as ipc from '@/api/ipc';

/**
 * A modal's load-on-open over IPC, built on useIpcQuery: `load()` runs while
 * `enabled` holds (again each time it turns back on, or `load` changes
 * identity), and a load superseded by closing, re-keying or unmounting drops
 * its outcome entirely. A successful load hands its value to `onLoad`; a
 * failed one is logged as `<failureLog>: <reason>` and reported through
 * `loadFailed` until the next load starts — the caller's cue to block saving
 * over data it never received.
 *
 * `load` and `onLoad` must be referentially stable (module-level or
 * useCallback) — the query keys on them.
 *
 * @param {() => Promise<any>} load
 * @param {{ enabled: boolean, onLoad: (value: any) => void, failureLog: string }} options
 * @returns {{ loading: boolean, loadFailed: boolean }}
 */
export function useSessionLoad(load, { enabled, onLoad, failureLog }) {
    // Settle inside the query so a failure reaches `apply` — which only runs
    // for the current load — and is logged exactly once per failed load.
    const queryFn = useCallback(async () => {
        try {
            return { ok: true, value: await load() };
        } catch (reason) {
            return { ok: false, reason };
        }
    }, [load]);

    const apply = useCallback(
        async (result, { setError }) => {
            if (result.ok) {
                onLoad(result.value);
                return;
            }
            setError(result.reason ?? new Error(failureLog));
            await ipc.logRendererError(`${failureLog}: ${result.reason?.message || result.reason}`);
        },
        [onLoad, failureLog],
    );

    const { loading, error } = useIpcQuery(queryFn, { enabled, latestOnly: true, apply });
    return { loading, loadFailed: error !== null };
}
