import { useCallback, useEffect } from 'react';
import { useIpcQuery } from './useIpcQuery';

// Refresh when the voting timer is armed/cleared, including after failed cycles:
// claiming may have run even when the voting step failed.
export function useAutoClaimStatus(nextRunAt, running) {
    const queryFn = useCallback(() => window.api.getAutoClaimStatus(), []);
    const { data, error, refetch } = useIpcQuery(queryFn, { subscribe: true });

    useEffect(() => {
        void refetch();
    }, [nextRunAt, running, refetch]);

    return !error && data?.success ? data : null;
}
