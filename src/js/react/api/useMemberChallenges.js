import { useCallback } from 'react';
import { useIpcQuery } from './useIpcQuery';

/**
 * Fetches the list of un-joined ("open") challenges the member can join, via
 * IPC. Token resolved server-side. `items` is always an array.
 *
 * @returns {{ items: Array<object>, loading: boolean, error: Error|null, refetch: function }}
 */
export function useMemberChallenges() {
    const queryFn = useCallback(() => window.api.getMemberChallenges(), []);

    const apply = useCallback((result, { setData, setError }) => {
        if (result?.success) {
            setData(Array.isArray(result.items) ? result.items : []);
            setError(null);
            return;
        }
        setData([]);
        setError(new Error(result?.error || 'fetch_failed'));
    }, []);

    const { data, loading, error, refetch } = useIpcQuery(queryFn, { initialData: [], apply });
    return { items: data, loading, error, refetch };
}
