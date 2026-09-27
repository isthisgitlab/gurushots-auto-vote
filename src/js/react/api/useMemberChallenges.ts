import { useIpcResultQuery } from './useIpcQuery';

import type { Challenge } from '../../types/gurushots';

const fetchMemberChallenges = () => window.api.getMemberChallenges();
const selectItems = (result: { items: Challenge[] }): Challenge[] => (Array.isArray(result.items) ? result.items : []);
const fetchFailed = (result: { error?: string } | null | undefined): { data: Challenge[]; error: Error } => ({
    data: [],
    error: new Error(result?.error || 'fetch_failed'),
});

/**
 * Fetches the list of un-joined ("open") challenges the member can join, via
 * IPC. Token resolved server-side. `items` is always an array.
 */
export function useMemberChallenges(): {
    items: Challenge[];
    loading: boolean;
    error: Error | null;
    refetch: () => Promise<void>;
} {
    const { data, loading, error, refetch } = useIpcResultQuery(fetchMemberChallenges, {
        initialData: [] as Challenge[],
        select: selectItems,
        fail: fetchFailed,
    });
    return { items: data, loading, error, refetch };
}
