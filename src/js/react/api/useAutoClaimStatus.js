import { useCallback, useEffect } from 'react';
import { useIpcQuery } from './useIpcQuery';

/** @import { WindowApi } from '../../types/ipc' */

/**
 * The auto-claim status the handler reports on success.
 *
 * @typedef {Extract<Awaited<ReturnType<WindowApi['getAutoClaimStatus']>>, { success: true }>} AutoClaimStatus
 */

// Refresh when the voting timer is armed/cleared, including after failed cycles:
// claiming may have run even when the voting step failed.
/**
 * @param {unknown} nextRunAt - refetch key: the armed voting timer
 * @param {unknown} running - refetch key: whether autovote runs
 * @returns {AutoClaimStatus | null}
 */
export function useAutoClaimStatus(nextRunAt, running) {
    const queryFn = useCallback(() => window.api.getAutoClaimStatus(), []);
    const { data, error, refetch } = useIpcQuery(queryFn, { subscribe: true });

    useEffect(() => {
        void refetch();
    }, [nextRunAt, running, refetch]);

    return !error && data?.success ? data : null;
}
