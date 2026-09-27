import { useCallback } from 'react';
import { useIpcQuery } from '@/api/useIpcQuery';
import * as ipc from '@/api/ipc';

import type { IpcQueryTools } from '@/api/useIpcQuery';

/**
 * A load settled inside the query: its value, or why it failed.
 */
type SessionLoadOutcome<T> = { ok: true; value: T } | { ok: false; reason: unknown };

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
 */
export function useSessionLoad<T>(
    load: () => Promise<T>,
    { enabled, onLoad, failureLog }: { enabled: boolean; onLoad: (value: T) => void; failureLog: string },
): { loading: boolean; loadFailed: boolean } {
    // Settle inside the query so a failure reaches `apply` — which only runs
    // for the current load — and is logged exactly once per failed load.
    const queryFn = useCallback(async (): Promise<SessionLoadOutcome<T>> => {
        try {
            return { ok: true, value: await load() };
        } catch (reason) {
            return { ok: false, reason };
        }
    }, [load]);

    const apply = useCallback(
        async (result: SessionLoadOutcome<T>, { setError }: IpcQueryTools<null, unknown>) => {
            if (result.ok) {
                onLoad(result.value);
                return;
            }
            setError(result.reason ?? new Error(failureLog));
            await ipc.logRendererError(
                `${failureLog}: ${(result.reason as { message?: string } | null | undefined)?.message || result.reason}`,
            );
        },
        [onLoad, failureLog],
    );

    const { loading, error } = useIpcQuery(queryFn, { enabled, latestOnly: true, apply });
    return { loading, loadFailed: error !== null };
}
